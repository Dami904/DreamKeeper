import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";

// 1. Generate new EVM private key and derive public address
const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);
const address = account.address;

// 2. Format .env file content
const envContent = `# ===================================================================
# DREAMKEEPER BASE SEPOLIA LIVE CONFIGURATION
# NEVER COMMIT THIS FILE TO VERSION CONTROL
# ===================================================================

RPC_URL=https://sepolia.base.org
CHAIN_ID=84532

PRIVATE_KEY=${privateKey}
WALLET_ADDRESS=${address}

USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
VAULT_ADDRESS=0x742d35Cc6634C0532925a3b844Bc454e4438f44e

KEEPERHUB_API_KEY=
KEEPERHUB_MCP_URL=https://app.keeperhub.com/mcp
`;

// 3. Write securely to .env in repository root
const envPath = path.join(process.cwd(), ".env");
fs.writeFileSync(envPath, envContent, "utf-8");

// 4. Print ONLY the public address and funding instructions (Never print the private key)
console.log("\n===================================================================");
console.log("  BASE SEPOLIA WALLET GENERATED AND SAVED TO .env");
console.log("===================================================================");
console.log(`Public Address: ${address}`);
console.log(`Network:        Base Sepolia (Chain ID: 84532)`);
console.log(`Explorer:       https://sepolia.basescan.org/address/${address}`);
console.log("-------------------------------------------------------------------");
console.log("Secrets Status: PRIVATE_KEY written directly to .env on disk.");
console.log("                (Zero secret leakage into agent context)");
console.log("-------------------------------------------------------------------");
console.log("Fund this address with Base Sepolia testnet assets:");
console.log("  1. Base Sepolia ETH (Gas): https://faucets.chain.link/base-sepolia");
console.log("                             or https://console.optimism.io/faucet");
console.log("  2. Base Sepolia USDC:      https://faucet.circle.com/");
console.log("===================================================================\n");
