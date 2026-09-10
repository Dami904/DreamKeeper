import { describe, it, expect, beforeEach } from "vitest";
import { dreamkeeperExtension } from "../src/daydreams/extension.js";
import { MockKeeperHubTransport } from "../src/keeperhub/mock-transport.js";
import { KeeperHubClient } from "../src/keeperhub/client.js";
import type { FirewallPolicy } from "../src/types/index.js";

describe("Daydreams Extension & Action Handlers", () => {
  const allowedAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const rogueAddress = "0x9999999999999999999999999999999999999999";

  const policy: FirewallPolicy = {
    network: "base-sepolia",
    maxAmountPerTx: 50_000n,
    maxCumulativeDailySpend: 150_000n,
    allowedRecipients: [allowedAddress],
    requireSimulationSuccess: true,
  };

  let mockTransport: MockKeeperHubTransport;
  let extension: ReturnType<typeof dreamkeeperExtension>;

  beforeEach(async () => {
    mockTransport = new MockKeeperHubTransport();
    const client = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: mockTransport },
    );
    extension = dreamkeeperExtension({ mode: "mock", policy });
    // Point extension to our configured client
    extension.client = client;
    extension.actions = (
      await import("../src/daydreams/actions.js")
    ).createDaydreamsActions(client);
  });

  it("exposes all 4 required Daydreams action tools", () => {
    expect(extension.name).toBe("dreamkeeper");
    expect(extension.actionsList).toHaveLength(4);
    const names = extension.actionsList.map((a) => a.name);
    expect(names).toContain("keeperhub_dry_run");
    expect(names).toContain("keeperhub_execute");
    expect(names).toContain("keeperhub_reconcile");
    expect(names).toContain("keeperhub_get_audit");
  });

  describe("keeperhub_dry_run Action", () => {
    it("successfully simulates approved intent and returns dryRunTokenId", async () => {
      const result = await extension.actions.dryRunAction.handler({
        recipient: allowedAddress,
        amount: "25000",
      });

      expect(result.status).toBe("SIMULATION_SUCCESS");
      expect(result.dryRunTokenId).toBeDefined();
      expect(result.dryRunTokenId).toMatch(/^drt_/);
      expect(result.estimatedGasUnits).toBe("65000");
    });

    it("blocks rogue or hallucinated address before touching network", async () => {
      const result = await extension.actions.dryRunAction.handler({
        recipient: rogueAddress,
        amount: "1000",
      });

      expect(result.status).toBe("SIMULATION_FAILED");
      expect(result.error).toContain("FIREWALL_BLOCKED");
      expect(result.revertReason).toBe("RECIPIENT_NOT_WHITELISTED");
    });

    it("blocks amounts exceeding single-transaction ceiling", async () => {
      const result = await extension.actions.dryRunAction.handler({
        recipient: allowedAddress,
        amount: "60000", // > 50,000 limit
      });

      expect(result.status).toBe("SIMULATION_FAILED");
      expect(result.revertReason).toBe("AMOUNT_EXCEEDS_TX_CAP");
    });
  });

  describe("keeperhub_execute Action", () => {
    it("successfully broadcasts approved workflow and returns CONFIRMED txHash", async () => {
      // 1. Dry run
      const dryRunRes = await extension.actions.dryRunAction.handler({
        recipient: allowedAddress,
        amount: "10000",
      });
      expect(dryRunRes.status).toBe("SIMULATION_SUCCESS");

      // 2. Execute
      const execRes = await extension.actions.executeAction.handler({
        idempotencyKey: "test_exec_key_1",
        dryRunTokenId: dryRunRes.dryRunTokenId,
        recipient: allowedAddress,
        amount: "10000",
      });

      expect(execRes.status).toBe("CONFIRMED");
      expect(execRes.txHash).toBeDefined();
      expect(execRes.txHash).toMatch(/^0x[a-f0-9]{64}$/i);
      expect(execRes.explorerUrl).toContain("sepolia.basescan.org");

      // 3. Inspect audit trail
      const auditRes = await extension.actions.auditAction.handler({
        runId: execRes.runId,
      });
      expect(auditRes.found).toBe(true);
      expect(auditRes.audit.recipient).toBe(allowedAddress);
    });

    it("enforces idempotency: repeated execution returns identical txHash without double-spending", async () => {
      const dryRunRes = await extension.actions.dryRunAction.handler({
        recipient: allowedAddress,
        amount: "5000",
      });

      const key = "idempotent_key_abc";

      const run1 = await extension.actions.executeAction.handler({
        idempotencyKey: key,
        dryRunTokenId: dryRunRes.dryRunTokenId,
        recipient: allowedAddress,
        amount: "5000",
      });

      const run2 = await extension.actions.executeAction.handler({
        idempotencyKey: key,
        dryRunTokenId: dryRunRes.dryRunTokenId,
        recipient: allowedAddress,
        amount: "5000",
      });

      expect(run1.status).toBe("CONFIRMED");
      expect(run2.status).toBe("CONFIRMED");
      expect(run1.txHash).toBe(run2.txHash);
      expect(run1.runId).toBe(run2.runId);
    });

    it("handles timeouts via UNKNOWN state and recovers via keeperhub_reconcile", async () => {
      // Configure mock transport to simulate network drop on execution
      mockTransport.setScenario({ forceExecutionTimeout: true });

      const dryRunRes = await extension.actions.dryRunAction.handler({
        recipient: allowedAddress,
        amount: "7000",
      });

      const key = "timeout_key_xyz";

      // Execute times out -> UNKNOWN
      const execRes = await extension.actions.executeAction.handler({
        idempotencyKey: key,
        dryRunTokenId: dryRunRes.dryRunTokenId,
        recipient: allowedAddress,
        amount: "7000",
      });

      expect(execRes.status).toBe("UNKNOWN");
      expect(execRes.warning).toContain("Call keeperhub_reconcile");

      // Agent calls reconcile to recover the transaction
      const reconcileRes = await extension.actions.reconcileAction.handler({
        idempotencyKey: key,
      });

      expect(reconcileRes.state).toBe("CONFIRMED");
      expect(reconcileRes.txHash).toBeDefined();
      expect(reconcileRes.txHash).toMatch(/^0x[a-f0-9]{64}$/i);
    });
  });
});
