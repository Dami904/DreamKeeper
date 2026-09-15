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
import { randomUUID } from "node:crypto";
import type {
  AuditEntry,
  CheckAndExecuteCondition,
  CheckAndExecuteExecutionIntent,
  CheckAndExecuteIntent,
  DryRunIntent,
  DryRunResult,
  DryRunToken,
  ExecutionIntent,
  ExecutionResult,
  ProtocolActionIntent,
  SpendingLimits,
  TempoCancelResult,
  TempoHoldIntent,
  TempoHoldResult,
} from "../types/index.js";
import type { KeeperHubTransport } from "./transport.js";
import { ExecutionStateMachine } from "./state-machine.js";
import { InvariantEvaluator } from "../firewall/invariants.js";
import {
  computeCheckAndExecuteIntentHash,
  computeIntentHash,
} from "../firewall/validator.js";
import { StructuredLogger } from "../logger/index.js";

function evaluateCondition(
  actual: bigint,
  operator: CheckAndExecuteCondition["operator"],
  expected: bigint,
): boolean {
  switch (operator) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return actual > expected;
    case "lt":
      return actual < expected;
    case "gte":
      return actual >= expected;
    case "lte":
      return actual <= expected;
  }
}

const logger = new StructuredLogger("OnChainTransport");

export interface OnChainTransportOptions {
  privateKey: `0x${string}`;
  rpcUrl?: string | undefined;
  timeoutMs?: number | undefined;
  /** See FirewallPolicy.maxGasPriceGwei — undefined means no ceiling. */
  maxGasPriceGwei?: number | undefined;
}

/**
 * Pure comparison, exported for direct unit testing: does the current
 * network gas price exceed the configured ceiling? An unset ceiling never
 * blocks (matches every other optional FirewallPolicy cap in this codebase
 * that defaults to "not enforced" rather than "zero allowed").
 */
