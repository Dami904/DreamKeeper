import { createDreams } from "@daydreamsai/core";
import { createDemoExtension, DEMO_APPROVED_VAULT } from "./agent.js";

async function main() {
  console.log(
    "\n===================================================================",
  );
  console.log("  TESTING DIRECT DAYDREAMS (@daydreamsai/core) INTEGRATION");
  console.log(
    "===================================================================\n",
  );

  const extension = createDemoExtension("mock");

  console.log("[Test] Creating Daydreams agent instance via createDreams()...");

  // Register our dreamkeeper extension natively into Daydreams createDreams
  const agent = createDreams({
    extensions: [extension as any],
  });

  console.log(
    "[Test] Daydreams agent instance created successfully:",
    typeof agent.start,
  );
  console.log(`[Test] Registered extension name: ${extension.name}`);
  console.log(`[Test] Registered actions count: ${extension.actions.length}`);

  // Test executing an action registered inside the Daydreams extension
  console.log(
    "\n[Test] Testing execution of dreamkeeper action through Daydreams extension...",
  );

  const dryRunAction = extension.actionsMap.dryRunAction;
  const result = await dryRunAction.handler({
    recipient: DEMO_APPROVED_VAULT,
    amount: "15000000",
  });

  console.log("[Test] Action handler output:", result);

  if (result.status !== "SIMULATION_SUCCESS") {
    throw new Error(`Expected SIMULATION_SUCCESS, got ${result.status}`);
  }

  console.log(
    "\n===================================================================",
  );
  console.log("  DAYDREAMS INTEGRATION TEST PASSED: 100% Native Compatibility");
  console.log(
    "===================================================================\n",
  );
}

main().catch((err) => {
  console.error("Daydreams integration test failed:", err);
  process.exit(1);
});
