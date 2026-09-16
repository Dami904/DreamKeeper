import { z } from "zod";

/**
 * Supported networks
 */
export type SupportedNetwork =
  | "base-mainnet"
  | "base-sepolia"
  | "ethereum-mainnet"
  | "ethereum-sepolia"
  | "arbitrum-one"
  | "arbitrum-sepolia";

/**
 * KeeperHub MCP `chain_id` values, keyed by DreamKeeper's SupportedNetwork
 * policy setting. Single source of truth shared by LiveKeeperHubTransport
 * (building chain_id for its own calls) and FirewallValidator (cross-checking
 * a protocol action's params.network against the configured policy network).
 */
export const SUPPORTED_NETWORK_CHAIN_IDS: Record<SupportedNetwork, string> = {
  "ethereum-mainnet": "1",
  "base-mainnet": "8453",
  "base-sepolia": "84532",
  "ethereum-sepolia": "11155111",
  "arbitrum-one": "42161",
  "arbitrum-sepolia": "421614",
};

/**
 * Strict 3-state lifecycle for financial operations
 */
export type ExecutionState = "CONFIRMED" | "FAILED" | "UNKNOWN";

/**
 * Circuit breaker states
 */
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/**
 * Expected post-condition invariants verified against simulation
 */
export interface ExpectedInvariant {
  /** Maximum acceptable token/gas outflow in atomic units */
  maxBalanceLoss?: bigint | undefined;
  /** Minimum acceptable token inflow in atomic units */
  minTokensReceived?: bigint | undefined;
  /** Maximum acceptable gas units */
  maxGasUnits?: bigint | undefined;
}

/**
 * Security Firewall Policy rules
 */
export interface FirewallPolicy {
  network: SupportedNetwork;
  /** Maximum allowed amount per single transaction (in atomic units, e.g. wei) */
  maxAmountPerTx: bigint;
  /** Maximum cumulative spend allowed within a 24-hour rolling window */
  maxCumulativeDailySpend: bigint;
  /** Whitelist of approved recipient/contract addresses (lowercase 0x...) */
  allowedRecipients: string[];
  /** Optional whitelist of approved 4-byte function selectors or names */
  allowedMethods?: string[] | undefined;
  /** Enforce that execution cannot proceed without a valid unexpired dry-run */
  requireSimulationSuccess: boolean;
  /** Maximum age of a dry-run token in milliseconds (defaults to 60,000 ms) */
  dryRunTtlMs?: number | undefined;
  /**
   * Default-deny whitelist of exact KeeperHub protocol actionType strings
   * (e.g. "aave-v3/supply"), gating execute_protocol_action. There is no
   * recipient/amount to check for these — the actionType itself is the only
   * thing to whitelist, since execute_protocol_action has no simulate mode
   * to catch a bad call before it signs and broadcasts.
   */
  allowedProtocolActions?: string[] | undefined;
  /**
   * Default-deny whitelist of Tempo network strings (e.g. "tempo-testnet")
   * that keeperhub_tempo_sign_and_hold is allowed to target. Independent of
   * `network` above, which scopes only the primary EVM transfer/contract-call
   * path — a policy can allow Tempo holds alongside an unrelated EVM network.
   */
  allowedTempoNetworks?: string[] | undefined;
  /** Default-deny whitelist of Tempo stablecoin contract addresses (lowercase 0x...) */
  allowedTempoTokens?: string[] | undefined;
  /**
   * Maximum decimal amount (in the held token's own human-readable units,
   * e.g. "25.5" pathUSD) allowed per single Tempo hold. Default-deny if
   * unset — unlike maxAmountPerTx, there is no existing "unlimited by
   * default" precedent for this brand-new value system.
   */
  maxTempoAmountPerHold?: number | undefined;
  /**
   * Maximum cumulative decimal amount allowed across Tempo holds within a
   * 24-hour rolling window. Tracked separately from maxCumulativeDailySpend
   * because Tempo amounts are decimal strings in the held token's own units,
   * not atomic bigint units of a single EVM policy token.
   */
  maxTempoCumulativeDailySpend?: number | undefined;
  /**
   * Maximum acceptable network gas price, in gwei, before a dry-run refuses
   * to issue an execution token. Enforced only on the direct-signer fallback
   * (`OnChainKeeperHubTransport`), where DreamKeeper reads gas price directly
   * off the RPC before broadcasting — the live KeeperHub execution path
   * reprices gas server-side before this code ever observes it, so this
   * field has no effect there. Undefined means no ceiling is enforced.
   */
  maxGasPriceGwei?: number | undefined;
  /**
   * Number of block confirmations `OnChainKeeperHubTransport` waits for
   * before marking a transaction `CONFIRMED`. Undefined defaults to 1,
   * matching prior behavior. Raising this narrows the window in which a
   * reorg could still evict an already-`CONFIRMED` transaction — it does
   * NOT add reorg detection or rollback; nothing watches a transaction
   * after it clears this many confirmations. Only affects the direct-signer
   * fallback; the live KeeperHub execution path's finality is whatever
   * `get_direct_execution_status` reports, independent of this field.
   */
  requiredConfirmations?: number | undefined;
}

