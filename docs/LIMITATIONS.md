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

### A. L2 Reorganization Depth

- DreamKeeper checks receipt confirmations against standard RPC endpoints.
- On Optimistic Rollups (e.g., Base, Arbitrum), soft confirmations occur within ~1-2 seconds, but final settlement on Ethereum L1 takes longer. DreamKeeper models a transaction as `CONFIRMED` upon inclusion in a mined L2 block. Reorgs deeper than 2 blocks on the L2 sequencer are not automatically rolled back by the client.

### B. Multi-Hop Cross-Chain Atomicity

- Multi-step workflows on a single chain are verified via dry-run simulation.
- However, cross-chain workflows (e.g., bridge from Base to Arbitrum) are executed as sequential checkpoints rather than single-block atomic transactions. If a bridge provider experiences delays, DreamKeeper tracks the status as `PENDING` until arrival confirmation, but cannot force an on-chain rollback of the source chain burn/lock.

### C. Off-Chain Oracle Discrepancy

- Invariant evaluation relies on KeeperHub's simulation node state fork. If an off-chain price feed or decentralized oracle updates between the simulation block and the private mempool inclusion block, minor slippage variance can occur within the configured `maxSlippageBps`.

### D. Idempotency & Circuit Breaker State Is In-Memory Only

- The shipped `MemoryIdempotencyStore` and `CircuitBreaker` hold all state in process memory — there is no built-in SQLite, JSON-file, Redis, or PostgreSQL persistence in this codebase today. Restarting the process (or, in a serverless environment like AWS Lambda, losing the container) resets the idempotency table and circuit breaker to a clean slate, discarding in-flight `UNKNOWN` executions and any tripped/`OPEN` state. Implement the `IdempotencyStore` interface (`packages/core/src/keeperhub/idempotency.ts`) against a real database before running this in a multi-instance or serverless deployment.

---

## 3. What Still Breaks or Is Unfinished (Hackathon Candid Disclosure)

- **No Gas-Price Ceiling Config Today**: There is currently no `maxGasPriceGwei` (or equivalent) setting in `FirewallPolicy`, and no `TIMED_OUT` execution state — `ExecutionState` is strictly `CONFIRMED` / `FAILED` / `UNKNOWN`. Gas-spike handling is left entirely to whichever transport is active (KeeperHub's own smart gas repricing on the live path, or `viem`'s defaults on the direct-signer fallback); DreamKeeper's own code does not yet hold or queue a transaction pending a gas ceiling.
- **Custom Token Decimals**: Non-standard ERC-20 tokens (e.g., fee-on-transfer tokens, rebase tokens, or tokens with dynamic transfer taxes) require explicit configuration in the firewall policy to avoid false-positive invariant rejections.
- **`LiveKeeperHubTransport` Response Parsing Is Best-Effort Beyond the Cases We've Observed**: The real KeeperHub MCP response shape (`content[0].text` embedding JSON, `execution_id`/`get_direct_execution_status` polling) was reverse-engineered from an actual live simulate/execute/status round trip — see `docs/API_NOTES.md`. Field names for cases we haven't triggered ourselves (e.g., the exact terminal shape of a `failed` `get_direct_execution_status` response) are still best-effort guesses and should be re-verified against a real failure before being relied on.
- **Protocol Actions Are Not Chain-Scoped by the Firewall**: `execute_protocol_action`'s `params.network` is passed through to KeeperHub as-is; `FirewallPolicy.network` does not currently cross-check it. Only `actionType` is whitelisted (`allowedProtocolActions`) — a compromised or hallucinating agent that passes an approved `actionType` with an unexpected `network` in `params` will not be blocked by chain mismatch alone.
- **Not Every `search_protocol_actions` Result Works with `execute_protocol_action`**: some discoverable actionTypes (e.g. `web3/read-contract`, `math/format-number`) are workflow-only and return `501 Not Implemented` on direct execution. There is no field distinguishing this in the search results — you find out by calling it. This includes every `tempo/*` protocol action (`transfer-with-memo`, `batch-payout`, `dex-swap`, `hold-payment`) — none of them support direct execution; the standalone `tempo_sign_and_hold`/`tempo_release_hold`/`tempo_cancel_hold` tools DreamKeeper actually integrates are a separate, non-workflow-gated tool family.
- **Tempo Hold Tracking Is In-Memory Only**: `KeeperHubClient.activeTempoHolds` (the map guarding `keeperhub_tempo_release_hold`/`keeperhub_tempo_cancel_hold` against a hallucinated `paymentId`) lives in process memory, same caveat class as the idempotency store and circuit breaker above — a process restart forgets every hold this client created, and a genuinely-held payment from before the restart can no longer be released or canceled through this process (KeeperHub itself still holds it; only this repo's tracking is lost).
- **Tempo Amount Caps Use Floats, Not Atomic Units**: Unlike the EVM transfer/contract-call path (bigint atomic units), Tempo's tools take human-readable decimal amount strings directly. `FirewallPolicy.maxTempoAmountPerHold`/`maxTempoCumulativeDailySpend` compare via `Number.parseFloat`, so they inherit ordinary floating-point precision limits — fine for typical stablecoin demo amounts, but not appropriate for exact-precision financial enforcement at scale.
- **Tempo Mainnet Is Out of Scope**: only `tempo-testnet` (chainId `42431`) has been exercised and verified. `allowedTempoNetworks` can technically include `tempo-mainnet`, but doing so is unverified and not recommended.
