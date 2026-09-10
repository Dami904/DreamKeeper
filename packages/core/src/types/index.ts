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
  /** Maximum allowable price slippage in basis points (e.g. 50 = 0.5%) */
  maxSlippageBps?: number | undefined;
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
}

/**
 * Dry-run intent submitted by the agent
 */
export interface DryRunIntent {
  recipient: string;
  amount: bigint;
  calldata?: string | undefined;
  method?: string | undefined;
  token?: string | undefined; // ERC20 token address or "NATIVE"
  expectedInvariant?: ExpectedInvariant | undefined;
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
  calldata?: string | undefined;
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
  calldata: z.string().optional(),
});

export const ReconcileActionSchema = z.object({
  idempotencyKey: z.string().min(8),
});

export const AuditActionSchema = z.object({
  runId: z.string().min(1),
});