/**
 * Dry-run intent submitted by the agent
 *
 * `functionArgs` presence turns this into a contract-call-shaped intent
 * (KeeperHub's `execute_contract_call`) instead of a plain transfer
 * (`execute_transfer`) — `recipient` becomes the contract address, `amount`
 * becomes the native `value` sent with the call (0n for non-payable calls),
 * and `method` (already used for the firewall's method whitelist) doubles
 * as the function name passed to KeeperHub.
 */
export interface DryRunIntent {
  recipient: string;
  amount: bigint;
  calldata?: string | undefined;
  method?: string | undefined;
  token?: string | undefined; // ERC20 token address or "NATIVE"
  expectedInvariant?: ExpectedInvariant | undefined;
  functionArgs?: string | undefined; // JSON array string, e.g. '["0x...", "1000"]'
  abi?: string | undefined; // JSON ABI string; auto-fetched by KeeperHub if omitted
}

/**
 * Cryptographically bound token issued upon successful dry-run simulation
 */
export interface DryRunToken {
  tokenId: string;
  intentHash: string;
  issuedAt: number;
  expiresAt: number;
  simulationTrace: {
    estimatedGasUnits: bigint;
    projectedDelta: bigint;
  };
}

/**
 * Dry-run simulation result
 */
export interface DryRunResult {
  ok: boolean;
  token?: DryRunToken;
  error?: string;
  estimatedGasUnits?: bigint;
  projectedDelta?: bigint;
  revertReason?: string;
}

/**
 * Execution intent passed to broadcast
 */
export interface ExecutionIntent {
  idempotencyKey: string;
  dryRunTokenId: string;
  recipient: string;
  amount: bigint;
  token?: string | undefined;
  calldata?: string | undefined;
  method?: string | undefined;
  functionArgs?: string | undefined;
  abi?: string | undefined;
}

/**
 * A read call whose single scalar return value is compared against a
 * condition before the paired action runs (KeeperHub's
 * `execute_check_and_execute`).
 */
export interface CheckAndExecuteCall {
  contractAddress: string;
  functionName: string;
  functionArgs?: string | undefined; // JSON array string
  abi?: string | undefined;
}

export interface CheckAndExecuteCondition {
  operator: "eq" | "neq" | "gt" | "lt" | "gte" | "lte";
  value: string; // BigInt-compatible decimal or hex string
}

export interface CheckAndExecuteAction extends CheckAndExecuteCall {
  /** Native value sent with the action call, in atomic units (0n for non-payable). */
  value?: bigint | undefined;
}

/**
 * Atomic "read a value, then act only if a condition holds" intent — the
 * check is read-only and never gated by the firewall; only the action's
 * contractAddress/functionName go through allowedRecipients/allowedMethods,
 * matching a plain contract call's firewall treatment.
 */
export interface CheckAndExecuteIntent {
  check: CheckAndExecuteCall;
  condition: CheckAndExecuteCondition;
  action: CheckAndExecuteAction;
  expectedInvariant?: ExpectedInvariant | undefined;
}

export interface CheckAndExecuteExecutionIntent extends CheckAndExecuteIntent {
  idempotencyKey: string;
  dryRunTokenId: string;
}

/**
 * A pre-built KeeperHub DeFi protocol action (e.g. "aave-v3/supply"),
 * KeeperHub's own curated abstraction over raw contract calls. Has no
 * simulate/dry-run mode — signs and broadcasts immediately — so it is
 * gated only by the actionType whitelist, not by a firewall re-check after
 * simulation the way transfers/contract calls/check-and-execute are.
 */
export interface ProtocolActionIntent {
  idempotencyKey: string;
  actionType: string;
  params: Record<string, unknown>;
}

