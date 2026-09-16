import { dreamkeeperExtension, type FirewallPolicy } from "@dreamkeeper/core";

/**
 * Exercises the two execution-shaped KeeperHub actions that run-demo.ts/
 * test-end-to-end-full.ts don't cover: keeperhub_check_and_execute (which has
 * a real dry-run step, so it's safe to iterate on) and keeperhub_protocol_action
 * (which has NO dry-run step — it broadcasts immediately once the actionType
 * is firewall-approved, so a bad param guess reverts live rather than
 * failing a free simulation).
 *
 * Scripted, not LLM-driven — this is about proving the action types
 * themselves broadcast for real, not about model behavior.
 */

const VAULT =
  process.env["VAULT_ADDRESS"] || "0xDd9E6DF0542A69995ABA5E6604BbDa89FfD8B2C1";
const USDC_ADDRESS =
  process.env["USDC_ADDRESS"] || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// Aave's Base Sepolia market uses its own isolated faucet-only USDC — NOT
// the same contract as Circle's canonical Base Sepolia USDC above. See
// docs/API_NOTES.md. Confirmed the wallet holds this token before use.
const AAVE_USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
// Pulled from the "to" field of a live revert this session — this is the
// real Aave V3 Pool contract KeeperHub calls for aave-v3/supply on 84532.
const AAVE_POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
// Tempo (a separate stablecoin-payments EVM chain) test token, per
// docs/API_NOTES.md — pathUSD on tempo-testnet.
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const WALLET_ADDRESS = process.env["WALLET_ADDRESS"];

if (!WALLET_ADDRESS) {
  throw new Error("WALLET_ADDRESS is not set in .env");
}

const policy: FirewallPolicy = {
  network: "base-sepolia",
  maxAmountPerTx: 25_000_000n,
  maxCumulativeDailySpend: 100_000_000n,
  allowedRecipients: [VAULT, USDC_ADDRESS, AAVE_USDC],
  requireSimulationSuccess: true,
  allowedProtocolActions: ["aave-v3/supply"],
  allowedTempoNetworks: ["tempo-testnet"],
  allowedTempoTokens: [PATH_USD],
  maxTempoAmountPerHold: 10,
  maxTempoCumulativeDailySpend: 50,
};