export function exceedsGasCeiling(
  currentGasPriceWei: bigint,
  maxGasPriceGwei: number | undefined,
): boolean {
  if (maxGasPriceGwei === undefined) {
    return false;
  }
  const ceilingWei = BigInt(Math.round(maxGasPriceGwei * 1e9));
  return currentGasPriceWei > ceilingWei;
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
  private maxGasPriceGwei: number | undefined;

  constructor(options: OnChainTransportOptions) {
    const clients = createClients(options);
    this.account = clients.account;
    this.publicClient = clients.publicClient;
    this.walletClient = clients.walletClient;
    this.maxGasPriceGwei = options.maxGasPriceGwei;

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

      if (intent.method) {
        // Generic contract-call simulation. Unlike KeeperHub's live path,
        // this fallback has no ABI auto-fetch for verified contracts, so an
        // explicit ABI is required.
        if (!intent.abi) {
          return {
            ok: false,
            revertReason: "ABI_REQUIRED",
            error:
              "The direct on-chain fallback requires an explicit ABI for contract calls (no ABI auto-fetch available outside KeeperHub).",
          };
        }
        let abi: unknown;
        let args: unknown[];
        try {
          abi = JSON.parse(intent.abi);
          args = intent.functionArgs ? JSON.parse(intent.functionArgs) : [];
        } catch {
          return {
            ok: false,
            revertReason: "INVALID_ABI_OR_ARGS",
            error: "abi and functionArgs must be valid JSON.",
          };
        }
        const estimate = await this.publicClient.estimateContractGas({
          address: intent.recipient as Address,
          abi: abi as any,
          functionName: intent.method,
          args: args as any,
          value: intent.amount,
          account: this.account,
        });
        estimatedGasUnits = estimate;
      } else if (intent.token) {
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

      // Gas-price ceiling — live network state, not part of the intent, so
      // it's checked here at the transport level (same category as the
      // invariant evaluation below) rather than in FirewallValidator.
      if (this.maxGasPriceGwei !== undefined) {
        const currentGasPriceWei = await this.publicClient.getGasPrice();
        if (exceedsGasCeiling(currentGasPriceWei, this.maxGasPriceGwei)) {
          logger.warn("On-chain dry-run blocked: gas price exceeds ceiling", {
            context: {
              currentGasPriceWei: currentGasPriceWei.toString(),
              maxGasPriceGwei: this.maxGasPriceGwei,
            },
          });
          return {
            ok: false,
            revertReason: "GAS_PRICE_EXCEEDS_CEILING",
            error: `Current network gas price (${currentGasPriceWei.toString()} wei) exceeds the configured ceiling (${this.maxGasPriceGwei} gwei).`,
          };
        }
      }

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

      const intentHash = computeIntentHash(intent);

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

      if (intent.method) {
        if (!intent.abi) {
          throw new Error(
            "The direct on-chain fallback requires an explicit ABI for contract calls (no ABI auto-fetch available outside KeeperHub).",
          );
        }
        const abi = JSON.parse(intent.abi);
        const args = intent.functionArgs ? JSON.parse(intent.functionArgs) : [];
        txHash = await this.walletClient.writeContract({
          address: intent.recipient as Address,
          abi,
          functionName: intent.method,
          args,
          value: intent.amount,
          account: this.account,
          chain: baseSepolia,
        });
      } else if (intent.token) {
        txHash = await this.walletClient.writeContract({
          address: intent.token as Address,
          abi: erc20Abi,
          functionName: "transfer",
          args: [intent.recipient as Address, intent.amount],
          account: this.account,
          chain: baseSepolia,
        });
      } else if (intent.calldata) {
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

  public async checkAndExecuteDryRun(
    intent: CheckAndExecuteIntent,
  ): Promise<DryRunResult> {
    try {
      if (!intent.check.abi || !intent.action.abi) {
        return {
          ok: false,
          revertReason: "ABI_REQUIRED",
          error:
            "The direct on-chain fallback requires explicit ABIs for both the check and the action (no ABI auto-fetch available outside KeeperHub).",
        };
      }

      const checkAbi = JSON.parse(intent.check.abi);
      const checkArgs = intent.check.functionArgs
        ? JSON.parse(intent.check.functionArgs)
        : [];
      const actualRaw = await this.publicClient.readContract({
        address: intent.check.contractAddress as Address,
        abi: checkAbi,
        functionName: intent.check.functionName,
        args: checkArgs,
      });
      const actual = BigInt(actualRaw as any);
      const expected = BigInt(intent.condition.value);

      if (!evaluateCondition(actual, intent.condition.operator, expected)) {
        return {
          ok: false,
          revertReason: "CHECK_CONDITION_NOT_MET",
          error: `Check ${intent.check.functionName} returned ${actual}; condition (${intent.condition.operator} ${expected}) not met.`,
        };
      }

      const actionAbi = JSON.parse(intent.action.abi);
      const actionArgs = intent.action.functionArgs
        ? JSON.parse(intent.action.functionArgs)
        : [];
      const estimatedGasUnits = await this.publicClient.estimateContractGas({
        address: intent.action.contractAddress as Address,
        abi: actionAbi,
        functionName: intent.action.functionName,
        args: actionArgs,
        value: intent.action.value ?? 0n,
        account: this.account,
      });
      const projectedDelta = -(intent.action.value ?? 0n);

      if (intent.expectedInvariant) {
        const evalResult = InvariantEvaluator.evaluate(
          intent.expectedInvariant,
          { estimatedGasUnits, actualDelta: projectedDelta },
        );
        if (!evalResult.passed) {
          return {
            ok: false,
            revertReason: evalResult.violations.join("; "),
            error: `Invariant violation: ${evalResult.violations.join("; ")}`,
          };
        }
      }

      const intentHash = computeCheckAndExecuteIntentHash(intent);
      const token: DryRunToken = {
        tokenId: `drt_${randomUUID().slice(0, 12)}`,
        intentHash,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        simulationTrace: { estimatedGasUnits, projectedDelta },
      };

      return { ok: true, token, estimatedGasUnits, projectedDelta };
    } catch (err: any) {
      logger.warn("On-chain check-and-execute dry-run failed", {
        context: { error: err.message || String(err) },
      });
      return {
        ok: false,
        revertReason: err.shortMessage || err.message || "SIMULATION_FAILED",
        error: err.message || "On-chain check-and-execute dry-run failed",
      };
    }
  }

  public async checkAndExecuteExecute(
    intent: CheckAndExecuteExecutionIntent,
  ): Promise<ExecutionResult> {
    const existing = this.runs.get(intent.idempotencyKey);
    if (existing) {
      return existing;
    }

    const start = Date.now();
    const runId = `kh_run_${randomUUID().slice(0, 12)}`;

    try {
      if (!intent.check.abi || !intent.action.abi) {
        throw new Error(
          "The direct on-chain fallback requires explicit ABIs for both the check and the action.",
        );
      }

      // Re-read the condition immediately before acting — this sequential
      // read-then-write, as close together as this fallback can get, is the
      // best available substitute for KeeperHub's server-side atomicity.
      const checkAbi = JSON.parse(intent.check.abi);
      const checkArgs = intent.check.functionArgs
        ? JSON.parse(intent.check.functionArgs)
        : [];
      const actualRaw = await this.publicClient.readContract({
        address: intent.check.contractAddress as Address,
        abi: checkAbi,
        functionName: intent.check.functionName,
        args: checkArgs,
      });
      const actual = BigInt(actualRaw as any);
      const expected = BigInt(intent.condition.value);

      if (!evaluateCondition(actual, intent.condition.operator, expected)) {
        const result: ExecutionResult = {
          state: "FAILED",
          idempotencyKey: intent.idempotencyKey,
          runId,
          revertReason: "CHECK_CONDITION_NOT_MET",
          error: `Check ${intent.check.functionName} returned ${actual}; condition no longer met at execution time.`,
        };
        this.runs.set(intent.idempotencyKey, result);
        return result;
      }

      const actionAbi = JSON.parse(intent.action.abi);
      const actionArgs = intent.action.functionArgs
        ? JSON.parse(intent.action.functionArgs)
        : [];
      const txHash = await this.walletClient.writeContract({
        address: intent.action.contractAddress as Address,
        abi: actionAbi,
        functionName: intent.action.functionName,
        args: actionArgs,
        value: intent.action.value ?? 0n,
        account: this.account,
        chain: baseSepolia,
      });

      logger.info("Broadcasted check-and-execute action to Base Sepolia", {
        context: { txHash, runId },
      });

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
        recipient: intent.action.contractAddress,
        amount: (intent.action.value ?? 0n).toString(),
        txHash,
        policyValidationPassed: true,
        dryRunDurationMs: 45,
        executionDurationMs: Date.now() - start,
      });

      return result;
    } catch (err: any) {
      logger.error("Failed to execute on-chain check-and-execute action", {
        context: { error: err.message || String(err) },
      });

      const classified = ExecutionStateMachine.classifyResponse({
        revertReason: err.shortMessage || err.message,
      });

      const result: ExecutionResult = {
        state: classified.state,
        idempotencyKey: intent.idempotencyKey,
        runId,
        error: err.message || "Failed to execute check-and-execute action",
      };

      this.runs.set(intent.idempotencyKey, result);
      return result;
    }
  }

  public async executeProtocolAction(
    intent: ProtocolActionIntent,
  ): Promise<ExecutionResult> {
    // Protocol actions (e.g. "aave-v3/supply") are KeeperHub's own curated
    // abstraction over specific protocol integrations — there is no local
    // equivalent to fall back to with a raw signer, unlike transfers/contract
    // calls/check-and-execute which map onto plain viem calls.
    logger.warn(
      "executeProtocolAction has no direct on-chain fallback implementation",
      { context: { actionType: intent.actionType } },
    );
    return {
      state: "FAILED",
      idempotencyKey: intent.idempotencyKey,
      revertReason: "NOT_SUPPORTED_WITHOUT_KEEPERHUB",
      error:
        "Protocol actions require the real KeeperHub MCP path (KEEPERHUB_API_KEY) — there is no direct on-chain fallback for KeeperHub's curated protocol integrations.",
    };
  }

  public async getSpendingLimits(): Promise<SpendingLimits | undefined> {
    // No org-level cap concept exists outside KeeperHub's own platform.
    return undefined;
  }

  public async tempoSignAndHold(
    intent: TempoHoldIntent,
  ): Promise<TempoHoldResult> {
    // Tempo's sign-and-hold custody model is a KeeperHub-account-specific
    // concept (KeeperHub holds the signed artifact server-side) — there is
    // no local equivalent to fall back to with a raw signer.
    logger.warn(
      "tempoSignAndHold has no direct on-chain fallback implementation",
      { context: { network: intent.network } },
    );
    return {
      ok: false,
      error:
        "Tempo holds require the real KeeperHub MCP path (KEEPERHUB_API_KEY) — there is no direct on-chain fallback for KeeperHub's custody-hold primitive.",
      revertReason: "NOT_SUPPORTED_WITHOUT_KEEPERHUB",
    };
  }

  public async tempoReleaseHold(
    paymentId: string,
    idempotencyKey?: string,
  ): Promise<ExecutionResult> {
    logger.warn(
      "tempoReleaseHold has no direct on-chain fallback implementation",
      { context: { paymentId } },
    );
    return {
      state: "FAILED",
      idempotencyKey: idempotencyKey ?? paymentId,
      revertReason: "NOT_SUPPORTED_WITHOUT_KEEPERHUB",
      error:
        "Tempo holds require the real KeeperHub MCP path (KEEPERHUB_API_KEY) — there is no direct on-chain fallback.",
    };
  }

  public async tempoCancelHold(paymentId: string): Promise<TempoCancelResult> {
    logger.warn(
      "tempoCancelHold has no direct on-chain fallback implementation",
      { context: { paymentId } },
    );
    return {
      ok: false,
      error:
        "Tempo holds require the real KeeperHub MCP path (KEEPERHUB_API_KEY) — there is no direct on-chain fallback.",
    };
  }
}
