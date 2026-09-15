import type {
  AuditEntry,
  CheckAndExecuteExecutionIntent,
  CheckAndExecuteIntent,
  DryRunIntent,
  DryRunResult,
  ExecutionIntent,
  ExecutionResult,
  ProtocolActionIntent,
  SpendingLimits,
  TempoCancelResult,
  TempoHoldIntent,
  TempoHoldResult,
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

  /**
   * Simulates an atomic "read a value, act only if a condition holds" intent
   */
  checkAndExecuteDryRun(intent: CheckAndExecuteIntent): Promise<DryRunResult>;

  /**
   * Broadcasts an approved check-and-execute intent
   */
  checkAndExecuteExecute(
    intent: CheckAndExecuteExecutionIntent,
  ): Promise<ExecutionResult>;

  /**
   * Broadcasts a pre-built KeeperHub protocol action (e.g. "aave-v3/supply").
   * No simulate/dry-run mode exists for this — it signs and broadcasts
   * immediately.
   */
  executeProtocolAction(intent: ProtocolActionIntent): Promise<ExecutionResult>;

  /**
   * Reads KeeperHub's own server-side daily spending caps and current usage
   * — a second enforcement layer independent of this repo's local
   * FirewallPolicy. Only meaningful on the real KeeperHub path; mock/on-chain
   * transports have no such concept and return a static "no cap" shape.
   */
  getSpendingLimits(): Promise<SpendingLimits | undefined>;

  /**
   * Signs a Tempo stablecoin payment and holds it for later broadcast.
   * Produces a real (but unbroadcast) signed artifact — analogous to
   * dryRun(), but on KeeperHub's own Tempo network rather than a simulation.
   */
  tempoSignAndHold(intent: TempoHoldIntent): Promise<TempoHoldResult>;

  /**
   * Broadcasts a previously-created Tempo hold. This is the value-moving
   * step, analogous to execute().
   */
  tempoReleaseHold(
    paymentId: string,
    idempotencyKey?: string,
  ): Promise<ExecutionResult>;

  /**
   * Cancels a previously-created Tempo hold so it is never broadcast.
   */
  tempoCancelHold(paymentId: string): Promise<TempoCancelResult>;
}
