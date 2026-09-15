import { describe, it, expect, vi, beforeEach } from "vitest";
import { exceedsGasCeiling } from "../src/keeperhub/onchain-transport.js";

describe("Gas-price ceiling on the direct-signer (on-chain) fallback", () => {
  describe("exceedsGasCeiling (pure function)", () => {
    it("never blocks when no ceiling is configured", () => {
      expect(exceedsGasCeiling(999_999_999_999n, undefined)).toBe(false);
    });

    it("blocks when the current gas price exceeds the ceiling", () => {
      // 50 gwei ceiling, current price 51 gwei
      expect(exceedsGasCeiling(51_000_000_000n, 50)).toBe(true);
    });

    it("does not block when the current gas price is under the ceiling", () => {
      expect(exceedsGasCeiling(49_000_000_000n, 50)).toBe(false);
    });

    it("does not block when the current gas price exactly equals the ceiling", () => {
      expect(exceedsGasCeiling(50_000_000_000n, 50)).toBe(false);
    });
  });

  describe("OnChainKeeperHubTransport.dryRun with a mocked RPC", () => {
    const estimateGas = vi.fn();
    const getGasPrice = vi.fn();

    beforeEach(() => {
      vi.resetModules();
      estimateGas.mockReset();
      getGasPrice.mockReset();
    });

    it("returns GAS_PRICE_EXCEEDS_CEILING when the mocked RPC gas price is above the configured ceiling", async () => {
      estimateGas.mockResolvedValue(21_000n);
      getGasPrice.mockResolvedValue(100_000_000_000n); // 100 gwei

      vi.doMock("viem", async (importOriginal) => {
        const actual = await importOriginal<typeof import("viem")>();
        return {
          ...actual,
          createPublicClient: () => ({ estimateGas, getGasPrice }),
          createWalletClient: () => ({}),
        };
      });

      const { OnChainKeeperHubTransport } =
        await import("../src/keeperhub/onchain-transport.js");
      const transport = new OnChainKeeperHubTransport({
        privateKey:
          "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
        maxGasPriceGwei: 50,
      });

      const result = await transport.dryRun({
        recipient: "0x9999999999999999999999999999999999999999",
        amount: 1_000_000n,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.revertReason).toBe("GAS_PRICE_EXCEEDS_CEILING");
      }
    });

    it("passes through normally when the mocked RPC gas price is under the ceiling", async () => {
      estimateGas.mockResolvedValue(21_000n);
      getGasPrice.mockResolvedValue(10_000_000_000n); // 10 gwei

      vi.doMock("viem", async (importOriginal) => {
        const actual = await importOriginal<typeof import("viem")>();
        return {
          ...actual,
          createPublicClient: () => ({ estimateGas, getGasPrice }),
          createWalletClient: () => ({}),
        };
      });

      const { OnChainKeeperHubTransport } =
        await import("../src/keeperhub/onchain-transport.js");
      const transport = new OnChainKeeperHubTransport({
        privateKey:
          "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
        maxGasPriceGwei: 50,
      });

      const result = await transport.dryRun({
        recipient: "0x9999999999999999999999999999999999999999",
        amount: 1_000_000n,
      });

      expect(result.ok).toBe(true);
      expect(getGasPrice).toHaveBeenCalledTimes(1);
    });

    it("never calls getGasPrice when maxGasPriceGwei is unset", async () => {
      estimateGas.mockResolvedValue(21_000n);

      vi.doMock("viem", async (importOriginal) => {
        const actual = await importOriginal<typeof import("viem")>();
        return {
          ...actual,
          createPublicClient: () => ({ estimateGas, getGasPrice }),
          createWalletClient: () => ({}),
        };
      });

      const { OnChainKeeperHubTransport } =
        await import("../src/keeperhub/onchain-transport.js");
      const transport = new OnChainKeeperHubTransport({
        privateKey:
          "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
      });

      const result = await transport.dryRun({
        recipient: "0x9999999999999999999999999999999999999999",
        amount: 1_000_000n,
      });

      expect(result.ok).toBe(true);
      expect(getGasPrice).not.toHaveBeenCalled();
    });
  });

  describe("OnChainKeeperHubTransport.execute confirmation depth", () => {
    const estimateGas = vi.fn();
    const sendTransaction = vi.fn();
    const waitForTransactionReceipt = vi.fn();
    const testTxHash =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    beforeEach(() => {
      vi.resetModules();
      estimateGas.mockReset();
      sendTransaction.mockReset();
      waitForTransactionReceipt.mockReset();
      sendTransaction.mockResolvedValue(testTxHash);
      waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    });

    it("waits for exactly 1 confirmation by default (requiredConfirmations unset)", async () => {
      vi.doMock("viem", async (importOriginal) => {
        const actual = await importOriginal<typeof import("viem")>();
        return {
          ...actual,
          createPublicClient: () => ({
            estimateGas,
            waitForTransactionReceipt,
          }),
          createWalletClient: () => ({ sendTransaction }),
        };
      });

      const { OnChainKeeperHubTransport } =
        await import("../src/keeperhub/onchain-transport.js");
      const transport = new OnChainKeeperHubTransport({
        privateKey:
          "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
      });

      await transport.execute({
        idempotencyKey: "confirmation_depth_default_key",
        dryRunTokenId: "drt_test",
        recipient: "0x9999999999999999999999999999999999999999",
        amount: 1_000_000n,
      });

      expect(waitForTransactionReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ confirmations: 1 }),
      );
    });

    it("waits for the configured number of confirmations when requiredConfirmations is set", async () => {
      vi.doMock("viem", async (importOriginal) => {
        const actual = await importOriginal<typeof import("viem")>();
        return {
          ...actual,
          createPublicClient: () => ({
            estimateGas,
            waitForTransactionReceipt,
          }),
          createWalletClient: () => ({ sendTransaction }),
        };
      });

      const { OnChainKeeperHubTransport } =
        await import("../src/keeperhub/onchain-transport.js");
      const transport = new OnChainKeeperHubTransport({
        privateKey:
          "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
        confirmationsRequired: 5,
      });

      await transport.execute({
        idempotencyKey: "confirmation_depth_configured_key",
        dryRunTokenId: "drt_test",
        recipient: "0x9999999999999999999999999999999999999999",
        amount: 1_000_000n,
      });

      expect(waitForTransactionReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ confirmations: 5 }),
      );
    });
  });
});
