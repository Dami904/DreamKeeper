# KeeperHub API & MCP Integration Notes

This document establishes the verified failure modes, status mappings, and transport semantics for KeeperHub's MCP server and Turnkey execution pipeline before writing client code.

---

## 1. KeeperHub Surfaces & Endpoints

- **MCP Endpoint**: `https://app.keeperhub.com/mcp` (or local/mock equivalent for tests)
- **Supported Transports**: HTTP SSE / JSON-RPC 2.0 via Model Context Protocol (MCP) and REST API
- **Execution Engine**: Turnkey non-custodial enclave signing with automated smart gas estimation and private MEV RPC routing

---

## 2. Request & Response Semantics

### `dryRunWorkflow` (Pre-Flight Simulation)

- **Nature**: Synchronous read-only simulation on an on-chain state fork.
- **2xx Response**:
  - `ok: true`: Simulation succeeded without revert. Returns `projectedStateChange`, `estimatedGasUnits`, and `simulatedLogs`.
  - `ok: false`: Simulation reverted on-chain. Returns `revertReason` (e.g., `TRANSFER_FAILED`, `INSUFFICIENT_ALLOWANCE`, `SLIPPAGE_EXCEEDED`).
- **Safety Guarantee**: State changes are strictly simulated; **zero gas is burned on-chain** and **zero state is persisted**.
- **TTL Constraint**: State is dynamic. Dry-run simulation results expire after **60 seconds** (`dryRunToken` TTL) to prevent stale execution against shifted liquidity.

### `executeWorkflow` (Onchain Execution)

- **Nature**: Asynchronous initiation of on-chain state change via Turnkey enclaves.
- **2xx Response (`200 OK` or `202 Accepted`)**:
  - Contains `runId`, initial `status`, and optionally `txHash` if mined synchronously.
  - **Important**: A 2xx response acknowledges receipt and submission to the mempool/signer. It does **not** guarantee final block inclusion unless status reaches terminal `CONFIRMED`.
- **4xx Response (`400`, `401`, `403`, `422`)**:
  - Terminal failure (`FAILED`). The request was rejected prior to on-chain broadcast (e.g., policy violation, invalid signature, unwhitelisted contract).
- **5xx Response / Network Timeout**:
  - Indeterminate state (**`UNKNOWN`**). The request may or may not have reached KeeperHub or the Turnkey signer. **Must not be blindly retried without an idempotency key.**

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
- **Retry Guarantee**: If a network timeout occurs and `executeWorkflow` is retried with the same `idempotencyKey`, KeeperHub returns the existing `runId` and `txHash` rather than submitting a duplicate transaction.

---

## 5. Circuit Breakers & Rate Limits

- **Rate Limits**:
  - Maximum 30 requests/minute on standard MCP gateway.
  - Retry strategy: Exponential backoff with jitter on `429 Too Many Requests` (initial delay 500ms, max 8000ms, max 3 attempts).
- **Runaway Agent Circuit Breaker**:
  - If 3 consecutive simulations revert OR 2 consecutive calls land in `UNKNOWN` state within a 5-minute window, the local circuit breaker trips to `OPEN`.
  - While `OPEN`, all outbound writes are hard-locked for a 15-minute cooldown period.
