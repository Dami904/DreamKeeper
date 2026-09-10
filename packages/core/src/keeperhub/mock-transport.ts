import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AuditEntry,
  DryRunIntent,
  DryRunResult,
  DryRunToken,
  ExecutionIntent,
  ExecutionResult,
} from "../types/index.js";
import type { KeeperHubTransport } from "./transport.js";
import { ExecutionStateMachine } from "./state-machine.js";
import { InvariantEvaluator } from "../firewall/invariants.js";

export interface MockTransportScenario {
  forceSimulationRevert?: boolean;
  simulationRevertReason?: string;
  forceExecutionTimeout?: boolean;
  forceExecutionRevert?: boolean;
  executionRevertReason?: string;
  simulateLatencyMs?: number;
}

export class MockKeeperHubTransport implements KeeperHubTransport {
  private runs = new Map<string, ExecutionResult>();
  private audits = new Map<string, AuditEntry>();
  private pendingReconciliations = new Map<string, ExecutionResult>();
  private scenario: MockTransportScenario = {};

  constructor(scenario?: MockTransportScenario) {
    if (scenario) {
      this.scenario = scenario;
    }
  }

  public setScenario(scenario: MockTransportScenario): void {
    this.scenario = { ...this.scenario, ...scenario };
  }

  public resetScenarios(): void {
    this.scenario = {};
  }

  public async dryRun(intent: DryRunIntent): Promise<DryRunResult> {
    if (this.scenario.simulateLatencyMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.scenario.simulateLatencyMs),
      );
    }

    // 1. Check for simulated revert
    if (this.scenario.forceSimulationRevert) {
      const reason =
        this.scenario.simulationRevertReason ||
        "TRANSFER_FAILED_INSUFFICIENT_LIQUIDITY";
      return {
        ok: false,
        revertReason: reason,
        error: `Simulation reverted: ${reason}`,
      };
    }

    // 2. Compute deterministic simulated metrics
    const estimatedGasUnits = 65_000n;
    const projectedDelta = -intent.amount; // Outflow

    // 3. Evaluate expected invariants if provided
    if (intent.expectedInvariant) {
      const evalResult = InvariantEvaluator.evaluate(intent.expectedInvariant, {
        estimatedGasUnits,
        actualDelta: projectedDelta,
      });

      if (!evalResult.passed) {
        return {
          ok: false,
          revertReason: evalResult.violations.join("; "),
          error: `Invariant check failed: ${evalResult.violations.join("; ")}`,
        };
      }
    }

    // 4. Issue a valid DryRunToken
    const canonical = JSON.stringify({
      recipient: intent.recipient.toLowerCase(),
      amount: intent.amount.toString(),
      calldata: intent.calldata?.toLowerCase() || "",
      token: intent.token?.toLowerCase() || "",
    });
    const intentHash = createHash("sha256").update(canonical).digest("hex");

    const token: DryRunToken = {
      tokenId: `drt_${randomUUID().slice(0, 12)}`,
      intentHash,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      simulationTrace: {
        estimatedGasUnits,
        projectedDelta,
      },
    };

    return {
      ok: true,
      token,
      estimatedGasUnits,
      projectedDelta,
    };
  }

  public async execute(
    intent: ExecutionIntent,
    _dryRunResult?: DryRunResult,
  ): Promise<ExecutionResult> {
    if (this.scenario.simulateLatencyMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.scenario.simulateLatencyMs),
      );
    }

    // Idempotency check: if this key was already executed, return cached result
    const existing = this.runs.get(intent.idempotencyKey);
    if (existing) {
      return existing;
    }

    // Check for simulated timeout / network drop -> UNKNOWN
    if (this.scenario.forceExecutionTimeout) {
      const runId = `kh_run_${randomUUID().slice(0, 12)}`;
      const classified = ExecutionStateMachine.classifyResponse({
        timedOut: true,
      });

      const unknownResult: ExecutionResult = {
        state: "UNKNOWN",
        idempotencyKey: intent.idempotencyKey,
        runId,
        error: classified.error,
      };

      // Prepare resolution for later reconciliation
      const eventualTxHash = `0x${randomBytes(32).toString("hex")}`;
      this.pendingReconciliations.set(intent.idempotencyKey, {
        state: "CONFIRMED",
        idempotencyKey: intent.idempotencyKey,
        runId,
        txHash: eventualTxHash,
        explorerUrl: `https://sepolia.basescan.org/tx/${eventualTxHash}`,
        confirmedAt: Date.now(),
      });

      this.runs.set(intent.idempotencyKey, unknownResult);
      return unknownResult;
    }

    // Check for simulated onchain revert -> FAILED
    if (this.scenario.forceExecutionRevert) {
      const revertReason =
        this.scenario.executionRevertReason ||
        "CALL_REVERTED_INSUFFICIENT_BALANCE";
      const classified = ExecutionStateMachine.classifyResponse({
        revertReason,
      });

      const failedResult: ExecutionResult = {
        state: "FAILED",
        idempotencyKey: intent.idempotencyKey,
        revertReason,
        error: classified.error,
      };

      this.runs.set(intent.idempotencyKey, failedResult);
      return failedResult;
    }

    // Happy path: deterministic broadcast with valid txHash -> CONFIRMED
    const txHash = `0x${randomBytes(32).toString("hex")}`;
    const runId = `kh_run_${randomUUID().slice(0, 12)}`;
    const classified = ExecutionStateMachine.classifyResponse({ txHash });

    const confirmedResult: ExecutionResult = {
      state: classified.state,
      idempotencyKey: intent.idempotencyKey,
      runId,
      txHash,
      explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
      confirmedAt: Date.now(),
    };

    // Store in runs and audit log
    this.runs.set(intent.idempotencyKey, confirmedResult);
    this.audits.set(runId, {
      runId,
      idempotencyKey: intent.idempotencyKey,
      state: "CONFIRMED",
      timestamp: Date.now(),
      recipient: intent.recipient,
      amount: intent.amount.toString(),
      txHash,
      policyValidationPassed: true,
      dryRunDurationMs: 42,
      executionDurationMs: 185,
    });

    return confirmedResult;
  }

  public async reconcile(idempotencyKey: string): Promise<ExecutionResult> {
    // Check if there is an eventual reconciliation queued
    const resolved = this.pendingReconciliations.get(idempotencyKey);
    if (resolved) {
      this.runs.set(idempotencyKey, resolved);
      this.pendingReconciliations.delete(idempotencyKey);
      return resolved;
    }

    const current = this.runs.get(idempotencyKey);
    if (current) {
      return current;
    }

    return {
      state: "FAILED",
      idempotencyKey,
      error: `No execution found matching idempotency key '${idempotencyKey}'.`,
    };
  }

  public async getAudit(runId: string): Promise<AuditEntry | undefined> {
    return this.audits.get(runId);
  }
}
