import { createPublicClient, http, formatEther, formatUnits, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";

const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "0xDd9E6DF0542A69995ABA5E6604BbDa89FfD8B2C1";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
});

async function main() {
  console.log("\n===================================================================");
  console.log("  CHECKING LIVE BASE SEPOLIA VAULT WALLET BALANCES");
  console.log("===================================================================");
  console.log(`Vault Address: ${VAULT_ADDRESS}`);
  console.log(`RPC Endpoint:  ${RPC_URL}`);

  try {
    const ethBalance = await publicClient.getBalance({
      address: VAULT_ADDRESS,
    });
    console.log(`Vault ETH Balance:  ${formatEther(ethBalance)} ETH`);

    const usdcBalance = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [VAULT_ADDRESS],
    });
    console.log(`Vault USDC Balance: ${formatUnits(usdcBalance, 6)} USDC`);
    console.log("===================================================================\n");
  } catch (err) {
    console.error("Error querying vault balances:", err);
  }
}

main();
