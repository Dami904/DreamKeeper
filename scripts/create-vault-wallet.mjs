import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";

// 1. Generate new EVM private key and derive vault address
const vaultPrivateKey = generatePrivateKey();
const vaultAccount = privateKeyToAccount(vaultPrivateKey);
const vaultAddress = vaultAccount.address;

// 2. Read existing .env file
const envPath = path.join(process.cwd(), ".env");
let envContent = "";
if (fs.existsSync(envPath)) {
  envContent = fs.readFileSync(envPath, "utf-8");
}

// Remove any existing VAULT_ADDRESS and VAULT_PRIVATE_KEY lines
const lines = envContent.split("\n").filter(
  (line) => !line.startsWith("VAULT_ADDRESS=") && !line.startsWith("VAULT_PRIVATE_KEY=")
);

// Append new vault config
lines.push(`VAULT_ADDRESS=${vaultAddress}`);
lines.push(`VAULT_PRIVATE_KEY=${vaultPrivateKey}`);

fs.writeFileSync(envPath, lines.join("\n"), "utf-8");

// 3. Update agent.ts default vault fallback to this new address
const agentPath = path.join(process.cwd(), "examples", "demo-agent", "src", "agent.ts");
let agentCode = fs.readFileSync(agentPath, "utf-8");
agentCode = agentCode.replace(
  /export const DEMO_APPROVED_VAULT = [^;]+;/,
  `export const DEMO_APPROVED_VAULT =\n  process.env["VAULT_ADDRESS"] || "${vaultAddress}";`
);
fs.writeFileSync(agentPath, agentCode, "utf-8");

// 4. Print ONLY the public address and details (never private key)
console.log("\n===================================================================");
console.log("  NEW VAULT WALLET GENERATED AND CONFIGURED IN .env");
console.log("===================================================================");
console.log(`Vault Address:   ${vaultAddress}`);
console.log(`Network:         Base Sepolia (Chain ID: 84532)`);
console.log(`Explorer:        https://sepolia.basescan.org/address/${vaultAddress}`);
console.log("-------------------------------------------------------------------");
console.log("Secrets Status:  VAULT_PRIVATE_KEY saved directly to .env on disk.");
console.log("                 (Zero secret leakage into agent context)");
console.log("Agent Whitelist: DEMO_APPROVED_VAULT updated to this vault address.");
console.log("===================================================================\n");
