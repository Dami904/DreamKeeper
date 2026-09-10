import { dreamkeeperExtension, type FirewallPolicy } from "@dreamkeeper/core";

export const DEMO_APPROVED_VAULT = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
export const DEMO_ATTACKER_ADDRESS =
  "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";

export const demoPolicy: FirewallPolicy = {
  network: "base-sepolia",
  maxAmountPerTx: 25_000_000n, // 25 USDC (in 6-decimal units)
  maxCumulativeDailySpend: 100_000_000n, // 100 USDC per 24h
  allowedRecipients: [DEMO_APPROVED_VAULT],
  requireSimulationSuccess: true,
  dryRunTtlMs: 60_000, // 60s TTL
};

/**
 * Instantiates the DreamKeeper extension for the Daydreams agent
 */
export function createDemoExtension(mode: "mock" | "live" = "mock") {
  return dreamkeeperExtension({
    mode,
    policy: demoPolicy,
    endpoint:
      process.env["KEEPERHUB_MCP_URL"] || "https://app.keeperhub.com/mcp",
    apiKey: process.env["KEEPERHUB_API_KEY"],
    privateKey: process.env["PRIVATE_KEY"],
    rpcUrl: process.env["RPC_URL"] || "https://sepolia.base.org",
  });
}
