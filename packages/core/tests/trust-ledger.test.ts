import { describe, it, expect, beforeEach } from "vitest";
import { TrustLedger } from "../src/firewall/trust-ledger.js";
import { KeeperHubClient } from "../src/keeperhub/client.js";
import { MockKeeperHubTransport } from "../src/keeperhub/mock-transport.js";
import type { FirewallPolicy } from "../src/types/index.js";

describe("TrustLedger (unit)", () => {
  let ledger: TrustLedger;

  beforeEach(() => {
    ledger = new TrustLedger();
  });

  it("starts at zero for every counter", () => {
    const snapshot = ledger.getSnapshot();
    expect(snapshot.totalBlockedAttempts).toBe(0);
    expect(snapshot.blockedByReason).toEqual({});
    expect(snapshot.totalConfirmedExecutions).toBe(0);
    expect(snapshot.totalFailedExecutions).toBe(0);
    expect(snapshot.totalUnknownExecutions).toBe(0);
  });

  it("counts blocked attempts by reason", () => {
    ledger.recordBlocked("RECIPIENT_NOT_WHITELISTED");
    ledger.recordBlocked("RECIPIENT_NOT_WHITELISTED");
    ledger.recordBlocked("AMOUNT_EXCEEDS_TX_CAP");

    const snapshot = ledger.getSnapshot();
    expect(snapshot.totalBlockedAttempts).toBe(3);
    expect(snapshot.blockedByReason).toEqual({
      RECIPIENT_NOT_WHITELISTED: 2,
      AMOUNT_EXCEEDS_TX_CAP: 1,
    });
  });

  it("counts confirmed/failed/unknown execution outcomes independently", () => {
    ledger.recordConfirmed();
    ledger.recordConfirmed();
    ledger.recordFailed();
    ledger.recordUnknown();

    const snapshot = ledger.getSnapshot();
    expect(snapshot.totalConfirmedExecutions).toBe(2);
    expect(snapshot.totalFailedExecutions).toBe(1);
    expect(snapshot.totalUnknownExecutions).toBe(1);
  });

  it("round-trips through getSnapshot/restoreSnapshot", () => {
    ledger.recordBlocked("METHOD_NOT_ALLOWED");
    ledger.recordConfirmed();
    const snapshot = ledger.getSnapshot();

    const restored = new TrustLedger();
    restored.restoreSnapshot(snapshot);
    expect(restored.getSnapshot()).toEqual(snapshot);
  });
});

describe("TrustLedger wiring through KeeperHubClient", () => {
  const approvedRecipient = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const unwhitelisted = "0x9999999999999999999999999999999999999999";
  const approvedAction = "aave-v3/supply";

  const policy: FirewallPolicy = {
    network: "base-sepolia",
    maxAmountPerTx: 1_000_000n,
    maxCumulativeDailySpend: 10_000_000n,
    allowedRecipients: [approvedRecipient],
    requireSimulationSuccess: true,
    allowedProtocolActions: [approvedAction],
  };

  it("a real blocked dry-run increments totalBlockedAttempts and blockedByReason", async () => {
    const client = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: new MockKeeperHubTransport() },
    );

    const result = await client.dryRun({
      recipient: unwhitelisted,
      amount: 10n,
    });
    expect(result.ok).toBe(false);

    const summary = client.getTrustSummary();
    expect(summary.totalBlockedAttempts).toBe(1);
    expect(summary.blockedByReason["RECIPIENT_NOT_WHITELISTED"]).toBe(1);
  });

  it("a real confirmed execute() increments totalConfirmedExecutions", async () => {
    const client = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: new MockKeeperHubTransport() },
    );

    const dryRunRes = await client.dryRun({
      recipient: approvedRecipient,
      amount: 1_000n,
    });
    expect(dryRunRes.ok).toBe(true);

    const execRes = await client.execute({
      idempotencyKey: "trust_ledger_confirm_key",
      dryRunTokenId: dryRunRes.token!.tokenId,
      recipient: approvedRecipient,
      amount: 1_000n,
    });
    expect(execRes.state).toBe("CONFIRMED");

    const summary = client.getTrustSummary();
    expect(summary.totalConfirmedExecutions).toBe(1);
    expect(summary.totalBlockedAttempts).toBe(0);
  });

  it("a real failed broadcast increments totalFailedExecutions, not totalBlockedAttempts", async () => {
    const client = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: new MockKeeperHubTransport({ forceExecutionRevert: true }) },
    );

    const result = await client.executeProtocolAction({
      idempotencyKey: "trust_ledger_fail_key",
      actionType: approvedAction,
      params: {},
    });
    expect(result.state).toBe("FAILED");

    const summary = client.getTrustSummary();
    expect(summary.totalFailedExecutions).toBe(1);
    expect(summary.totalBlockedAttempts).toBe(0);
  });

  it("getTrustSummary() reports the current circuit breaker state alongside the counters", async () => {
    const client = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: new MockKeeperHubTransport({ forceExecutionRevert: true }) },
    );

    for (let i = 0; i < 3; i++) {
      await client.executeProtocolAction({
        idempotencyKey: `trust_ledger_trip_key_${i}`,
        actionType: approvedAction,
        params: {},
      });
    }

    const summary = client.getTrustSummary();
    expect(summary.circuitBreakerState).toBe("OPEN");
    expect(summary.totalFailedExecutions).toBe(3);
  });
});
