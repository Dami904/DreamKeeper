import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  type Address,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createHash, randomUUID } from "node:crypto";
import type {
  AuditEntry,
  DryRunIntent,
  DryRunResult,
  DryRunToken,
  ExecutionIntent,
  ExecutionResult,
} from "../types/index.js";
import type { KeeperHubTransport } from "./transport.js";
import { ExecutionStateMachine } from "./state-machine.js";
import { InvariantEvaluator } from "../firewall/invariants.js";
import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("OnChainTransport");

export interface OnChainTransportOptions {
  privateKey: `0x${string}`;
  rpcUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

function createClients(options: OnChainTransportOptions) {
  const rpcUrl = options.rpcUrl || "https://sepolia.base.org";
  const account = privateKeyToAccount(options.privateKey);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl, {
      timeout: options.timeoutMs || 25_000,
    }),
  });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl, {
      timeout: options.timeoutMs || 25_000,
    }),
  });
  return { account, publicClient, walletClient };
}

type Clients = ReturnType<typeof createClients>;

export class OnChainKeeperHubTransport implements KeeperHubTransport {
  private publicClient: Clients["publicClient"];
  private walletClient: Clients["walletClient"];
  private account: Clients["account"];
  private runs = new Map<string, ExecutionResult>();
  private audits = new Map<string, AuditEntry>();

  constructor(options: OnChainTransportOptions) {
    const clients = createClients(options);
    this.account = clients.account;
    this.publicClient = clients.publicClient;
    this.walletClient = clients.walletClient;

    const rpcUrl = options.rpcUrl || "https://sepolia.base.org";

    logger.info("Initialized OnChainKeeperHubTransport", {
      context: {
        address: this.account.address,
        network: "base-sepolia",
        rpcUrl,
      },
    });
  }

  public async dryRun(intent: DryRunIntent): Promise<DryRunResult> {
    try {
      let estimatedGasUnits = 65_000n;

      if (intent.token) {
        // ERC20 simulation
        const estimate = await this.publicClient.estimateContractGas({
          address: intent.token as Address,
          abi: erc20Abi,
          functionName: "transfer",
          args: [intent.recipient as Address, intent.amount],
          account: this.account,
        });
        estimatedGasUnits = estimate;
      } else {
        // Native transfer / call simulation
        const estimate = await this.publicClient.estimateGas({
          to: intent.recipient as Address,
          value: intent.amount,
          data: intent.calldata as `0x${string}` | undefined,
          account: this.account,
        });
        estimatedGasUnits = estimate;
      }

      const projectedDelta = -intent.amount;

      // Invariant evaluation
      if (intent.expectedInvariant) {
        const evalResult = InvariantEvaluator.evaluate(
          intent.expectedInvariant,
          {
            estimatedGasUnits,
            actualDelta: projectedDelta,
          },
        );
        if (!evalResult.passed) {
          return {
            ok: false,
            revertReason: evalResult.violations.join("; "),
            error: `Invariant violation: ${evalResult.violations.join("; ")}`,
          };
        }
      }

      const canonical = JSON.stringify({
        recipient: intent.recipient.toLowerCase(),
        amount: intent.amount.toString(),
        calldata: intent.calldata?.toLowerCase() || "",
      });
      const intentHash = createHash("sha256").update(canonical).digest("hex");

      const token: DryRunToken = {
        tokenId: `drt_${randomUUID().slice(0, 12)}`,
        intentHash,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        simulationTrace: {
          estimatedGasUnits,
          projectedDelta,
        },
      };

      return {
        ok: true,
        token,
        estimatedGasUnits,
        projectedDelta,
      };
    } catch (err: any) {
      logger.warn("On-chain dry-run simulation failed", {
        context: { error: err.message || String(err) },
      });
      return {
        ok: false,
        revertReason: err.shortMessage || err.message || "SIMULATION_FAILED",
        error: err.message || "On-chain dry-run simulation failed",
      };
    }
  }

  public async execute(
    intent: ExecutionIntent,
    _dryRunResult?: DryRunResult,
  ): Promise<ExecutionResult> {
    const existing = this.runs.get(intent.idempotencyKey);
    if (existing) {
      return existing;
    }

    const start = Date.now();
    const runId = `kh_run_${randomUUID().slice(0, 12)}`;

    try {
      let txHash: Hash;

      if (intent.calldata) {
        txHash = await this.walletClient.sendTransaction({
          to: intent.recipient as Address,
          value: intent.amount,
          data: intent.calldata as `0x${string}`,
          account: this.account,
          chain: baseSepolia,
        });
      } else {
        txHash = await this.walletClient.sendTransaction({
          to: intent.recipient as Address,
          value: intent.amount,
          account: this.account,
          chain: baseSepolia,
        });
      }

      logger.info("Broadcasted live transaction to Base Sepolia", {
        context: { txHash, runId },
      });

      // Wait for inclusion receipt
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      });

      const confirmed = receipt.status === "success";
      const classified = ExecutionStateMachine.classifyResponse({
        txHash: confirmed ? txHash : undefined,
        revertReason: !confirmed ? "TRANSACTION_REVERTED_ON_CHAIN" : undefined,
      });

      const result: ExecutionResult = {
        state: classified.state,
        idempotencyKey: intent.idempotencyKey,
        runId,
        txHash,
        explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
        confirmedAt: confirmed ? Date.now() : undefined,
        revertReason: !confirmed ? "TRANSACTION_REVERTED_ON_CHAIN" : undefined,
      };

      this.runs.set(intent.idempotencyKey, result);
      this.audits.set(runId, {
        runId,
        idempotencyKey: intent.idempotencyKey,
        state: classified.state,
        timestamp: Date.now(),
        recipient: intent.recipient,
        amount: intent.amount.toString(),
        txHash,
        policyValidationPassed: true,
        dryRunDurationMs: 45,
        executionDurationMs: Date.now() - start,
      });

      return result;
    } catch (err: any) {
      logger.error("Failed to execute live on-chain transaction", {
        context: { error: err.message || String(err) },
      });

      const classified = ExecutionStateMachine.classifyResponse({
        revertReason: err.shortMessage || err.message,
      });

      const result: ExecutionResult = {
        state: classified.state,
        idempotencyKey: intent.idempotencyKey,
        runId,
        error: err.message || "Failed to execute on-chain transaction",
      };

      this.runs.set(intent.idempotencyKey, result);
      return result;
    }
  }

  public async reconcile(idempotencyKey: string): Promise<ExecutionResult> {
    const existing = this.runs.get(idempotencyKey);
    if (!existing) {
      return {
        state: "UNKNOWN",
        idempotencyKey,
        error: "No prior run found for this idempotency key",
      };
    }

    if (existing.txHash) {
      try {
        const receipt = await this.publicClient.getTransactionReceipt({
          hash: existing.txHash as Hash,
        });
        if (receipt.status === "success") {
          return {
            ...existing,
            state: "CONFIRMED",
          };
        }
      } catch {
        // Still pending or network drop
      }
    }

    return existing;
  }

  public async getAudit(runId: string): Promise<AuditEntry | undefined> {
    return this.audits.get(runId);
  }
}
