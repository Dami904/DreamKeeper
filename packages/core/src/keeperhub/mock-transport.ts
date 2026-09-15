import { randomBytes, randomUUID } from "node:crypto";
import type {
  AuditEntry,
  CheckAndExecuteExecutionIntent,
  CheckAndExecuteIntent,
  DryRunIntent,
  DryRunResult,
  DryRunToken,
  ExecutionIntent,
  ExecutionResult,
  ProtocolActionIntent,
  SpendingLimits,
  TempoCancelResult,
  TempoHoldIntent,
  TempoHoldResult,
} from "../types/index.js";
import type { KeeperHubTransport } from "./transport.js";
import { ExecutionStateMachine } from "./state-machine.js";
import { InvariantEvaluator } from "../firewall/invariants.js";
import {
  computeCheckAndExecuteIntentHash,
  computeIntentHash,
} from "../firewall/validator.js";

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
  private tempoHolds = new Map<
    string,
    { recipient: string; amount: string; network: string; tokenAddress: string }
  >();
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
    const intentHash = computeIntentHash(intent);

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
    return this.mockBroadcast(
      intent.idempotencyKey,
      intent.recipient,
      intent.amount,
    );
  }

  /**
   * Shared happy-path/scenario-toggle broadcast logic, used by both execute()
   * and checkAndExecuteExecute() so they exercise identical idempotency,
   * timeout, and revert behavior.
   */
  private async mockBroadcast(
    idempotencyKey: string,
    recipient: string,
    amount: bigint,
  ): Promise<ExecutionResult> {
    if (this.scenario.simulateLatencyMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.scenario.simulateLatencyMs),
      );
    }

    // Idempotency check: if this key was already executed, return cached result
    const existing = this.runs.get(idempotencyKey);
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
        idempotencyKey,
        runId,
        error: classified.error,
      };

      // Prepare resolution for later reconciliation
      const eventualTxHash = `0x${randomBytes(32).toString("hex")}`;
      this.pendingReconciliations.set(idempotencyKey, {
        state: "CONFIRMED",
        idempotencyKey,
        runId,
        txHash: eventualTxHash,
        explorerUrl: `https://sepolia.basescan.org/tx/${eventualTxHash}`,
        confirmedAt: Date.now(),
      });

      this.runs.set(idempotencyKey, unknownResult);
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
        idempotencyKey,
        revertReason,
        error: classified.error,
      };

      this.runs.set(idempotencyKey, failedResult);
      return failedResult;
    }

    // Happy path: deterministic broadcast with valid txHash -> CONFIRMED
    const txHash = `0x${randomBytes(32).toString("hex")}`;
    const runId = `kh_run_${randomUUID().slice(0, 12)}`;
    const classified = ExecutionStateMachine.classifyResponse({ txHash });

    const confirmedResult: ExecutionResult = {
      state: classified.state,
      idempotencyKey,
      runId,
      txHash,
      explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
      confirmedAt: Date.now(),
    };

    // Store in runs and audit log
    this.runs.set(idempotencyKey, confirmedResult);
    this.audits.set(runId, {
      runId,
      idempotencyKey,
      state: "CONFIRMED",
      timestamp: Date.now(),
      recipient,
      amount: amount.toString(),
      txHash,
      policyValidationPassed: true,
      dryRunDurationMs: 42,
      executionDurationMs: 185,
    });

    return confirmedResult;
  }

  public async checkAndExecuteDryRun(
    intent: CheckAndExecuteIntent,
  ): Promise<DryRunResult> {
    if (this.scenario.simulateLatencyMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.scenario.simulateLatencyMs),
      );
    }

    if (this.scenario.forceSimulationRevert) {
      const reason =
        this.scenario.simulationRevertReason || "CHECK_CONDITION_NOT_MET";
      return {
        ok: false,
        revertReason: reason,
        error: `Simulation reverted: ${reason}`,
      };
    }

    const estimatedGasUnits = 65_000n;
    const projectedDelta = -(intent.action.value ?? 0n);

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

    const intentHash = computeCheckAndExecuteIntentHash(intent);
    const token: DryRunToken = {
      tokenId: `drt_${randomUUID().slice(0, 12)}`,
      intentHash,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      simulationTrace: { estimatedGasUnits, projectedDelta },
    };

    return { ok: true, token, estimatedGasUnits, projectedDelta };
  }

  public async checkAndExecuteExecute(
    intent: CheckAndExecuteExecutionIntent,
  ): Promise<ExecutionResult> {
    return this.mockBroadcast(
      intent.idempotencyKey,
      intent.action.contractAddress,
      intent.action.value ?? 0n,
    );
  }

  public async executeProtocolAction(
    intent: ProtocolActionIntent,
  ): Promise<ExecutionResult> {
    // No recipient/amount concept for a protocol action; actionType stands
    // in as the audit record's "recipient" for this generic broadcast path.
    return this.mockBroadcast(intent.idempotencyKey, intent.actionType, 0n);
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

  public async getSpendingLimits(): Promise<SpendingLimits | undefined> {
    // No org-level cap concept exists in mock mode; a generous static value
    // that never blocks a test, distinct from a "no limit configured" undefined.
    return {
      dailyCapWei: undefined,
      dailyUsedWei: 0n,
      dailySolanaCapLamports: undefined,
      dailySolanaUsedLamports: 0n,
      effectiveDailyCapWei: 20_000_000_000_000_000n,
      effectiveDailySolanaCapLamports: 500_000_000n,
      usingDefaultDailyCap: true,
      usingDefaultDailySolanaCap: true,
    };
  }

  public async tempoSignAndHold(
    intent: TempoHoldIntent,
  ): Promise<TempoHoldResult> {
    if (this.scenario.simulateLatencyMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.scenario.simulateLatencyMs),
      );
    }

    if (this.scenario.forceSimulationRevert) {
      const reason =
        this.scenario.simulationRevertReason || "TEMPO_HOLD_REJECTED";
      return {
        ok: false,
        error: `Hold rejected: ${reason}`,
        revertReason: reason,
      };
    }

    const paymentId = `tempo_pay_${randomUUID().slice(0, 12)}`;
    this.tempoHolds.set(paymentId, {
      recipient: intent.recipient,
      amount: intent.amount,
      network: intent.network,
      tokenAddress: intent.tokenAddress,
    });

    return {
      ok: true,
      paymentId,
      precomputedHash: `0x${randomBytes(32).toString("hex")}`,
      from: "0xMockKeeperHubWallet00000000000000000000",
      to: intent.recipient,
      amount: intent.amount,
      memo: intent.memo,
      broadcastMode: intent.broadcastMode ?? "manual",
      broadcastAt: intent.broadcastAt,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      status: "pending",
      chainId: 42431,
    };
  }

  public async tempoReleaseHold(
    paymentId: string,
    idempotencyKey?: string,
  ): Promise<ExecutionResult> {
    const key = idempotencyKey ?? paymentId;
    const existing = this.runs.get(key);
    if (existing) {
      return existing;
    }

    const hold = this.tempoHolds.get(paymentId);
    if (!hold) {
      return {
        state: "FAILED",
        idempotencyKey: key,
        error: `No held Tempo payment found matching paymentId '${paymentId}'.`,
        revertReason: "TEMPO_PAYMENT_ID_UNKNOWN",
      };
    }

    if (this.scenario.simulateLatencyMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.scenario.simulateLatencyMs),
      );
    }

    if (this.scenario.forceExecutionTimeout) {
      const unknownResult: ExecutionResult = {
        state: "UNKNOWN",
        idempotencyKey: key,
        error:
          "Network timeout or dropped connection: Operation timed out without server acknowledgment.",
      };
      this.runs.set(key, unknownResult);
      return unknownResult;
    }

    if (this.scenario.forceExecutionRevert) {
      const revertReason =
        this.scenario.executionRevertReason || "TEMPO_RELEASE_REVERTED";
      const failedResult: ExecutionResult = {
        state: "FAILED",
        idempotencyKey: key,
        revertReason,
        error: `Tempo release failed: ${revertReason}`,
      };
      this.runs.set(key, failedResult);
      return failedResult;
    }

    const txHash = `0x${randomBytes(32).toString("hex")}`;
    const confirmedResult: ExecutionResult = {
      state: "CONFIRMED",
      idempotencyKey: key,
      txHash,
      explorerUrl: `https://explore.testnet.tempo.xyz/tx/${txHash}`,
      confirmedAt: Date.now(),
    };

    this.runs.set(key, confirmedResult);
    this.tempoHolds.delete(paymentId);
    return confirmedResult;
  }

  public async tempoCancelHold(paymentId: string): Promise<TempoCancelResult> {
    const hold = this.tempoHolds.get(paymentId);
    if (!hold) {
      return {
        ok: false,
        error: `No held Tempo payment found matching paymentId '${paymentId}'.`,
      };
    }

    this.tempoHolds.delete(paymentId);
    return { ok: true, status: "canceled" };
  }
}
