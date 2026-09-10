import type {
  AuditEntry,
  DryRunIntent,
  DryRunResult,
  ExecutionIntent,
  ExecutionResult,
} from "../types/index.js";

export interface KeeperHubTransport {
  /**
   * Performs an on-chain state fork simulation
   */
  dryRun(intent: DryRunIntent): Promise<DryRunResult>;

  /**
   * Deterministically broadcasts an authorized workflow
   */
  execute(
    intent: ExecutionIntent,
    dryRunResult?: DryRunResult,
  ): Promise<ExecutionResult>;

  /**
   * Reconciles the true on-chain state of an UNKNOWN or pending idempotency key
   */
  reconcile(idempotencyKey: string): Promise<ExecutionResult>;

  /**
   * Retrieves an immutable cryptographic audit record
   */
  getAudit(runId: string): Promise<AuditEntry | undefined>;
}
