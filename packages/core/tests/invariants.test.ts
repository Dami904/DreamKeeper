import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { InvariantEvaluator } from "../src/firewall/invariants.js";

describe("InvariantEvaluator (Property-Based & Deterministic)", () => {
  describe("Deterministic Invariant Checks", () => {
    it("passes when simulation delta is within acceptable balance loss", () => {
      const result = InvariantEvaluator.evaluate(
        { maxBalanceLoss: 100n },
        { estimatedGasUnits: 21_000n, actualDelta: -80n },
      );
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("rejects when actual balance loss exceeds ceiling", () => {
      const result = InvariantEvaluator.evaluate(
        { maxBalanceLoss: 100n },
        { estimatedGasUnits: 21_000n, actualDelta: -120n }, // 120 > 100 loss
      );
      expect(result.passed).toBe(false);
      expect(result.violations[0]).toContain("MAX_BALANCE_LOSS_VIOLATED");
    });

    it("passes when tokens received meets or exceeds minimum threshold", () => {
      const result = InvariantEvaluator.evaluate(
        { minTokensReceived: 500n },
        { estimatedGasUnits: 65_000n, actualDelta: 500n, tokensReceived: 500n },
      );
      expect(result.passed).toBe(true);
    });

    it("rejects when tokens received is below minimum expected threshold", () => {
      const result = InvariantEvaluator.evaluate(
        { minTokensReceived: 500n },
        { estimatedGasUnits: 65_000n, actualDelta: 450n, tokensReceived: 450n },
      );
      expect(result.passed).toBe(false);
      expect(result.violations[0]).toContain("MIN_TOKENS_RECEIVED_VIOLATED");
    });

    it("rejects when estimated gas exceeds gas ceiling", () => {
      const result = InvariantEvaluator.evaluate(
        { maxGasUnits: 100_000n },
        { estimatedGasUnits: 150_000n, actualDelta: 0n },
      );
      expect(result.passed).toBe(false);
      expect(result.violations[0]).toContain("MAX_GAS_EXCEEDED");
    });

    it("automatically fails on simulation revert", () => {
      const result = InvariantEvaluator.evaluate(
        {},
        {
          estimatedGasUnits: 0n,
          actualDelta: 0n,
          revertReason: "PANIC_ASSERT_FAILED",
        },
      );
      expect(result.passed).toBe(false);
      expect(result.violations[0]).toContain("PANIC_ASSERT_FAILED");
    });
  });

  describe("Property-Based Invariants (fast-check)", () => {
    it("never violates maxBalanceLoss when actual loss is strictly <= ceiling", () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 1n, max: 1_000_000n }),
          fc.bigInt({ min: 0n, max: 1_000_000n }),
          (ceiling, margin) => {
            const actualLoss = ceiling > margin ? ceiling - margin : 0n;
            const evalResult = InvariantEvaluator.evaluate(
              { maxBalanceLoss: ceiling },
              { estimatedGasUnits: 50_000n, actualDelta: -actualLoss },
            );
            return evalResult.passed === true;
          },
        ),
      );
    });

    it("always violates maxBalanceLoss when actual loss is strictly > ceiling", () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 1n, max: 1_000_000n }),
          fc.bigInt({ min: 1n, max: 500_000n }),
          (ceiling, excess) => {
            const actualLoss = ceiling + excess;
            const evalResult = InvariantEvaluator.evaluate(
              { maxBalanceLoss: ceiling },
              { estimatedGasUnits: 50_000n, actualDelta: -actualLoss },
            );
            return evalResult.passed === false;
          },
        ),
      );
    });
  });
});
