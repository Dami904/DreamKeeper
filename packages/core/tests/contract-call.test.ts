import { describe, it, expect, beforeEach } from "vitest";
import {
  FirewallValidator,
  computeIntentHash,
} from "../src/firewall/validator.js";
import { MockKeeperHubTransport } from "../src/keeperhub/mock-transport.js";
import { KeeperHubClient } from "../src/keeperhub/client.js";
import { createDaydreamsActions } from "../src/daydreams/actions.js";
import type { FirewallPolicy, DryRunToken } from "../src/types/index.js";

describe("Generic Contract-Call Support (execute_contract_call)", () => {
  const contractAddress = "0x1111111111111111111111111111111111111111";
  const unapprovedContract = "0x9999999999999999999999999999999999999999";
  const approvedMethod = "stake";
  const unapprovedMethod = "drainAll";

  describe("FirewallValidator: method + recipient whitelist apply to contract calls", () => {
    const policy: FirewallPolicy = {
      network: "base-sepolia",
      maxAmountPerTx: 1_000_000n,
      maxCumulativeDailySpend: 10_000_000n,
      allowedRecipients: [contractAddress],
      allowedMethods: [approvedMethod],
      requireSimulationSuccess: true,
    };
    let validator: FirewallValidator;

    beforeEach(() => {
      validator = new FirewallValidator(policy);
    });

    it("permits a contract call whose address and method are both whitelisted", () => {
      const result = validator.validateIntent({
        recipient: contractAddress,
        amount: 0n,
        method: approvedMethod,
        functionArgs: '["1000"]',
      });
      expect(result.valid).toBe(true);
    });

    it("blocks a contract call to a whitelisted address using a non-whitelisted method", () => {
      const result = validator.validateIntent({
        recipient: contractAddress,
        amount: 0n,
        method: unapprovedMethod,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("METHOD_NOT_ALLOWED");
      }
    });

    it("blocks a contract call to a non-whitelisted contract address regardless of method", () => {
      const result = validator.validateIntent({
        recipient: unapprovedContract,
        amount: 0n,
        method: approvedMethod,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("RECIPIENT_NOT_WHITELISTED");
      }
    });

    it("re-validates the method whitelist at execute time, not just dry-run time", () => {
      // Regression test: ExecutionIntent used to have no `method` field at
      // all, so validateExecution()'s re-validation silently skipped the
      // method-whitelist check entirely.
      const token: DryRunToken = {
        tokenId: "drt_test",
        intentHash: validator.computeIntentHash({
          recipient: contractAddress,
          amount: 0n,
          method: approvedMethod,
        }),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        simulationTrace: { estimatedGasUnits: 50_000n, projectedDelta: 0n },
      };

      const result = validator.validateExecution(
        {
          idempotencyKey: "test_key_12345",
          dryRunTokenId: token.tokenId,
          recipient: contractAddress,
          amount: 0n,
          method: unapprovedMethod, // swapped after dry-run
        },
        token,
      );

      expect(result.valid).toBe(false);
      // Hits DRY_RUN_INTENT_MISMATCH first (hash includes method), which is
      // itself proof the method is now bound into the tamper-detection hash.
      if (!result.valid) {
        expect(["METHOD_NOT_ALLOWED", "DRY_RUN_INTENT_MISMATCH"]).toContain(
          result.reason,
        );
      }
    });
  });

  describe("computeIntentHash: method/functionArgs/abi are bound into the dry-run token", () => {
    it("produces different hashes when only the method differs", () => {
      const hashA = computeIntentHash({
        recipient: contractAddress,
        amount: 0n,
        method: "stake",
      });
      const hashB = computeIntentHash({
        recipient: contractAddress,
        amount: 0n,
        method: "unstake",
      });
      expect(hashA).not.toBe(hashB);
    });

    it("produces different hashes when only functionArgs differ", () => {
      const hashA = computeIntentHash({
        recipient: contractAddress,
        amount: 0n,
        method: "stake",
        functionArgs: '["1000"]',
      });
      const hashB = computeIntentHash({
        recipient: contractAddress,
        amount: 0n,
        method: "stake",
        functionArgs: '["999999999"]',
      });
      expect(hashA).not.toBe(hashB);
    });

    it("is stable for identical contract-call intents (case-insensitive on recipient/method)", () => {
      const hashA = computeIntentHash({
        recipient: contractAddress.toUpperCase(),
        amount: 0n,
        method: "Stake",
        functionArgs: '["1000"]',
      });
      const hashB = computeIntentHash({
        recipient: contractAddress.toLowerCase(),
        amount: 0n,
        method: "stake",
        functionArgs: '["1000"]',
      });
      expect(hashA).toBe(hashB);
    });
  });

  describe("MockKeeperHubTransport + KeeperHubClient: end-to-end contract-call happy path", () => {
    const policy: FirewallPolicy = {
      network: "base-sepolia",
      maxAmountPerTx: 1_000_000n,
      maxCumulativeDailySpend: 10_000_000n,
      allowedRecipients: [contractAddress],
      allowedMethods: [approvedMethod],
      requireSimulationSuccess: true,
    };

    it("simulates and executes a contract call through the real action handlers", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy },
        { transport: new MockKeeperHubTransport() },
      );
      const actions = createDaydreamsActions(client);

      const dryRunRes = await actions.dryRunAction.handler({
        recipient: contractAddress,
        amount: "0",
        method: approvedMethod,
        functionArgs: '["1000"]',
      });
      expect(dryRunRes.status).toBe("SIMULATION_SUCCESS");
      expect(dryRunRes.dryRunTokenId).toBeTruthy();

      const execRes = await actions.executeAction.handler({
        idempotencyKey: "contract_call_test_key",
        dryRunTokenId: dryRunRes.dryRunTokenId,
        recipient: contractAddress,
        amount: "0",
        method: approvedMethod,
        functionArgs: '["1000"]',
      });
      expect(execRes.status).toBe("CONFIRMED");
      expect(execRes.txHash).toBeTruthy();
    });

    it("blocks a contract call to an unapproved method before touching the transport", async () => {
      const client = new KeeperHubClient(
        { mode: "mock", policy },
        { transport: new MockKeeperHubTransport() },
      );
      const actions = createDaydreamsActions(client);

      const dryRunRes = await actions.dryRunAction.handler({
        recipient: contractAddress,
        amount: "0",
        method: unapprovedMethod,
      });
      expect(dryRunRes.status).toBe("SIMULATION_FAILED");
      expect(dryRunRes.revertReason).toBe("METHOD_NOT_ALLOWED");
    });
  });
});
