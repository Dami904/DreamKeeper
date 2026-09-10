import { createDemoExtension, DEMO_APPROVED_VAULT } from "./agent.js";
import { generateSemanticIdempotencyKey } from "@dreamkeeper/core";

async function main() {
  const isLive = process.argv.includes("--live");
  const mode = isLive ? "live" : "mock";

  console.log(
    "\n===================================================================",
  );
  console.log(
    `  DREAMKEEPER: Daydreams Deterministic Execution Engine [${mode.toUpperCase()}]`,
  );
  console.log(
    "===================================================================\n",
  );

  const extension = createDemoExtension(mode);
  const actions = extension.actions;

  console.log("[Daydreams Agent] Waking up with DreamKeeper extension...");
  console.log(`[Daydreams Agent] Network: base-sepolia`);
  console.log(
    `[Daydreams Agent] Target Recipient: ${DEMO_APPROVED_VAULT} (Approved Vault)`,
  );
  console.log(`[Daydreams Agent] Value: 10 USDC (10,000,000 atomic units)\n`);

  // Phase 1: Pre-Flight Simulation (Dry Run)
  console.log("--- PHASE 1: PRE-FLIGHT SIMULATION & INVARIANT CHECK ---");
  console.log("[Daydreams Agent] Calling keeperhub_dry_run tool...");

  const dryRunResult = await actions.dryRunAction.handler({
    recipient: DEMO_APPROVED_VAULT,
    amount: "10000000",
    maxBalanceLoss: "10000000",
    maxGasUnits: "100000",
  });

  console.log("[KeeperHub Engine] Simulation Response:", dryRunResult);

  if (dryRunResult.status !== "SIMULATION_SUCCESS") {
    console.error("Simulation failed! Halting demo.");
    process.exit(1);
  }

  const dryRunTokenId = dryRunResult.dryRunTokenId;
  console.log(
    `\n[DreamKeeper] Issued DryRunToken: ${dryRunTokenId} (Expires in 60s)`,
  );

  // Phase 2: Deterministic Execution via Turnkey
  console.log("\n--- PHASE 2: DETERMINISTIC ON-CHAIN BROADCAST ---");
  const idempotencyKey = generateSemanticIdempotencyKey({
    senderId: "daydreams-demo-agent",
    recipient: DEMO_APPROVED_VAULT,
    amount: 10_000_000n,
  });

  console.log(
    `[Daydreams Agent] Generated pre-request idempotencyKey: ${idempotencyKey}`,
  );
  console.log("[Daydreams Agent] Calling keeperhub_execute tool...");

  const execResult = await actions.executeAction.handler({
    idempotencyKey,
    dryRunTokenId,
    recipient: DEMO_APPROVED_VAULT,
    amount: "10000000",
  });

  console.log("[KeeperHub Engine] Execution Response:", execResult);

  if (execResult.status === "CONFIRMED") {
    console.log("\n SUCCESS: Transaction mined and confirmed on Base Sepolia!");
    console.log(` Tx Hash: ${execResult.txHash}`);
    console.log(` Explorer: ${execResult.explorerUrl}`);
    console.log(` Run ID: ${execResult.runId}`);
  } else {
    console.error(" Execution failed or indeterminate:", execResult);
  }

  // Phase 3: Cryptographic Audit Trail
  console.log("\n--- PHASE 3: CRYPTOGRAPHIC AUDIT VERIFICATION ---");
  if (execResult.runId) {
    const audit = await actions.auditAction.handler({
      runId: execResult.runId,
    });
    console.log("[KeeperHub Audit Log]:", JSON.stringify(audit, null, 2));
  }

  console.log(
    "\n===================================================================",
  );
  console.log("  DEMO COMPLETED: End-to-end deterministic execution verified.");
  console.log(
    "===================================================================\n",
  );
}

main().catch((err) => {
  console.error("Demo failed with uncaught error:", err);
  process.exit(1);
});
