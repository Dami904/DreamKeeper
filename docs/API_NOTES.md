# KeeperHub API & MCP Integration Notes

This document records the **verified** request/response shape of KeeperHub's real MCP server, confirmed by actually calling it from `LiveKeeperHubTransport` (`packages/core/src/keeperhub/live-transport.ts`) against `https://app.keeperhub.com/mcp` with a live org API key and wallet integration, plus a real confirmed Base Sepolia transaction. An earlier version of this document described a guessed API shape (`dryRunWorkflow`/`executeWorkflow` as two endpoints returning clean JSON) that turned out not to match reality; this version reflects what was actually observed.

---

## 1. KeeperHub Surfaces & Endpoints

- **MCP Endpoint**: `https://app.keeperhub.com/mcp` — implements the MCP **Streamable HTTP** transport. A `tools/call` request **requires** a prior `initialize` handshake; the server returns an `Mcp-Session-Id` response header that must be echoed on every subsequent request, or every call fails with `"Session not initialized"`.
- **Auth**: `Authorization: Bearer <KEEPERHUB_API_KEY>` (an org API key from the KeeperHub dashboard, `kh_...`). This is unrelated to any Daydreams/Claude MCP OAuth session.
- **Signer**: Execution is signed and routed by KeeperHub's own infrastructure via whichever **wallet integration** is configured on the org (`list_integrations` in KeeperHub's own MCP tools shows this). The `to_address`/`amount` you pass are the transfer parameters; the sending wallet is **not** something you specify per-call — it's resolved from the org's configured integration. A confirmed live transaction we captured broadcast as an EIP-7702 (`type: 0x4`) transaction routed through an executor contract, not a plain EOA-signed transfer — consistent with, but not itself definitive proof of, KeeperHub's "Turnkey enclave" and "smart execution" claims.

---

## 2. Request & Response Semantics (verified against the real API)

### `execute_transfer` — the one tool used for both simulate and broadcast

There is no separate "dry-run" endpoint. `execute_transfer` is called twice with the same arguments: once with `simulate: true` (no signing, no broadcast), then again with `simulate` omitted or `false` (signs and broadcasts for real).

**Request arguments** (JSON-RPC `tools/call`, `params.arguments`):

```json
{
  "chain_id": "84532",
  "to_address": "0x...",
  "amount": "1.0",
  "token_address": "0x...",
  "simulate": true,
  "idempotency_key": "..."
}
```

- `amount` is a **human-readable decimal string** (e.g., `"1.0"` for 1 token), not an atomic-unit integer string.
- `token_address` is required for ERC-20 transfers. **Omitting it sends the native token instead** — this was a real bug in an earlier version of `live-transport.ts` that never forwarded it.
- `idempotency_key` is only meaningful on the non-simulate call.

**Response shape** — this is the part that was wrong before. The result is **not** a flat JSON object. It's the standard MCP tool-response envelope:

```json
{
  "result": {
    "isError": false,
    "content": [
      { "type": "text", "text": "<JSON blob>, optionally followed by prose>" }
    ]
  }
}
```

`content[0].text` contains a JSON object (`success`, `wouldRevert`, `revertReason`, `error`, `from`, `to`, `value`, `execution_id`, ...) that must be extracted from the surrounding text — on a failure it is prefixed with human-readable text like `"API call failed: 400 Bad Request - {...}"` followed by remediation prose after the JSON. `result.isError` flags a tool-level failure (a revert, a validation error) distinct from a JSON-RPC transport error.

- **Simulate success**: `success: true`, `wouldRevert: false`. Treat anything else as a simulation failure.
- **Broadcast success**: the response contains an `execution_id` — **not** a final `txHash`. The transaction is not yet confirmed at this point.

### `get_direct_execution_status` — required polling step after a real broadcast

A successful (non-simulate) `execute_transfer` call only returns an `execution_id`; it does not itself confirm the transaction. Call `get_direct_execution_status` with that `execution_id` and poll with bounded backoff:

