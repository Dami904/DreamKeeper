import { describe, it, expect } from "vitest";
import { MockKeeperHubTransport } from "../src/keeperhub/mock-transport.js";
import { OnChainKeeperHubTransport } from "../src/keeperhub/onchain-transport.js";
import { KeeperHubClient } from "../src/keeperhub/client.js";
import { createDaydreamsActions } from "../src/daydreams/actions.js";
import type { FirewallPolicy } from "../src/types/index.js";

describe("Spending Limits Support (get_spending_limits)", () => {
  const policy: FirewallPolicy = {
    network: "base-sepolia",
    maxAmountPerTx: 1_000_000n,
    maxCumulativeDailySpend: 10_000_000n,
    allowedRecipients: [],
    requireSimulationSuccess: true,
  };

  it("MockKeeperHubTransport returns a static generous limits shape", async () => {
    const transport = new MockKeeperHubTransport();
    const limits = await transport.getSpendingLimits();

    expect(limits).toBeDefined();
    expect(limits?.dailyCapWei).toBeUndefined();
    expect(limits?.effectiveDailyCapWei).toBe(20_000_000_000_000_000n);
    expect(limits?.effectiveDailySolanaCapLamports).toBe(500_000_000n);
    expect(limits?.usingDefaultDailyCap).toBe(true);
    expect(limits?.usingDefaultDailySolanaCap).toBe(true);
  });

  it("OnChainKeeperHubTransport has no organization-level cap concept", async () => {
    const transport = new OnChainKeeperHubTransport({
      rpcUrl: "http://localhost:8545",
      privateKey:
        "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
    });

    const limits = await transport.getSpendingLimits();
    expect(limits).toBeUndefined();
  });

  it("KeeperHubClient passes through the transport's spending limits", async () => {
    const client = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: new MockKeeperHubTransport() },
    );

    const limits = await client.getSpendingLimits();
    expect(limits?.effectiveDailyCapWei).toBe(20_000_000_000_000_000n);
  });

  it("keeperhub_get_spending_limits action returns the client's limits, unmodified by the firewall", async () => {
    const client = new KeeperHubClient(
      { mode: "mock", policy },
      { transport: new MockKeeperHubTransport() },
    );
    const actions = createDaydreamsActions(client);

    const result = await actions.getSpendingLimitsAction.handler({});

    expect(result.available).toBe(true);
    expect(result.effectiveDailyCapWei).toBe("20000000000000000");
    expect(result.effectiveDailySolanaCapLamports).toBe("500000000");
    expect(result.usingDefaultDailyCap).toBe(true);
    expect(result.dailyCapWei).toBeUndefined();
  });
});