function randomIdempotencyKey(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function runCheckAndExecute(
  extension: ReturnType<typeof dreamkeeperExtension>,
) {
  console.log(
    "\n----------------------------------------------------------------------------------",
  );
  console.log(
    "  ACTION: keeperhub_check_and_execute (read USDC balance, then transfer if condition holds)",
  );
  console.log(
    "----------------------------------------------------------------------------------",
  );

  const actions = extension.actionsMap;

  const shared = {
    checkContractAddress: USDC_ADDRESS,
    checkFunctionName: "balanceOf",
    checkFunctionArgs: JSON.stringify([WALLET_ADDRESS]),
    operator: "gte" as const,
    conditionValue: "0", // trivially true — proving the mechanism, not gating on a real threshold
    actionContractAddress: USDC_ADDRESS,
    actionFunctionName: "transfer",
    actionFunctionArgs: JSON.stringify([VAULT, "1000000"]), // 1 USDC
  };

  console.log(
    "[Daydreams Action Call] keeperhub_check_and_execute_dry_run:",
    shared,
  );

  const dryRunRes = await actions.checkAndExecuteDryRunAction.handler(shared);
  console.log("[KeeperHub Response]:", dryRunRes);

  if (dryRunRes.status !== "SIMULATION_SUCCESS" || !dryRunRes.dryRunTokenId) {
    console.error(
      "  => check_and_execute dry-run did not succeed. Not broadcasting. See response above for the revert reason.",
    );
    return;
  }

  const idempotencyKey = randomIdempotencyKey("dk_cae");
  const execPayload = {
    ...shared,
    idempotencyKey,
    dryRunTokenId: dryRunRes.dryRunTokenId,
  };

  console.log(
    "[Daydreams Action Call] keeperhub_check_and_execute:",
    execPayload,
  );
  const execRes = await actions.checkAndExecuteAction.handler(execPayload);
  console.log("[KeeperHub Response]:", execRes);

  if (execRes.status === "CONFIRMED") {
    console.log(`  => SUCCESS. Tx: ${execRes.txHash}`);
    console.log(`  => Explorer: ${execRes.explorerUrl}`);
  } else {
    console.log(`  => Did not confirm. Status: ${execRes.status}`);
  }
}

async function runApprove(extension: ReturnType<typeof dreamkeeperExtension>) {
  console.log(
    "\n----------------------------------------------------------------------------------",
  );
  console.log(
    "  ACTION: keeperhub_execute (ERC20 approve — Aave's Pool needs an allowance before supply)",
  );
  console.log(
    "----------------------------------------------------------------------------------",
  );

  const actions = extension.actionsMap;
  const dryRunPayload = {
    recipient: AAVE_USDC,
    amount: "0",
    method: "approve",
    functionArgs: JSON.stringify([AAVE_POOL, "1000000"]),
  };

  console.log("[Daydreams Action Call] keeperhub_dry_run:", dryRunPayload);
  const dryRunRes = await actions.dryRunAction.handler(dryRunPayload);
  console.log("[KeeperHub Response]:", dryRunRes);

  if (dryRunRes.status !== "SIMULATION_SUCCESS" || !dryRunRes.dryRunTokenId) {
    console.error("  => approve dry-run did not succeed. Not broadcasting.");
    return false;
  }

  const idempotencyKey = randomIdempotencyKey("dk_appr");
  const execPayload = {
    idempotencyKey,
    dryRunTokenId: dryRunRes.dryRunTokenId,
    ...dryRunPayload,
  };
  console.log("[Daydreams Action Call] keeperhub_execute:", execPayload);
  const execRes = await actions.executeAction.handler(execPayload);
  console.log("[KeeperHub Response]:", execRes);

  if (execRes.status === "CONFIRMED") {
    console.log(`  => SUCCESS. Tx: ${execRes.txHash}`);
    return true;
  }
  console.log(`  => Did not confirm. Status: ${execRes.status}`);
  return false;
}

async function runProtocolAction(
  extension: ReturnType<typeof dreamkeeperExtension>,
) {
  console.log(
    "\n----------------------------------------------------------------------------------",
  );
  console.log(
    "  ACTION: keeperhub_protocol_action (aave-v3/supply — broadcasts immediately, no dry-run)",
  );
  console.log(
    "----------------------------------------------------------------------------------",
  );

  const actions = extension.actionsMap;
  const idempotencyKey = randomIdempotencyKey("dk_pa");
  const payload = {
    idempotencyKey,
    actionType: "aave-v3/supply",
    paramsJson: JSON.stringify({
      network: "84532",
      asset: AAVE_USDC,
      amount: "1000000", // 1 USDC
      onBehalfOf: WALLET_ADDRESS,
    }),
  };

  console.log("[Daydreams Action Call] keeperhub_protocol_action:", payload);
  const result = await actions.protocolActionAction.handler(payload);
  console.log("[KeeperHub Response]:", result);

  if (result.status === "CONFIRMED") {
    console.log(
      `  => SUCCESS. ${result.txHash ? `Tx: ${result.txHash}` : `Result: ${result.resultValue}`}`,
    );
    if (result.explorerUrl) console.log(`  => Explorer: ${result.explorerUrl}`);
  } else {
    console.log(`  => Did not confirm. Status: ${result.status}`);
  }
}

async function runTempoHoldAndRelease(
  extension: ReturnType<typeof dreamkeeperExtension>,
) {
  console.log(
    "\n----------------------------------------------------------------------------------",
  );
  console.log(
    "  ACTION: keeperhub_tempo_sign_and_hold + keeperhub_tempo_release_hold (separate Tempo chain)",
  );
  console.log(
    "----------------------------------------------------------------------------------",
  );

  const actions = extension.actionsMap;
  const holdPayload = {
    idempotencyKey: randomIdempotencyKey("dk_tempo"),
    network: "tempo-testnet",
    tokenAddress: PATH_USD,
    tokenSymbol: "pathUSD",
    amount: "1",
    recipient: VAULT,
  };

  console.log(
    "[Daydreams Action Call] keeperhub_tempo_sign_and_hold:",
    holdPayload,
  );
  const holdRes = await actions.tempoSignAndHoldAction.handler(holdPayload);
  console.log("[KeeperHub Response]:", holdRes);

  if (holdRes.status !== "HOLD_CREATED" || !holdRes.paymentId) {
    console.error("  => Hold was not created. Not releasing.");
    return;
  }

  console.log("[Daydreams Action Call] keeperhub_tempo_release_hold:", {
    paymentId: holdRes.paymentId,
  });
  const releaseRes = await actions.tempoReleaseHoldAction.handler({
    paymentId: holdRes.paymentId,
  });
  console.log("[KeeperHub Response]:", releaseRes);

  if (releaseRes.status === "CONFIRMED") {
    console.log(`  => SUCCESS. Tx: ${releaseRes.txHash}`);
    console.log(
      "  => Note: this settles on Tempo's own chain, not Base Sepolia — verify via https://rpc.moderato.tempo.xyz, not sepolia.base.org.",
    );
  } else {
    console.log(`  => Did not confirm. Status: ${releaseRes.status}`);
  }
}

async function main() {
  console.log(
    "\n===================================================================",
  );
  console.log("  LIVE: check-and-execute + protocol-action, real broadcasts");
  console.log(
    "===================================================================",
  );

  const extension = dreamkeeperExtension({
    mode: "live",
    policy,
    endpoint:
      process.env["KEEPERHUB_MCP_URL"] || "https://app.keeperhub.com/mcp",
    apiKey: process.env["KEEPERHUB_API_KEY"],
    privateKey: process.env["PRIVATE_KEY"],
    rpcUrl: process.env["RPC_URL"] || "https://sepolia.base.org",
  });

  const skipCheckAndExecute = process.argv.includes("--skip-cae");
  if (!skipCheckAndExecute) {
    try {
      await runCheckAndExecute(extension);
    } catch (err) {
      console.error("check-and-execute threw:", err);
    }
  }

  try {
    const approved = await runApprove(extension);
    if (approved) {
      await runProtocolAction(extension);
    } else {
      console.log("  => Skipping protocol-action: approve did not confirm.");
    }
  } catch (err) {
    console.error("approve/protocol-action threw:", err);
  }

  if (!process.argv.includes("--skip-tempo")) {
    try {
      await runTempoHoldAndRelease(extension);
    } catch (err) {
      console.error("tempo hold/release threw:", err);
    }
  }

  console.log(
    "\n===================================================================",
  );
  console.log("  DONE");
  console.log(
    "===================================================================\n",
  );
}

main().catch((err) => {
  console.error("live-all-actions run failed:", err);
  process.exit(1);
});