/**
 * KeeperHub's own server-side daily direct-execution spending caps, a second
 * enforcement layer independent of this repo's local FirewallPolicy. A
 * `undefined` dailyCapWei/dailySolanaCapLamports means the org has not set
 * its own cap — NOT that spending is unlimited. `effectiveDailyCapWei`/
 * `effectiveDailySolanaCapLamports` are what KeeperHub actually enforces
 * (the org's own cap if set, otherwise the platform default).
 */
export interface SpendingLimits {
  dailyCapWei: bigint | undefined;
  dailyUsedWei: bigint;
  dailySolanaCapLamports: bigint | undefined;
  dailySolanaUsedLamports: bigint;
  effectiveDailyCapWei: bigint;
  effectiveDailySolanaCapLamports: bigint;
  usingDefaultDailyCap: boolean;
  usingDefaultDailySolanaCap: boolean;
}

/**
 * A request to sign a Tempo stablecoin payment and hold it for later
 * broadcast (keeperhub_tempo_sign_and_hold). `amount` is a human-readable
 * decimal string in the token's own units (e.g. "1.50"), not atomic bigint
 * units — Tempo's tools take decimal amounts directly, unlike the EVM
 * transfer/contract-call path elsewhere in this repo.
 */
export interface TempoHoldIntent {
  idempotencyKey: string;
  /** Tempo network string, e.g. "tempo-testnet" — validated against FirewallPolicy.allowedTempoNetworks */
  network: string;
  tokenAddress: string;
  tokenSymbol: string;
  amount: string;
  recipient: string;
  memo?: string | undefined;
  broadcastMode?: "manual" | "schedule" | undefined;
  broadcastAt?: string | undefined;
  validBefore?: string | undefined;
}

/**
 * Result of a sign-and-hold call. Distinct from ExecutionResult's 3-state
 * model because nothing has broadcast yet — `paymentId` is the handle used
 * later with keeperhub_tempo_release_hold/keeperhub_tempo_cancel_hold.
 */
export interface TempoHoldResult {
  ok: boolean;
  paymentId?: string | undefined;
  precomputedHash?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  amount?: string | undefined;
  memo?: string | undefined;
  broadcastMode?: string | undefined;
  broadcastAt?: string | undefined;
  validBefore?: number | undefined;
  status?: string | undefined;
  chainId?: number | undefined;
  error?: string | undefined;
  revertReason?: string | undefined;
}

/** Result of a cancel call — nothing broadcasts, so no 3-state model applies. */
export interface TempoCancelResult {
  ok: boolean;
  status?: string | undefined;
  error?: string | undefined;
}

/**
 * Execution result with 3-state confirmation
 */
export interface ExecutionResult {
  state: ExecutionState;
  idempotencyKey: string;
  runId?: string | undefined;
  txHash?: string | undefined;
  explorerUrl?: string | undefined;
  error?: string | undefined;
  revertReason?: string | undefined;
  confirmedAt?: number | undefined;
  /**
   * Present only for read-type protocol actions (e.g. an oracle price read
   * via execute_protocol_action) that complete synchronously with a value
   * but no on-chain broadcast — there is no txHash because nothing was
   * written to the chain.
   */
  resultValue?: string | undefined;
}

/**
 * Audit trail entry
 */
export interface AuditEntry {
  runId: string;
  idempotencyKey: string;
  state: ExecutionState;
  timestamp: number;
  recipient: string;
  amount: string;
  txHash?: string | undefined;
  policyValidationPassed: boolean;
  dryRunDurationMs?: number | undefined;
  executionDurationMs?: number | undefined;
}

/**
 * KeeperHub Transport Configuration
 */
export interface KeeperHubConfig {
  mode: "mock" | "live";
  endpoint?: string | undefined;
  apiKey?: string | undefined;
  privateKey?: string | undefined;
  rpcUrl?: string | undefined;
  policy: FirewallPolicy;
  logger?:
    | {
        level?: "debug" | "info" | "warn" | "error" | undefined;
      }
    | undefined;
}

/**
 * Zod Schemas for Daydreams Action parameters
 */
export const DryRunActionSchema = z.object({
  recipient: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid 20-byte Ethereum address"),
  amount: z
    .string()
    .regex(/^\d+$/, "Amount must be an integer string in atomic units (wei)"),
  calldata: z
    .string()
    .regex(/^0x([a-fA-F0-9]{2})*$/, "Calldata must be 0x-prefixed hex string")
    .optional(),
  method: z.string().optional(),
  token: z.string().optional(),
  maxBalanceLoss: z.string().optional(),
  minTokensReceived: z.string().optional(),
  maxGasUnits: z.string().optional(),
  functionArgs: z.string().optional(),
  abi: z.string().optional(),
});

