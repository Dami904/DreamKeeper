import { describe, it, expect, beforeEach } from "vitest";
import { FirewallValidator } from "../src/firewall/validator.js";
import type { FirewallPolicy, DryRunToken } from "../src/types/index.js";

describe("FirewallValidator & Policy Guardrails", () => {
  const allowedA = "0x1111111111111111111111111111111111111111";
  const allowedB = "0x2222222222222222222222222222222222222222";
  const unwhitelisted = "0x9999999999999999999999999999999999999999";

  const defaultPolicy: FirewallPolicy = {
    network: "base-sepolia",
    maxAmountPerTx: 100_000n, // max 100,000 wei per tx
    maxCumulativeDailySpend: 300_000n, // max 300,000 wei per 24h
    allowedRecipients: [allowedA, allowedB],
    allowedMethods: ["0xa9059cbb"], // ERC20 transfer(address,uint256) selector
    requireSimulationSuccess: true,
    dryRunTtlMs: 60_000,
  };

  let validator: FirewallValidator;

  beforeEach(() => {
    validator = new FirewallValidator(defaultPolicy);
  });

  describe("Recipient Whitelist Guard (Default-Deny)", () => {
    it("permits transactions to whitelisted addresses (case-insensitive)", () => {
      const result = validator.validateIntent({
        recipient: allowedA.toUpperCase(),
        amount: 50_000n,
        method: "0xa9059cbb",
      });
      expect(result.valid).toBe(true);
    });

    it("blocks transactions to non-whitelisted addresses cold", () => {
      const result = validator.validateIntent({
        recipient: unwhitelisted,
        amount: 10n,
        method: "0xa9059cbb",
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("RECIPIENT_NOT_WHITELISTED");
        expect(result.message).toContain(
          "not on the approved address whitelist",
        );
      }
    });
  });

  describe("Spend Limits & Velocity Guards", () => {
    it("allows amounts within the per-transaction limit", () => {
      const result = validator.validateIntent({
        recipient: allowedA,
        amount: 100_000n,
        method: "0xa9059cbb",
      });
      expect(result.valid).toBe(true);
    });

    it("blocks amounts exceeding the per-transaction limit", () => {
      const result = validator.validateIntent({
        recipient: allowedA,
        amount: 100_001n,
        method: "0xa9059cbb",
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("AMOUNT_EXCEEDS_TX_CAP");
      }
    });

    it("enforces rolling 24-hour cumulative spend limits", () => {
      // Spend 1: 100,000 (allowed)
      validator.recordSpend(100_000n);
      expect(validator.getRolling24hSpend()).toBe(100_000n);

      // Spend 2: 100,000 (allowed, cumulative 200,000)
      validator.recordSpend(100_000n);
      expect(validator.getRolling24hSpend()).toBe(200_000n);

      // Spend 3: 50,000 (allowed, cumulative 250,000)
      validator.recordSpend(50_000n);
      expect(validator.getRolling24hSpend()).toBe(250_000n);

      // Next attempt: 60,000 is under tx cap (100,000), but pushes total to 310,000 > 300,000 limit -> BLOCKED
      const result = validator.validateIntent({
        recipient: allowedA,
        amount: 60_000n,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("AMOUNT_EXCEEDS_DAILY_LIMIT");
      }
    });
  });

  describe("Dry-Run TTL & Intent Binding Guards", () => {
    it("blocks execution if dryRunToken has expired (> 60s)", () => {
      const now = Date.now();
      const expiredToken: DryRunToken = {
        tokenId: "token_123",
        intentHash: validator.computeIntentHash({
          recipient: allowedA,
          amount: 10_000n,
        }),
        issuedAt: now - 65_000, // 65 seconds ago
        expiresAt: now - 5_000,
        simulationTrace: {
          estimatedGasUnits: 50_000n,
          projectedDelta: -10_000n,
        },
      };

      const result = validator.validateExecution(
        {
          idempotencyKey: "test_key",
          dryRunTokenId: expiredToken.tokenId,
          recipient: allowedA,
          amount: 10_000n,
        },
        expiredToken,
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("DRY_RUN_TOKEN_EXPIRED");
      }
    });

    it("blocks execution if intent parameters were modified after simulation (tamper detection)", () => {
      const token: DryRunToken = {
        tokenId: "token_clean",
        intentHash: validator.computeIntentHash({
          recipient: allowedA,
          amount: 10_000n,
        }),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        simulationTrace: {
          estimatedGasUnits: 50_000n,
          projectedDelta: -10_000n,
        },
      };

      // Attacker or hallucinating LLM alters amount from 10,000 to 50,000
      const tamperedResult = validator.validateExecution(
        {
          idempotencyKey: "test_key",
          dryRunTokenId: token.tokenId,
          recipient: allowedA,
          amount: 50_000n, // Tampered!
        },
        token,
      );

      expect(tamperedResult.valid).toBe(false);
      if (!tamperedResult.valid) {
        expect(tamperedResult.reason).toBe("DRY_RUN_INTENT_MISMATCH");
      }
    });
  });
});
