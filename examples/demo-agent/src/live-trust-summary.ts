import { dreamkeeperExtension, type FirewallPolicy } from "@dreamkeeper/core";

/**
 * Live demo of keeperhub_get_trust_summary: triggers one real firewall
 * block and one real confirmed execution, then reads back the local trust
 * ledger to show both are reflected. Scripted, not LLM-driven — this is
 * about the ledger's own wiring, not model behavior.
 */

const VAULT =
  process.env["VAULT_ADDRESS"] || "0xDd9E6DF0542A69995ABA5E6604BbDa89FfD8B2C1";
const USDC_ADDRESS =
  process.env["USDC_ADDRESS"] || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ATTACKER = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";

const policy: FirewallPolicy = {
  network: "base-sepolia",
  maxAmountPerTx: 25_000_000n,
  maxCumulativeDailySpend: 100_000_000n,
  allowedRecipients: [VAULT, USDC_ADDRESS],
  requireSimulationSuccess: true,
};

async function main() {
  const isLive = process.argv.includes("--live");

  console.log(
    "\n===================================================================",
  );
  console.log(
    `  AGENT TRUST SUMMARY DEMO [${isLive ? "LIVE" : "MOCK"}]: keeperhub_get_trust_summary`,
  );
  console.log(
    "===================================================================\n",
  );

  const extension = dreamkeeperExtension({
    mode: isLive ? "live" : "mock",
    policy,
    endpoint:
      process.env["KEEPERHUB_MCP_URL"] || "https://app.keeperhub.com/mcp",
    apiKey: process.env["KEEPERHUB_API_KEY"],
    privateKey: process.env["PRIVATE_KEY"],
    rpcUrl: process.env["RPC_URL"] || "https://sepolia.base.org",
  });
  const actions = extension.actionsMap;

  console.log(
    "--- Step 1: a rogue attempt — unwhitelisted recipient, expected blocked ---",
  );
  const blocked = await actions.dryRunAction.handler({
    recipient: ATTACKER,
    amount: "10000000",
  });
  console.log("[keeperhub_dry_run result]:", blocked);

  console.log("\n--- Step 2: a legitimate transfer to the approved vault ---");
  const dryRun = await actions.dryRunAction.handler({
    recipient: VAULT,
    amount: "1000000",
    token: USDC_ADDRESS,
  });
  console.log("[keeperhub_dry_run result]:", dryRun);

  if (dryRun.status === "SIMULATION_SUCCESS") {
    const exec = await actions.executeAction.handler({
      idempotencyKey: `dk_trust_demo_${Date.now()}`,
      dryRunTokenId: dryRun.dryRunTokenId,
      recipient: VAULT,
      amount: "1000000",
      token: USDC_ADDRESS,
    });
    console.log("[keeperhub_execute result]:", exec);
  }

  console.log("\n--- Step 3: read the trust summary back ---");
  const summary = await actions.getTrustSummaryAction.handler({});
  console.log("[keeperhub_get_trust_summary result]:", summary);

  console.log(
    "\n===================================================================",
  );
  console.log("  DONE");
  console.log(
    "===================================================================\n",
  );
}

main().catch((err) => {
  console.error("live-trust-summary run failed:", err);
  process.exit(1);
});
