import type { ExpectedInvariant } from "../types/index.js";
import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("InvariantEvaluator");

export interface SimulationTraceOutput {
  estimatedGasUnits: bigint;
  actualDelta: bigint; // Negative for outflow, positive for inflow
  revertReason?: string;
  tokensReceived?: bigint;
}

export interface InvariantEvaluationResult {
  passed: boolean;
  violations: string[];
  trace: SimulationTraceOutput;
}

export class InvariantEvaluator {
  /**
   * Mathematically evaluates expected invariants against simulation trace output
   */
  public static evaluate(
    expected?: ExpectedInvariant,
    trace?: SimulationTraceOutput,
  ): InvariantEvaluationResult {
    if (!trace) {
      return {
        passed: false,
        violations: [
          "MISSING_SIMULATION_TRACE: No simulation output available to evaluate.",
        ],
        trace: { estimatedGasUnits: 0n, actualDelta: 0n },
      };
    }

    if (trace.revertReason) {
      return {
        passed: false,
        violations: [`SIMULATION_REVERT: ${trace.revertReason}`],
        trace,
      };
    }

    if (!expected) {
      return { passed: true, violations: [], trace };
    }

    const violations: string[] = [];

    // 1. Max Balance Loss Invariant
    if (expected.maxBalanceLoss !== undefined) {
      // If delta is negative, loss is -actualDelta
      const loss = trace.actualDelta < 0n ? -trace.actualDelta : 0n;
      if (loss > expected.maxBalanceLoss) {
        violations.push(
          `MAX_BALANCE_LOSS_VIOLATED: Actual loss (${loss.toString()}) exceeds allowed ceiling (${expected.maxBalanceLoss.toString()})`,
        );
      }
    }

    // 2. Min Tokens Received Invariant
    if (expected.minTokensReceived !== undefined) {
      const received =
        trace.tokensReceived ??
        (trace.actualDelta > 0n ? trace.actualDelta : 0n);
      if (received < expected.minTokensReceived) {
        violations.push(
          `MIN_TOKENS_RECEIVED_VIOLATED: Received (${received.toString()}) is less than expected minimum (${expected.minTokensReceived.toString()})`,
        );
      }
    }

    // 3. Max Gas Ceiling Invariant
    if (expected.maxGasUnits !== undefined) {
      if (trace.estimatedGasUnits > expected.maxGasUnits) {
        violations.push(
          `MAX_GAS_EXCEEDED: Estimated gas (${trace.estimatedGasUnits.toString()}) exceeds ceiling (${expected.maxGasUnits.toString()})`,
        );
      }
    }

    const passed = violations.length === 0;

    if (!passed) {
      logger.warn("Simulation trace failed invariant evaluation", {
        context: {
          violations,
          trace: {
            ...trace,
            estimatedGasUnits: trace.estimatedGasUnits.toString(),
          },
        },
      });
    }

    return { passed, violations, trace };
  }
}
