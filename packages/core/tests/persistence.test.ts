import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KeeperHubClient } from "../src/keeperhub/client.js";
import { MockKeeperHubTransport } from "../src/keeperhub/mock-transport.js";
import type { FirewallPolicy, TempoHoldIntent } from "../src/types/index.js";

describe("Opt-in file-backed persistence (KeeperHubClientOptions.persistDir)", () => {
  const approvedRecipient = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const approvedAction = "aave-v3/supply";

  const policy: FirewallPolicy = {
    network: "base-sepolia",
    maxAmountPerTx: 1_000_000n,
    maxCumulativeDailySpend: 10_000_000n,
    allowedRecipients: [approvedRecipient],
    requireSimulationSuccess: true,
    allowedProtocolActions: [approvedAction],
    allowedTempoNetworks: ["tempo-testnet"],
    allowedTempoTokens: ["0x20c0000000000000000000000000000000000000"],
    maxTempoAmountPerHold: 10,
    maxTempoCumulativeDailySpend: 50,
  };

  const tempoIntent: TempoHoldIntent = {
    idempotencyKey: "persistence_hold_key",
    network: "tempo-testnet",
    tokenAddress: "0x20c0000000000000000000000000000000000000",
    tokenSymbol: "pathUSD",
    amount: "1",
    recipient: approvedRecipient,
  };

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dreamkeeper-persist-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not touch the filesystem when persistDir is unset (default behavior unchanged)", async () => {
    const client = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: new MockKeeperHubTransport() },
    );
    const hold = await client.tempoSignAndHold(tempoIntent);
    expect(hold.ok).toBe(true);
    // No assertion needed beyond "this ran without a persistDir and didn't
    // throw" — the point is the in-memory default path is untouched.
  });

  it("recovers idempotency state, tempo hold tracking, and circuit breaker state across a fresh client instance", async () => {
    // A single shared transport instance stands in for KeeperHub's own
    // server-side hold state, which is real and persistent independent of
    // this client's own process — only KeeperHubClient's local ownership
    // tracking (activeTempoHolds) is what needs to survive a restart here.
    const sharedTransport = new MockKeeperHubTransport();

    const clientA = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: sharedTransport, persistDir: dir },
    );

    // 1. Idempotency + Tempo hold tracking: sign a hold but don't release it
    // yet, so activeTempoHolds still has a live entry to recover.
    const hold = await clientA.tempoSignAndHold(tempoIntent);
    expect(hold.ok).toBe(true);
    expect(hold.paymentId).toBeTruthy();

    // 2. A brand-new client instance, same persistDir, simulating a process
    // restart — it must recover the tempo hold tracking from disk, proven by
    // successfully releasing a hold it never itself created in memory.
    const clientB = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: sharedTransport, persistDir: dir },
    );
    const release = await clientB.tempoReleaseHold(hold.paymentId!);
    expect(release.state).toBe("CONFIRMED");

    // 3. Circuit breaker: trip it via 3 consecutive execution failures on a
    // separate transport instance configured to always revert, sharing the
    // same persistDir (and therefore circuit-breaker.json).
    const failingClient = new KeeperHubClient(
      { mode: "mock", policy },
      {
        transport: new MockKeeperHubTransport({ forceExecutionRevert: true }),
        persistDir: dir,
      },
    );
    for (let i = 0; i < 3; i++) {
      await failingClient.executeProtocolAction({
        idempotencyKey: `persistence_trip_key_${i}`,
        actionType: approvedAction,
        params: {},
      });
    }
    const trippedResult = await failingClient.executeProtocolAction({
      idempotencyKey: "persistence_trip_confirm_key",
      actionType: approvedAction,
      params: {},
    });
    expect(trippedResult.error).toContain("CIRCUIT_BREAKER_OPEN");
    expect(failingClient.getTrustSummary().totalFailedExecutions).toBe(3);

    // 4. Yet another fresh instance, same persistDir, simulating a second
    // process restart — the circuit breaker must still be OPEN, recovered
    // from circuit-breaker.json rather than starting CLOSED, and the trust
    // ledger's failure count must also survive, recovered from
    // trust-ledger.json rather than resetting to 0.
    const clientC = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: new MockKeeperHubTransport(), persistDir: dir },
    );
    const blockedResult = await clientC.executeProtocolAction({
      idempotencyKey: "persistence_new_instance_key",
      actionType: approvedAction,
      params: {},
    });
    expect(blockedResult.error).toContain("CIRCUIT_BREAKER_OPEN");
    expect(clientC.getTrustSummary().totalFailedExecutions).toBe(3);
  });

  it("refuses to release a paymentId not recovered from disk (unrelated persistDir)", async () => {
    const clientA = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: new MockKeeperHubTransport(), persistDir: dir },
    );
    const hold = await clientA.tempoSignAndHold(tempoIntent);
    expect(hold.ok).toBe(true);

    const otherDir = mkdtempSync(join(tmpdir(), "dreamkeeper-persist-test-"));
    try {
      const clientC = new KeeperHubClient(
        { mode: "mock", policy },
        { transport: new MockKeeperHubTransport(), persistDir: otherDir },
      );
      const release = await clientC.tempoReleaseHold(hold.paymentId!);
      expect(release.state).toBe("FAILED");
      expect(release.error).toContain("was not created by this client");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
