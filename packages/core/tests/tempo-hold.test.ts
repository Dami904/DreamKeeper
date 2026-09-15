import { describe, it, expect } from "vitest";
import { FirewallValidator } from "../src/firewall/validator.js";
import { MockKeeperHubTransport } from "../src/keeperhub/mock-transport.js";
import { KeeperHubClient } from "../src/keeperhub/client.js";
import type { FirewallPolicy, TempoHoldIntent } from "../src/types/index.js";

describe("Tempo Hold/Release/Cancel Support (tempo_sign_and_hold / tempo_release_hold / tempo_cancel_hold)", () => {
  const approvedRecipient = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const rogueRecipient = "0x9999999999999999999999999999999999999999";
  const approvedNetwork = "tempo-testnet";
  const approvedToken = "0x20c0000000000000000000000000000000000000";

  const baseIntent: TempoHoldIntent = {
    idempotencyKey: "tempo_hold_test_key",
    network: approvedNetwork,
    tokenAddress: approvedToken,
    tokenSymbol: "pathUSD",
    amount: "1",
    recipient: approvedRecipient,
  };

  function basePolicy(overrides: Partial<FirewallPolicy> = {}): FirewallPolicy {
    return {
      network: "base-sepolia",
      maxAmountPerTx: 1_000_000n,
      maxCumulativeDailySpend: 10_000_000n,
      allowedRecipients: [approvedRecipient],
      requireSimulationSuccess: true,
      allowedTempoNetworks: [approvedNetwork],
      allowedTempoTokens: [approvedToken],
      maxTempoAmountPerHold: 10,
      maxTempoCumulativeDailySpend: 50,
      ...overrides,
    };
  }

  describe("FirewallValidator.validateTempoHold", () => {
    it("blocks a non-whitelisted recipient", () => {
      const validator = new FirewallValidator(basePolicy());
      const result = validator.validateTempoHold({
        ...baseIntent,
        recipient: rogueRecipient,
      });
      expect(result.valid).toBe(false);
      if (!result.valid)
        expect(result.reason).toBe("RECIPIENT_NOT_WHITELISTED");
    });

    it("default-denies every network when allowedTempoNetworks is unset", () => {
      const validator = new FirewallValidator(
        basePolicy({ allowedTempoNetworks: undefined }),
      );
      const result = validator.validateTempoHold(baseIntent);
      expect(result.valid).toBe(false);
      if (!result.valid)
        expect(result.reason).toBe("TEMPO_NETWORK_NOT_ALLOWED");
    });

    it("default-denies every token when allowedTempoTokens is unset", () => {
      const validator = new FirewallValidator(
        basePolicy({ allowedTempoTokens: undefined }),
      );
      const result = validator.validateTempoHold(baseIntent);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("TEMPO_TOKEN_NOT_ALLOWED");
    });

    it("default-denies every amount when maxTempoAmountPerHold is unset", () => {
      const validator = new FirewallValidator(
        basePolicy({ maxTempoAmountPerHold: undefined }),
      );
      const result = validator.validateTempoHold(baseIntent);
      expect(result.valid).toBe(false);
      if (!result.valid)
        expect(result.reason).toBe("TEMPO_AMOUNT_EXCEEDS_HOLD_CAP");
    });

    it("blocks an amount exceeding the per-hold cap", () => {
      const validator = new FirewallValidator(
        basePolicy({ maxTempoAmountPerHold: 0.5 }),
      );
      const result = validator.validateTempoHold(baseIntent);
      expect(result.valid).toBe(false);
      if (!result.valid)
        expect(result.reason).toBe("TEMPO_AMOUNT_EXCEEDS_HOLD_CAP");
    });

    it("blocks cumulative holds exceeding the rolling 24h cap", () => {
      const validator = new FirewallValidator(
        basePolicy({
          maxTempoAmountPerHold: 10,
          maxTempoCumulativeDailySpend: 1.5,
        }),
      );
      expect(validator.validateTempoHold(baseIntent).valid).toBe(true);
      validator.recordTempoSpend("1");
      const result = validator.validateTempoHold(baseIntent);
      expect(result.valid).toBe(false);
      if (!result.valid)
        expect(result.reason).toBe("TEMPO_AMOUNT_EXCEEDS_DAILY_LIMIT");
    });

    it("permits a fully-whitelisted, in-cap hold", () => {
      const validator = new FirewallValidator(basePolicy());
      expect(validator.validateTempoHold(baseIntent).valid).toBe(true);
    });

    it("sums repeated fractional spends via bigint, not float accumulation", () => {
      // 10 x "0.1" is the classic float-drift case: Number additions of 0.1
      // do not land exactly on 1 (0.1 + 0.1 + ... !== 1 in IEEE-754). A
      // parseFloat-based rolling sum could therefore trip the cap either one
      // step early or one step late depending on which way the drift falls.
      const validator = new FirewallValidator(
        basePolicy({
          maxTempoAmountPerHold: 1,
          maxTempoCumulativeDailySpend: 1,
        }),
      );
      for (let i = 0; i < 9; i++) {
        expect(
          validator.validateTempoHold({ ...baseIntent, amount: "0.1" }).valid,
        ).toBe(true);
        validator.recordTempoSpend("0.1");
      }
      // 9 x 0.1 = 0.9 spent; one more 0.1 hold reaches exactly the 1.0 cap.
      expect(
        validator.validateTempoHold({ ...baseIntent, amount: "0.1" }).valid,
      ).toBe(true);
      validator.recordTempoSpend("0.1");
      // Total is now exactly 1.0 (the cap) — any further hold must be blocked.
      const result = validator.validateTempoHold({
        ...baseIntent,
        amount: "0.01",
      });
      expect(result.valid).toBe(false);
      if (!result.valid)
        expect(result.reason).toBe("TEMPO_AMOUNT_EXCEEDS_DAILY_LIMIT");
    });
  });

  describe("MockKeeperHubTransport + KeeperHubClient: end-to-end lifecycle", () => {
    it("signs, holds, and releases a hold, recording spend and a real txHash", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy: basePolicy() },
        { transport: new MockKeeperHubTransport() },
      );

      const hold = await client.tempoSignAndHold(baseIntent);
      expect(hold.ok).toBe(true);
      expect(hold.paymentId).toBeTruthy();
      expect(hold.status).toBe("pending");

      const release = await client.tempoReleaseHold(hold.paymentId!);
      expect(release.state).toBe("CONFIRMED");
      expect(release.txHash).toMatch(/^0x[a-f0-9]{64}$/i);
    });

    it("blocks a hold to a non-whitelisted recipient before touching the transport", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy: basePolicy() },
        { transport: new MockKeeperHubTransport() },
      );

      const hold = await client.tempoSignAndHold({
        ...baseIntent,
        recipient: rogueRecipient,
      });
      expect(hold.ok).toBe(false);
      expect(hold.revertReason).toBe("RECIPIENT_NOT_WHITELISTED");
      expect(hold.paymentId).toBeUndefined();
    });

    it("cancels a hold, after which release fails as an unknown paymentId", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy: basePolicy() },
        { transport: new MockKeeperHubTransport() },
      );

      const hold = await client.tempoSignAndHold(baseIntent);
      expect(hold.ok).toBe(true);

      const cancel = await client.tempoCancelHold(hold.paymentId!);
      expect(cancel.ok).toBe(true);
      expect(cancel.status).toBe("canceled");

      const release = await client.tempoReleaseHold(hold.paymentId!);
      expect(release.state).toBe("FAILED");
      expect(release.revertReason).toBe("TEMPO_PAYMENT_ID_UNKNOWN");
    });

    it("refuses to release or cancel a paymentId this client never created", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy: basePolicy() },
        { transport: new MockKeeperHubTransport() },
      );

      const release = await client.tempoReleaseHold("hallucinated_payment_id");
      expect(release.state).toBe("FAILED");
      expect(release.revertReason).toBe("TEMPO_PAYMENT_ID_UNKNOWN");

      const cancel = await client.tempoCancelHold("hallucinated_payment_id");
      expect(cancel.ok).toBe(false);
    });

    it("returns a cached result for a repeated release idempotencyKey", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy: basePolicy() },
        { transport: new MockKeeperHubTransport() },
      );

      const hold = await client.tempoSignAndHold(baseIntent);
      const idempotencyKey = "tempo_release_idempotent_key";

      const first = await client.tempoReleaseHold(
        hold.paymentId!,
        idempotencyKey,
      );
      const second = await client.tempoReleaseHold(
        hold.paymentId!,
        idempotencyKey,
      );

      expect(first.state).toBe("CONFIRMED");
      expect(second.txHash).toBe(first.txHash);
    });
  });
});
