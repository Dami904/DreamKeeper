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

- `amount` is a **human-readable decimal string** (e.g., `"1.0"` for 1 token), not an atomic-unit integer string — always in the transferred asset's own units, not a fixed 6-decimal convention.
- `token_address` is required for ERC-20 transfers. **Omitting it sends the native token instead** — this was a real bug in an earlier version of `live-transport.ts` that never forwarded it.
- `idempotency_key` is only meaningful on the non-simulate call.
- **Real bug found live, since fixed**: `buildTransferOrCallRequest()` unconditionally divided `intent.amount` (atomic-unit `bigint`) by `1e6` to build this human-readable string — correct for USDC (6 decimals), the only ERC-20 this codebase transfers, but wrong for a native-ETH transfer (18 decimals, no `token`). A real dry-run of `900_000_000_000_000n` wei (0.0009 ETH) was sent as `"900000000"` and correctly rejected by KeeperHub: `"Insufficient BASE balance. Have: 0.001, Need: 900000000.0..."` — off by exactly `1e12`. Every prior live test in this project happened to use USDC, so the native-ETH path was never previously exercised. Fixed to divide by `1e18` when `token` is unset, `1e6` when it's set.

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

### `execute_check_and_execute` — different response fields than execute_transfer/execute_contract_call

Verified directly against the real API for both outcomes. There is **no top-level `wouldRevert`** for a "condition not met" result — an earlier version of `live-transport.ts` assumed the same `success`/`wouldRevert` shape as `execute_transfer` and silently treated an unmet condition as success:

- **Condition not met**: `{"success": true, "status": "simulated", "executed": false, "conditionResult": {"met": false, "observedValue": "...", "targetValue": "...", "operator": "..."}}`. `success:true` only means the API call itself worked — it says nothing about whether the condition held.
- **Condition met (action simulated)**: adds `from`, `to`, `value`, `gasEstimate`, `simulatedReturnValue`, `wouldRevert`, and `executed: true` alongside `conditionResult.met: true`.

Treat `executed !== true || conditionResult.met !== true` as "nothing would run" — not as a hard error, but not as success either.

### `execute_protocol_action` — no simulate mode; not every discoverable actionType is directly executable

Verified directly: `search_protocol_actions` returns many actionTypes (`web3/read-contract`, `math/format-number`, `data/flatten-findings`, etc.) that are **workflow-only** — calling them via `execute_protocol_action` returns `501 Not Implemented`: `{"error": "Direct execution not supported for \"<actionType>\". Use workflow execution instead."}`. Only a subset (the actual protocol integrations, e.g. `aave-v3/*`, `chronicle/*`, `pyth/*`) support direct execution. There's no field in `search_protocol_actions`' output that flags this distinction — you find out by calling `execute_protocol_action` and checking for a 501.

Real error shapes observed (both correctly handled by treating `parsed.error` as the message regardless of HTTP status):

- Non-2xx with an embedded JSON error: `"API call failed: 400 Bad Request - {\"success\":false,\"error\":\"...\"}"`
- A plain 200 with `success:false` embedded directly: `{"success": false, "destinationError": true, "error": "...", "errorClass": "user"}`

**Read-type actions verified**: a **read** action (e.g. `chronicle/eth-usd-read`) succeeds synchronously with `{"success": true, "result": "2478150000000000000000", "addressLink": "https://etherscan.io/address/0x46ef..."}` — there is no `execution_id` at all, because nothing is broadcast to the chain. This was initially mishandled: the code assumed every success carries an `execution_id` to poll, so a real synchronous-read success was misclassified as `UNKNOWN`. Fixed to check for `parsed.result` when no `execution_id` is present, returning `state: "CONFIRMED"` immediately with the value in `ExecutionResult.resultValue` (no `txHash`, since nothing was written to the chain).

