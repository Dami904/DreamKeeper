import { createPublicClient, http, formatEther, formatUnits, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";

const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "0xe059Fd2c94dFf59dcDe56576df34f0201C8F4bED";
const USDC_ADDRESS = (process.env.USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
});

async function main() {
  console.log("\n===================================================================");
  console.log("  CHECKING LIVE BASE SEPOLIA WALLET BALANCES");
  console.log("===================================================================");
  console.log(`Wallet Address: ${WALLET_ADDRESS}`);
  console.log(`RPC Endpoint:   ${RPC_URL}`);

  try {
    const ethBalance = await publicClient.getBalance({
      address: WALLET_ADDRESS,
    });
    console.log(`Base Sepolia ETH Balance:  ${formatEther(ethBalance)} ETH`);

    const usdcBalance = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [WALLET_ADDRESS],
    });
    console.log(`Base Sepolia USDC Balance: ${formatUnits(usdcBalance, 6)} USDC`);

    console.log("-------------------------------------------------------------------");
    if (ethBalance > 0n) {
      console.log("Status: READY FOR ON-CHAIN EXECUTION!");
    } else {
      console.log("Status: Awaiting funding from Base Sepolia faucet...");
    }
    console.log("===================================================================\n");
  } catch (err) {
    console.error("Error querying balances:", err);
  }
}

main();