export const ExecuteActionSchema = z.object({
  idempotencyKey: z
    .string()
    .min(8, "Idempotency key must be at least 8 characters"),
  dryRunTokenId: z
    .string()
    .min(1, "dryRunTokenId is required from a previous dry-run"),
  recipient: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid 20-byte Ethereum address"),
  amount: z
    .string()
    .regex(/^\d+$/, "Amount must be an integer string in atomic units (wei)"),
  token: z.string().optional(),
  calldata: z.string().optional(),
  method: z.string().optional(),
  functionArgs: z.string().optional(),
  abi: z.string().optional(),
});

const CheckAndExecuteFields = {
  checkContractAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid 20-byte Ethereum address"),
  checkFunctionName: z.string().min(1),
  checkFunctionArgs: z.string().optional(),
  checkAbi: z.string().optional(),
  operator: z.enum(["eq", "neq", "gt", "lt", "gte", "lte"]),
  conditionValue: z
    .string()
    .regex(
      /^(0x[a-fA-F0-9]+|\d+)$/,
      "conditionValue must be a decimal or 0x-hex integer string",
    ),
  actionContractAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid 20-byte Ethereum address"),
  actionFunctionName: z.string().min(1),
  actionFunctionArgs: z.string().optional(),
  actionAbi: z.string().optional(),
  actionValue: z
    .string()
    .regex(/^\d+$/, "actionValue must be an integer string in atomic units")
    .optional(),
  maxBalanceLoss: z.string().optional(),
  minTokensReceived: z.string().optional(),
  maxGasUnits: z.string().optional(),
};

export const CheckAndExecuteDryRunActionSchema = z.object(
  CheckAndExecuteFields,
);

export const CheckAndExecuteExecuteActionSchema = z.object({
  ...CheckAndExecuteFields,
  idempotencyKey: z
    .string()
    .min(8, "Idempotency key must be at least 8 characters"),
  dryRunTokenId: z
    .string()
    .min(
      1,
      "dryRunTokenId is required from a previous check-and-execute dry-run",
    ),
});

export const ProtocolActionSchema = z.object({
  idempotencyKey: z
    .string()
    .min(8, "Idempotency key must be at least 8 characters"),
  actionType: z
    .string()
    .regex(
      /^[a-z0-9-]+\/[a-z0-9-]+$/i,
      "actionType must be in 'protocol/action-slug' format, e.g. 'aave-v3/supply'",
    ),
  paramsJson: z
    .string()
    .describe(
      'Action parameters as a JSON object string, e.g. \'{"network":"84532","amount":"1000000"}\'',
    ),
});

export const ReconcileActionSchema = z.object({
  idempotencyKey: z.string().min(8),
});

export const AuditActionSchema = z.object({
  runId: z.string().min(1),
});

export const GetSpendingLimitsActionSchema = z.object({});

export const GetTrustSummaryActionSchema = z.object({});

export const TempoSignAndHoldActionSchema = z.object({
  idempotencyKey: z
    .string()
    .min(8, "Idempotency key must be at least 8 characters"),
  network: z.string().describe('Tempo network, e.g. "tempo-testnet"'),
  tokenAddress: z
    .string()
    .describe(
      "Tempo stablecoin contract address, e.g. pathUSD's 0x20c0...0000",
    ),
  tokenSymbol: z.string().describe('Token symbol, e.g. "pathUSD"'),
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount in the token\'s own units, e.g. "1.50"',
    ),
  recipient: z.string().describe("Recipient address"),
  memo: z.string().optional(),
  broadcastMode: z.enum(["manual", "schedule"]).optional(),
  broadcastAt: z.string().optional(),
  validBefore: z.string().optional(),
});

export const TempoReleaseHoldActionSchema = z.object({
  paymentId: z
    .string()
    .min(
      1,
      "paymentId is required from a previous keeperhub_tempo_sign_and_hold call",
    ),
  idempotencyKey: z.string().min(8).optional(),
});

export const TempoCancelHoldActionSchema = z.object({
  paymentId: z
    .string()
    .min(
      1,
      "paymentId is required from a previous keeperhub_tempo_sign_and_hold call",
    ),
});
