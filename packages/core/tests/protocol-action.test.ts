import { describe, it, expect, vi } from "vitest";
import { FirewallValidator } from "../src/firewall/validator.js";
import { MockKeeperHubTransport } from "../src/keeperhub/mock-transport.js";
import { KeeperHubClient } from "../src/keeperhub/client.js";
import { createDaydreamsActions } from "../src/daydreams/actions.js";
import type { FirewallPolicy } from "../src/types/index.js";

describe("Protocol Action Support (execute_protocol_action)", () => {
  const approvedAction = "aave-v3/supply";
  const unapprovedAction = "aave-v3/borrow";

  describe("FirewallValidator: default-deny even when unconfigured", () => {
    it("blocks every protocol action when allowedProtocolActions is unset", () => {
      const policy: FirewallPolicy = {
        network: "base-sepolia",
        maxAmountPerTx: 1_000_000n,
        maxCumulativeDailySpend: 10_000_000n,
        allowedRecipients: [],
        requireSimulationSuccess: true,
        // allowedProtocolActions intentionally omitted
      };
      const validator = new FirewallValidator(policy);
      const result = validator.validateProtocolAction(approvedAction);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("PROTOCOL_ACTION_NOT_ALLOWED");
      }
    });

    it("permits only exactly-whitelisted actionType strings", () => {
      const policy: FirewallPolicy = {
        network: "base-sepolia",
        maxAmountPerTx: 1_000_000n,
        maxCumulativeDailySpend: 10_000_000n,
        allowedRecipients: [],
        requireSimulationSuccess: true,
        allowedProtocolActions: [approvedAction],
      };
      const validator = new FirewallValidator(policy);

      expect(validator.validateProtocolAction(approvedAction).valid).toBe(true);
      const blocked = validator.validateProtocolAction(unapprovedAction);
      expect(blocked.valid).toBe(false);
      if (!blocked.valid) {
        expect(blocked.reason).toBe("PROTOCOL_ACTION_NOT_ALLOWED");
      }
    });
  });

  describe("MockKeeperHubTransport + KeeperHubClient: end-to-end via the real action handler", () => {
    const policy: FirewallPolicy = {
      network: "base-sepolia",
      maxAmountPerTx: 1_000_000n,
      maxCumulativeDailySpend: 10_000_000n,
      allowedRecipients: [],
      requireSimulationSuccess: true,
      allowedProtocolActions: [approvedAction],
    };

    it("executes an approved protocol action end to end", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy },
        { transport: new MockKeeperHubTransport() },
      );
      const actions = createDaydreamsActions(client);

      const result = await actions.protocolActionAction.handler({
        idempotencyKey: "protocol_action_test_key",
        actionType: approvedAction,
        paramsJson: JSON.stringify({ network: "84532", amount: "1000000" }),
      });

      expect(result.status).toBe("CONFIRMED");
      expect(result.txHash).toBeTruthy();
    });

    it("blocks an unapproved protocol action before touching the transport", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy },
        { transport: new MockKeeperHubTransport() },
      );
      const actions = createDaydreamsActions(client);

      const result = await actions.protocolActionAction.handler({
        idempotencyKey: "protocol_action_blocked_key",
        actionType: unapprovedAction,
        paramsJson: JSON.stringify({ network: "84532" }),
      });

      expect(result.status).toBe("FAILED");
      expect(result.revertReason).toBe("PROTOCOL_ACTION_NOT_ALLOWED");
    });

    it("rejects malformed paramsJson without touching the transport", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy },
        { transport: new MockKeeperHubTransport() },
      );
      const actions = createDaydreamsActions(client);

      const result = await actions.protocolActionAction.handler({
        idempotencyKey: "protocol_action_bad_json_key",
        actionType: approvedAction,
        paramsJson: "{not valid json",
      });

      expect(result.status).toBe("FAILED");
      expect(result.error).toContain("valid JSON");
    });

    it("caches the result for a repeated idempotencyKey without double-executing", async () => {
      const transport = new MockKeeperHubTransport();
      const client = new KeeperHubClient(
        { mode: "mock", policy },
        { transport },
      );
      const actions = createDaydreamsActions(client);

      const first = await actions.protocolActionAction.handler({
        idempotencyKey: "protocol_action_idempotent_key",
        actionType: approvedAction,
        paramsJson: JSON.stringify({ amount: "1" }),
      });
      const second = await actions.protocolActionAction.handler({
        idempotencyKey: "protocol_action_idempotent_key",
        actionType: approvedAction,
        paramsJson: JSON.stringify({ amount: "1" }),
      });

      expect(first.status).toBe("CONFIRMED");
      expect(second.txHash).toBe(first.txHash);
    });

    it("presents a synchronous read-type success (resultValue, no txHash) distinctly from a broadcast", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy },
        { transport: new MockKeeperHubTransport() },
      );
      vi.spyOn(client, "executeProtocolAction").mockResolvedValue({
        state: "CONFIRMED",
        idempotencyKey: "read_key",
        resultValue: "2478150000000000000000",
        explorerUrl:
          "https://etherscan.io/address/0x46ef0071b1E2fF6B42d36e5A177EA43Ae5917f4E",
        confirmedAt: Date.now(),
      });
      const actions = createDaydreamsActions(client);

      const result = await actions.protocolActionAction.handler({
        idempotencyKey: "read_key",
        actionType: "chronicle/eth-usd-read",
        paramsJson: JSON.stringify({ network: "1" }),
      });

      expect(result.status).toBe("CONFIRMED");
      expect(result.resultValue).toBe("2478150000000000000000");
      expect(result.txHash).toBeUndefined();
    });
  });
});
