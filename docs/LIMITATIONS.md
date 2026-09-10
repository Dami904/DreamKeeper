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

### D. Daydreams Memory Store

- DreamKeeper's local idempotency and circuit breaker states default to in-memory with optional SQLite/JSON file persistence. In stateless serverless environments (e.g., AWS Lambda), an external persistent database (PostgreSQL/Redis) must be configured to survive container destruction.

---

## 3. What Still Breaks or Is Unfinished (Hackathon Candid Disclosure)

- **Dynamic Gas Spikes Above Global Ceiling**: If network gas escalates higher than the user's hard-configured `maxGasPriceGwei`, KeeperHub safely holds the transaction in queue rather than overpaying. If the gas spike persists longer than the agent's task deadline, the task will transition to `TIMED_OUT`.
- **Custom Token Decimals**: Non-standard ERC-20 tokens (e.g., fee-on-transfer tokens, rebase tokens, or tokens with dynamic transfer taxes) require explicit configuration in the firewall policy to avoid false-positive invariant rejections.
