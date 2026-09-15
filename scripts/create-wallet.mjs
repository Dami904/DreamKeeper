import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";

// 1. Refuse to clobber an existing .env — this script used to overwrite the
// whole file unconditionally, silently destroying any configured secrets
// (KEEPERHUB_API_KEY, OPENROUTER_API_KEY, a vault set up via
// create-vault-wallet.mjs, etc.) with zero warning.
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  console.error(
    "\n.env already exists — refusing to overwrite it.\n" +
      "Delete or rename it first if you really want a fresh wallet, or edit\n" +
      "PRIVATE_KEY/WALLET_ADDRESS in it directly.\n",
  );
  process.exit(1);
}

// 2. Generate new EVM private key and derive public address
const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);
const address = account.address;

// 3. Format .env file content. VAULT_ADDRESS is intentionally omitted here —
// use create-vault-wallet.mjs to generate one, or agent.ts's own
// DEMO_APPROVED_VAULT default is used if unset.
const envContent = `# ===================================================================
# DREAMKEEPER BASE SEPOLIA LIVE CONFIGURATION
# NEVER COMMIT THIS FILE TO VERSION CONTROL
# ===================================================================

RPC_URL=https://sepolia.base.org

PRIVATE_KEY=${privateKey}
WALLET_ADDRESS=${address}

USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e

KEEPERHUB_API_KEY=
KEEPERHUB_MCP_URL=https://app.keeperhub.com/mcp
`;

// 4. Write to .env in repository root
fs.writeFileSync(envPath, envContent, "utf-8");

// 5. Print ONLY the public address and funding instructions (Never print the private key)
console.log(
  "\n===================================================================",
);
console.log("  BASE SEPOLIA WALLET GENERATED AND SAVED TO .env");
console.log(
  "===================================================================",
);
console.log(`Public Address: ${address}`);
console.log(`Network:        Base Sepolia (Chain ID: 84532)`);
console.log(`Explorer:       https://sepolia.basescan.org/address/${address}`);
console.log(
  "-------------------------------------------------------------------",
);
console.log("Secrets Status: PRIVATE_KEY written directly to .env on disk.");
console.log("                (Zero secret leakage into agent context)");
console.log(
  "-------------------------------------------------------------------",
);
console.log("Fund this address with Base Sepolia testnet assets:");
console.log(
  "  1. Base Sepolia ETH (Gas): https://faucets.chain.link/base-sepolia",
);
console.log(
  "                             or https://console.optimism.io/faucet",
);
console.log("  2. Base Sepolia USDC:      https://faucet.circle.com/");
console.log(
  "===================================================================\n",
);
