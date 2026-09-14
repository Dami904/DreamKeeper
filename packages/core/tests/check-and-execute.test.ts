import { describe, it, expect } from "vitest";
import { computeCheckAndExecuteIntentHash } from "../src/firewall/validator.js";
import { MockKeeperHubTransport } from "../src/keeperhub/mock-transport.js";
import { KeeperHubClient } from "../src/keeperhub/client.js";
import { createDaydreamsActions } from "../src/daydreams/actions.js";
import type {
  CheckAndExecuteIntent,
  FirewallPolicy,
} from "../src/types/index.js";

describe("Atomic Check-and-Execute Support (execute_check_and_execute)", () => {
  const checkContract = "0x2222222222222222222222222222222222222222";
  const actionContract = "0x1111111111111111111111111111111111111111";
  const unapprovedContract = "0x9999999999999999999999999999999999999999";

  const baseIntent: CheckAndExecuteIntent = {
    check: {
      contractAddress: checkContract,
      functionName: "balanceOf",
      functionArgs: '["0xabc"]',
    },
    condition: { operator: "gt", value: "1000" },
    action: {
      contractAddress: actionContract,
      functionName: "topUp",
      functionArgs: '["500"]',
      value: 0n,
    },
  };

  describe("computeCheckAndExecuteIntentHash: full shape is bound, not just the action", () => {
    it("produces different hashes when only the condition differs", () => {
      const hashA = computeCheckAndExecuteIntentHash(baseIntent);
      const hashB = computeCheckAndExecuteIntentHash({
        ...baseIntent,
        condition: { operator: "gt", value: "999999" },
      });
      expect(hashA).not.toBe(hashB);
    });

    it("produces different hashes when only the check function differs", () => {
      const hashA = computeCheckAndExecuteIntentHash(baseIntent);
      const hashB = computeCheckAndExecuteIntentHash({
        ...baseIntent,
        check: { ...baseIntent.check, functionName: "totalSupply" },
      });
      expect(hashA).not.toBe(hashB);
    });

    it("produces different hashes when only the action's value differs", () => {
      const hashA = computeCheckAndExecuteIntentHash(baseIntent);
      const hashB = computeCheckAndExecuteIntentHash({
        ...baseIntent,
        action: { ...baseIntent.action, value: 999n },
      });
      expect(hashA).not.toBe(hashB);
    });

    it("is stable across repeated calls with identical intents", () => {
      const hashA = computeCheckAndExecuteIntentHash(baseIntent);
      const hashB = computeCheckAndExecuteIntentHash({ ...baseIntent });
      expect(hashA).toBe(hashB);
    });
  });

  describe("MockKeeperHubTransport + KeeperHubClient: end-to-end via the real action handlers", () => {
    const policy: FirewallPolicy = {
      network: "base-sepolia",
      maxAmountPerTx: 1_000_000n,
      maxCumulativeDailySpend: 10_000_000n,
      allowedRecipients: [actionContract],
      allowedMethods: ["topUp"],
      requireSimulationSuccess: true,
    };

    function buildFlatArgs(overrides: Record<string, unknown> = {}) {
      return {
        checkContractAddress: checkContract,
        checkFunctionName: "balanceOf",
        checkFunctionArgs: '["0xabc"]',
        operator: "gt",
        conditionValue: "1000",
        actionContractAddress: actionContract,
        actionFunctionName: "topUp",
        actionFunctionArgs: '["500"]',
        ...overrides,
      };
    }

    it("simulates and executes a check-and-execute action end to end", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy },
        { transport: new MockKeeperHubTransport() },
      );
      const actions = createDaydreamsActions(client);

      const dryRunRes =
        await actions.checkAndExecuteDryRunAction.handler(buildFlatArgs());
      expect(dryRunRes.status).toBe("SIMULATION_SUCCESS");
      expect(dryRunRes.dryRunTokenId).toBeTruthy();

      const execRes = await actions.checkAndExecuteAction.handler({
        ...buildFlatArgs(),
        idempotencyKey: "check_and_execute_test_key",
        dryRunTokenId: dryRunRes.dryRunTokenId,
      });
      expect(execRes.status).toBe("CONFIRMED");
      expect(execRes.txHash).toBeTruthy();
    });

    it("blocks an action targeting a non-whitelisted contract before touching the transport", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy },
        { transport: new MockKeeperHubTransport() },
      );
      const actions = createDaydreamsActions(client);

      const dryRunRes = await actions.checkAndExecuteDryRunAction.handler(
        buildFlatArgs({ actionContractAddress: unapprovedContract }),
      );
      expect(dryRunRes.status).toBe("SIMULATION_FAILED");
      expect(dryRunRes.revertReason).toBe("RECIPIENT_NOT_WHITELISTED");
    });

    it("blocks execution if the dry-run token's bound intent doesn't match (tamper detection)", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy },
        { transport: new MockKeeperHubTransport() },
      );
      const actions = createDaydreamsActions(client);

      const dryRunRes =
        await actions.checkAndExecuteDryRunAction.handler(buildFlatArgs());
      expect(dryRunRes.status).toBe("SIMULATION_SUCCESS");

      // Attacker/hallucinating agent swaps the condition value after dry-run
      const execRes = await actions.checkAndExecuteAction.handler({
        ...buildFlatArgs({ conditionValue: "1" }),
        idempotencyKey: "tampered_key_123456",
        dryRunTokenId: dryRunRes.dryRunTokenId,
      });
      expect(execRes.status).toBe("FAILED");
      expect(execRes.revertReason).toBe("DRY_RUN_INTENT_MISMATCH");
    });
  });
});