**Write-action FAILED path verified**: a real `aave-v3/supply` call on Ethereum Sepolia (network `11155111`, the real deployed Aave V3 Sepolia market's USDC reserve `0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8`) passed pre-flight validation — the asset/network were recognized as a real deployment, unlike every earlier attempt that failed before that point — and returned synchronously: `{"executionId": "...", "status": "failed", "error": "Insufficient ETH balance. Have: 0.0, Need: 0.000054893096496. Fund <address> with at least 0.000054893096496 ETH on this chain and retry."}`. Polling `get_direct_execution_status` with that `executionId` confirmed the exact FAILED shape `live-transport.ts` already expects: `{"executionId", "status": "failed", "transactionHash": null, "error": "..."}` → correctly mapped to `state: "FAILED"`.

**Write-action CONFIRMED path verified**: after funding the wallet with real Base Sepolia USDC (Aave's own faucet-specific reserve, distinct from Circle's canonical testnet USDC — see below) and a plain `approve()` — [`0xad3cddf93a30e6a7a9406cb5cc7c39780c7c103baa1652f3282a5e3319c7ca64`](https://sepolia.basescan.org/tx/0xad3cddf93a30e6a7a9406cb5cc7c39780c7c103baa1652f3282a5e3319c7ca64) — via `execute_contract_call`, a real `aave-v3/supply` call (network `84532`, asset `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`) returned synchronously already terminal:

```json
{
  "executionId": "fheqlub3rse3drqsa8qs2",
  "status": "completed",
  "transactionHash": "0x3171a1724c0574d9946fe2a4d79cd547da6b1e8c239a09fa9e754cb947620b59",
  "transactionLink": "https://sepolia.basescan.org/tx/0x3171a1724c0574d9946fe2a4d79cd547da6b1e8c239a09fa9e754cb947620b59"
}
```

Real tx: [`0x3171a1724c0574d9946fe2a4d79cd547da6b1e8c239a09fa9e754cb947620b59`](https://sepolia.basescan.org/tx/0x3171a1724c0574d9946fe2a4d79cd547da6b1e8c239a09fa9e754cb947620b59). Polling `get_direct_execution_status` with that `executionId` confirmed the identical shape `live-transport.ts` already expects (`status: "completed"` → `state: "CONFIRMED"`, `transactionHash`/`transactionLink` populated), plus extra fields not otherwise used: `receipts[].receiptStatus: "success"`, `result.sponsored: true` (KeeperHub paid gas), and `result.executedCall` (decoded function name/args/target). Independently re-verified via `eth_getTransactionReceipt` directly against `sepolia.base.org`: `status: "0x1"`, 7 logs (ERC-20 transfer, aToken mint, Aave `Supply` event, etc.). This closes the `execute_protocol_action` write-path verification gap entirely — both FAILED and CONFIRMED shapes now have real observed evidence, not just an assumed pattern.

Note on funding: Aave's Base Sepolia market uses its **own isolated faucet-only USDC** (`0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`), separate from Circle's canonical Base Sepolia testnet USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) used elsewhere in this project — the two are not interchangeable, and supplying to Aave requires the Aave-specific token, obtained from Aave's own faucet UI (`https://bridge-testnet.aave.com/faucet`). That token's `mint()` function (both `mint(uint256)` and `mint(address,uint256)` overloads) is `Ownable`-restricted on this deployment, so it is not itself a public/scriptable faucet.

Also note: `execute_protocol_action`'s `params` object carries its own `network` field — DreamKeeper's firewall does **not** cross-check this against `FirewallPolicy.network`, so a protocol action's target chain is not currently policy-gated, only its `actionType` is.

### `get_spending_limits` — read-only, org-level daily cap

Verified directly against the real tool with a fully-scoped API key. Response (`content[0].text`, JSON):

```json
{
  "dailyCapWei": null,
  "dailyUsedWei": "0",
  "dailySolanaCapLamports": null,
  "dailySolanaUsedLamports": "0",
  "effectiveDailyCapWei": "20000000000000000",
  "effectiveDailySolanaCapLamports": "500000000",
  "usingDefaultDailyCap": true,
  "usingDefaultDailySolanaCap": true
}
```

`dailyCapWei`/`dailySolanaCapLamports` are `null` when the organization hasn't set its own explicit cap — `effectiveDailyCapWei`/`effectiveDailySolanaCapLamports` are what's actually enforced in that case (a KeeperHub-side default; here `0.02 ETH` and `0.5 SOL`), and `usingDefaultDailyCap`/`usingDefaultDailySolanaCap` are `true` to indicate the effective value came from the default rather than an org-configured one. Takes no parameters. Our session's own OAuth-scoped `mcp__keeperhub__*` tools returned 401 for this call (evidently a privileged/write-scoped tool despite being read-only); DreamKeeper's own `.env` `KEEPERHUB_API_KEY` has the required scope.

### `tempo_sign_and_hold` / `tempo_release_hold` / `tempo_cancel_hold` — a second network, real value moved and independently verified

KeeperHub also exposes a Tempo network (a stablecoin-payments EVM chain — `tempo-testnet` chainId `42431`, `tempo-mainnet` chainId `4217`, both `status: "stable"` per `list_action_schemas`). Its own `tempo/*` `execute_protocol_action` entries (`transfer-with-memo`, `batch-payout`, `dex-swap`, `hold-payment`) are **all workflow-only** — every one returned `501 Not Implemented` when called directly, the same class of restriction documented above for `execute_protocol_action`. But the **standalone** `tempo_sign_and_hold`/`tempo_release_hold`/`tempo_cancel_hold` tools are directly executable outside the workflow system, and DreamKeeper integrates them directly (not through `execute_protocol_action`).

Verified real response shapes, using DreamKeeper's own `.env` `KEEPERHUB_API_KEY` (session-scoped `mcp:read mcp:write mcp:admin`) and free testnet funds from Tempo's public faucet (`POST https://tempo.xyz/developers/api/faucet` with `{"address": "<wallet>"}`, distributing pathUSD/AlphaUSD/BetaUSD/ThetaUSD test stablecoins at `0x20c0...0000`–`...0003`):

`tempo_sign_and_hold` success:

```json
{
  "success": true,
  "paymentId": "7dmo4g9y1a0x3sj2ynx01",
  "precomputedHash": "0xc17284a1bae8fbb9e89e058b73f257647ea1c69910a1e5abe819f5568c2bb190",
  "from": "0x9219AB851CD5Fea9Bf65B9ABF0De929315185D76",
  "to": "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF",
  "amount": "1",
  "memo": "0x...",
  "broadcastMode": "manual",
  "validBefore": 1789548818,
  "status": "pending",
  "chainId": 42431
}
```

`tokenConfig` must be sent as a **JSON-stringified object** — `{"mode":"custom","customToken":{"address":"0x...","symbol":"..."}}` — not a bare token symbol string; passing `"USDC"` directly fails with `{"error":"A token is required"}`. `memo` is plain-text-limited to **31 bytes or fewer** (or a `0x` + 64-hex bytes32 value); a longer plain-text memo fails with `{"error":"Memo \"...\" is too long: a plain-text memo must be 31 bytes or fewer, or pass a 0x + 64-hex bytes32 value."}`. An unsupported `network` string fails with `{"error":"Unsupported network: <value>. Supported: mainnet, eth-mainnet, ..., tempo-testnet, tempo, tempo-mainnet, ..."}`.

`tempo_release_hold` success (synchronous — no `execution_id`/polling, unlike the EVM direct-execution tools):

```json
{
  "ok": true,
  "status": "confirmed",
  "transactionHash": "0xc17284a1bae8fbb9e89e058b73f257647ea1c69910a1e5abe819f5568c2bb190"
}
```

`tempo_cancel_hold` success:

```json
{ "ok": true, "status": "canceled" }
```

Independently verified: the `transactionHash` above was checked directly against Tempo's public RPC (`https://rpc.moderato.tempo.xyz`, `eth_getTransactionReceipt`) — `status: "0x1"`, a real ERC20 `Transfer` event log moving 1 pathUSD from the KeeperHub wallet to the test recipient, at a real block number. Both a full hold→cancel cycle and a full hold→release cycle were run for real during development.

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
- **Scope**: Idempotency is **semantic**, not merely HTTP transport level. `generateSemanticIdempotencyKey()` (`packages/core/src/keeperhub/idempotency.ts`) hashes `sender` (agent identifier, defaults to `"default-agent"`), `recipient`, `amount`, and `calldata` into a 16-hex-char prefix, then appends an 8-char random nonce (`dk_<hashPrefix>_<nonce>`) — the nonce means the _key itself_ must be reused by the caller across retries, not regenerated from scratch each time. Separately, `IdempotencyRecord.actionPayloadHash` (populated via `computeIntentHash()` when `savePreRequest()` is called) stores a fuller intent hash alongside the record for tamper-detection auditing — it is not itself part of the key.
- **Retry Guarantee**: If a network timeout occurs and the execute call is retried with the same `idempotencyKey`, KeeperHub returns the existing `execution_id`/`txHash` rather than submitting a duplicate transaction. (`live-transport.ts` also tracks `idempotencyKey → execution_id` locally, so `keeperhub_reconcile` can resume polling `get_direct_execution_status` for an in-flight or previously-`UNKNOWN` execution without needing to call `execute_transfer` again.)

---

## 5. Circuit Breaker (`packages/core/src/firewall/circuit-breaker.ts`)

This is DreamKeeper's own local logic, not a KeeperHub server-side feature — describing exactly what's implemented, no more:

- Trips to `OPEN` after **3 consecutive failures** or **2 consecutive `UNKNOWN` results** (both configurable, no default time window — these are pure consecutive counts, reset to zero on any success).
- While `OPEN`, `isExecutionAllowed()` returns `false` and all writes are blocked.
- After a **15-minute cooldown** (`cooldownMs`, configurable) elapses, it moves to `HALF_OPEN`: the next call is a trial — one more failure or `UNKNOWN` immediately re-trips it, a success returns it to `CLOSED`.
- There is no built-in HTTP retry/backoff strategy in this class or in `live-transport.ts` beyond the bounded status-polling loop described in Section 2. KeeperHub's own server-side rate limits are not independently verified — see Section 2.