- `status` is one of `pending`, `running`, `unconfirmed`, `completed`, `failed`. **Only `completed` and `failed` are terminal.**
- `unconfirmed` means broadcast but not yet mined — keep polling, **never re-send** (KeeperHub's own docs are explicit that re-sending an unconfirmed execution can double-spend).
- On `completed`, the response's `transactionLink` is the on-chain proof (BaseScan URL); a `transactionHash`/`txHash` field may also be present.

### Auth / error responses

A bad or missing API key does **not** produce a flat `{"error": "invalid_token"}` — an earlier version of this doc and of `live-transport.ts` assumed this shape and never observed a real failure. What we've verified: an invalid/empty key still gets past `initialize` in some cases and fails later with a `"Missing or invalid API key"`-style message inside the tool response; a fully absent/malformed key can also produce an HTTP 401/403 on `initialize` itself. Treat both as auth failures.

### Rate limits — not independently verified

The previous version of this document stated "Maximum 30 requests/minute" as a fact. **This number was never actually tested against KeeperHub and should not be relied on.** We only observed rate-limiting on a free-tier _LLM_ provider (unrelated to KeeperHub) during agent testing. If KeeperHub's actual rate limit matters to your integration, verify it directly rather than trusting this document.

---

## 3. The 3-State Execution Model

All workflow executions must be classified into one of three explicit states:

```
                  ┌───────────────┐
                  │    REQUEST    │
                  └───────┬───────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
   │  CONFIRMED  │ │   FAILED    │ │   UNKNOWN   │
   │  Positive   │ │  Positive   │ │ Indeterm-   │
   │  proof of   │ │  proof of   │ │ inate: net- │
   │  inclusion  │ │  reversion  │ │ work drop,  │
   │  (txHash)   │ │  or reject  │ │ 5xx timeout │
   └─────────────┘ └─────────────┘ └──────┬──────┘
                                          │
                                          ▼
                                   ┌─────────────┐
                                   │  RECONCILE  │
                                   │  Poll via   │
                                   │ idempotency │
                                   │     key     │
                                   └─────────────┘
```

1. **`CONFIRMED`**:
   - We possess cryptographic proof of execution: a mined `txHash`, valid block number, and confirmed receipt.
2. **`FAILED`**:
   - We possess proof the transaction definitely did _not_ move value: simulation revert, 4xx pre-flight rejection, or on-chain transaction receipt with status `0` (reverted).
3. **`UNKNOWN`**:
   - Connection dropped, request timed out, or HTTP 5xx.
   - **Resolution**: Stored in the local idempotency table. The agent or daemon invokes `reconcile()` using the pre-generated `idempotencyKey` to discover whether the run was created and broadcast.

---

## 4. Idempotency Key Semantics

- **Generation Rule**: The idempotency key must be generated and persisted **locally before the network request is fired**.
- **Scope**: Idempotency is **semantic**, not merely HTTP transport level. The key binds:
  - `sender`: The Daydreams agent address / identifier.
  - `recipient`: The target contract or address.
  - `amount`: Token or native quantity.
  - `actionPayloadHash`: SHA-256 hash of the normalized calldata and parameters.
- **Retry Guarantee**: If a network timeout occurs and the execute call is retried with the same `idempotencyKey`, KeeperHub returns the existing `execution_id`/`txHash` rather than submitting a duplicate transaction. (`live-transport.ts` also tracks `idempotencyKey → execution_id` locally, so `keeperhub_reconcile` can resume polling `get_direct_execution_status` for an in-flight or previously-`UNKNOWN` execution without needing to call `execute_transfer` again.)

---

## 5. Circuit Breaker (`packages/core/src/firewall/circuit-breaker.ts`)

This is DreamKeeper's own local logic, not a KeeperHub server-side feature — describing exactly what's implemented, no more:

- Trips to `OPEN` after **3 consecutive failures** or **2 consecutive `UNKNOWN` results** (both configurable, no default time window — these are pure consecutive counts, reset to zero on any success).
- While `OPEN`, `isExecutionAllowed()` returns `false` and all writes are blocked.
- After a **15-minute cooldown** (`cooldownMs`, configurable) elapses, it moves to `HALF_OPEN`: the next call is a trial — one more failure or `UNKNOWN` immediately re-trips it, a success returns it to `CLOSED`.
- There is no built-in HTTP retry/backoff strategy in this class or in `live-transport.ts` beyond the bounded status-polling loop described in Section 2. KeeperHub's own server-side rate limits are not independently verified — see Section 2.
