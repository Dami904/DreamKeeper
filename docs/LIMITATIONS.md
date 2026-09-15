# DreamKeeper: System Limitations & Non-Goals

This document states plainly what DreamKeeper explicitly does and does not handle in its current implementation.

---

## 1. What Is Explicitly Handled

- **Deterministic Pre-Flight Invariant Validation**: Mathematical assertions evaluated strictly in TypeScript against state fork simulations before transaction broadcast.
- **Hallucination & Prompt Injection Defense**: Programmatic block on unwhitelisted contract addresses, unapproved function selectors, and spend limits above configured caps.
- **Dry-Run Staleness Prevention**: 60-second Time-To-Live (TTL) tokens on dry-run approvals. Execution is barred on expired simulation passes.
- **3-State Execution Lifecycle**: Strict separation of `CONFIRMED`, `FAILED`, and `UNKNOWN` states, eliminating duplicate transactions caused by premature retry on timeouts.
- **Pre-Request Idempotency Key Persistence**: Local persistence of semantic idempotency keys prior to network dispatch.
- **Local Circuit Breaker**: Halts runaway agent loops when 3 consecutive reverts or 2 consecutive unknown states occur.

---

## 2. Current Architectural Limitations

### A. No Reorg-Depth Tracking

- `OnChainKeeperHubTransport` waits for exactly **1 confirmation** (`viem`'s `confirmations: 1`) before marking a transaction `CONFIRMED` — there is no reorg-depth logic anywhere in this codebase, at any depth. A single-block reorg that evicts the transaction is not detected or rolled back automatically; the only recovery path is `keeperhub_reconcile`, which re-checks the current chain state rather than tracking reorg depth itself. On `LiveKeeperHubTransport`, finality is whatever KeeperHub's own `get_direct_execution_status` reports as `"completed"` — this repo does not independently re-verify block depth there either.

### B. No Cross-Chain or Multi-Step Workflow Support

- DreamKeeper has no bridge logic and no multi-step "workflow" concept of any kind — every action (`keeperhub_dry_run`, `keeperhub_execute`, `keeperhub_check_and_execute`, `keeperhub_protocol_action`, the Tempo hold lifecycle) is a single call to a single KeeperHub tool on a single chain. There is no `PENDING` execution state (`ExecutionState` is strictly `CONFIRMED` / `FAILED` / `UNKNOWN`) and no cross-chain sequencing of any kind. Moving value across chains is out of scope entirely, not a partially-handled edge case.

### D. Idempotency, Circuit Breaker, and Tempo Hold State Default to In-Memory — Opt-In File Persistence Is Available

- By default, `MemoryIdempotencyStore`, `CircuitBreaker`, and `KeeperHubClient.activeTempoHolds` all hold state in process memory only. Passing `persistDir` to `KeeperHubClient`'s constructor now backs all three with plain JSON files in that directory (`idempotency.json`, `circuit-breaker.json`, `tempo-holds.json`) via `FileIdempotencyStore` and a small persistence helper (`packages/core/src/persistence/file-store.ts`) — no new dependency, synchronous `fs` reads/writes, single-process only. This closes "state is lost on restart" for a CLI/demo-scale deployment, but is still not a database: no SQLite, Redis, or PostgreSQL, and not safe for concurrent multi-instance writes (each process must own its own `persistDir`, or writes will race). A real multi-instance or serverless deployment should still implement `IdempotencyStore` (`packages/core/src/keeperhub/idempotency.ts`) against a proper database.

---

## 3. What Still Breaks or Is Unfinished (Hackathon Candid Disclosure)

- **Gas-Price Ceiling Exists Only on the Direct-Signer Fallback, Not the Live KeeperHub Path**: `FirewallPolicy.maxGasPriceGwei` is now enforced by `OnChainKeeperHubTransport.dryRun()` — it reads the current network gas price directly off the RPC (`publicClient.getGasPrice()`) and refuses to issue a token with `GAS_PRICE_EXCEEDS_CEILING` if it's above the configured ceiling. This is honestly partial: `LiveKeeperHubTransport` (the real KeeperHub execution path) has no equivalent check, because KeeperHub reprices gas server-side before this code ever observes a price to compare — the ceiling only applies when `PRIVATE_KEY` is used without a KeeperHub API key. There is also still no `TIMED_OUT` execution state (`ExecutionState` remains strictly `CONFIRMED` / `FAILED` / `UNKNOWN`); a rejected dry-run due to gas price is reported as a normal simulation failure, not a distinct state.
- **Custom Token Decimals**: Non-standard ERC-20 tokens (e.g., fee-on-transfer tokens, rebase tokens, or tokens with dynamic transfer taxes) require explicit configuration in the firewall policy to avoid false-positive invariant rejections.
- **`LiveKeeperHubTransport` Response Parsing Is Best-Effort Beyond the Cases We've Observed**: The real KeeperHub MCP response shape (`content[0].text` embedding JSON, `execution_id`/`get_direct_execution_status` polling) was reverse-engineered from actual live round trips — see `docs/API_NOTES.md`. Both the `"completed"` and `"failed"` terminal shapes are now confirmed for real for `execute_protocol_action` specifically (a real `aave-v3/supply` success and a real insufficient-gas failure, both independently re-checked). The same polling code path is shared by every direct-execution tool, but its terminal shape for `execute_transfer`/`execute_contract_call`/`execute_check_and_execute` specifically reaching `FAILED` via a poll (rather than a synchronous pre-flight rejection) has not been separately observed — re-verify before relying on it if that distinction matters to your integration.
- **Protocol Actions Are Chain-Scoped Only When `params.network` Is Present**: `validateProtocolAction()` now cross-checks `params.network` against `FirewallPolicy.network`'s chain id (via `SUPPORTED_NETWORK_CHAIN_IDS`) and blocks an explicit mismatch with `PROTOCOL_ACTION_NETWORK_MISMATCH`. This is a soft check, not a hard guarantee: if `params.network` is absent or not a string, nothing blocks it here — that case is left to KeeperHub itself to reject. An agent that omits `network` entirely (rather than supplying a mismatched one) is not caught by this check.
- **Not Every `search_protocol_actions` Result Works with `execute_protocol_action`**: some discoverable actionTypes (e.g. `web3/read-contract`, `math/format-number`) are workflow-only and return `501 Not Implemented` on direct execution. There is no field distinguishing this in the search results — you find out by calling it. This includes every `tempo/*` protocol action (`transfer-with-memo`, `batch-payout`, `dex-swap`, `hold-payment`) — none of them support direct execution; the standalone `tempo_sign_and_hold`/`tempo_release_hold`/`tempo_cancel_hold` tools DreamKeeper actually integrates are a separate, non-workflow-gated tool family.
- **Tempo Hold Tracking Defaults to In-Memory, Same as Idempotency/Circuit Breaker Above**: `KeeperHubClient.activeTempoHolds` (the map guarding `keeperhub_tempo_release_hold`/`keeperhub_tempo_cancel_hold` against a hallucinated `paymentId`) survives a restart when the client is constructed with `persistDir` (see section 2.D) — without it, a process restart forgets every hold this client created, and a genuinely-held payment from before the restart can no longer be released or canceled through this process (KeeperHub itself still holds it; only this repo's tracking is lost).
- **Tempo Amount Cap Bookkeeping Is Fixed-Point, Not the Token's Real On-Chain Decimals**: Unlike the EVM transfer/contract-call path (bigint atomic units matching the token's own decimals), Tempo's tools take human-readable decimal amount strings directly. `validateTempoHold()`/`recordTempoSpend()` now parse these via `parseTempoAmountMicros()` straight to a `bigint` at 6-decimal fixed-point precision (no `Number.parseFloat`, no float accumulation drift across the rolling 24h spend history) — but 6 decimals is a cap-enforcement convenience, not the token's actual on-chain decimal precision, so this remains unsuitable for exact-precision financial accounting beyond spend-limit gating.
- **Tempo Mainnet Is Out of Scope**: only `tempo-testnet` (chainId `42431`) has been exercised and verified. `allowedTempoNetworks` can technically include `tempo-mainnet`, but doing so is unverified and not recommended.
