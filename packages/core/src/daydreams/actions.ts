import type { KeeperHubClient } from "../keeperhub/client.js";
import {
  DryRunActionSchema,
  ExecuteActionSchema,
  ReconcileActionSchema,
  AuditActionSchema,
  CheckAndExecuteDryRunActionSchema,
  CheckAndExecuteExecuteActionSchema,
  ProtocolActionSchema,
  GetSpendingLimitsActionSchema,
  GetTrustSummaryActionSchema,
  TempoSignAndHoldActionSchema,
  TempoReleaseHoldActionSchema,
  TempoCancelHoldActionSchema,
} from "../types/index.js";
import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("DaydreamsActions");

/** Converts the flat check-and-execute action args into the nested intent shape. */
function toCheckAndExecuteIntent(args: any) {
  return {
    check: {
      contractAddress: args.checkContractAddress,
      functionName: args.checkFunctionName,
      functionArgs: args.checkFunctionArgs,
      abi: args.checkAbi,
    },
    condition: {
      operator: args.operator,
      value: args.conditionValue,
    },
    action: {
      contractAddress: args.actionContractAddress,
      functionName: args.actionFunctionName,
      functionArgs: args.actionFunctionArgs,
      abi: args.actionAbi,
      value: args.actionValue ? BigInt(args.actionValue) : undefined,
    },
    expectedInvariant:
      args.maxBalanceLoss || args.minTokensReceived || args.maxGasUnits
        ? {
            maxBalanceLoss: args.maxBalanceLoss
              ? BigInt(args.maxBalanceLoss)
              : undefined,
            minTokensReceived: args.minTokensReceived
              ? BigInt(args.minTokensReceived)
              : undefined,
            maxGasUnits: args.maxGasUnits
              ? BigInt(args.maxGasUnits)
              : undefined,
          }
        : undefined,
  };
}

export interface DaydreamsActionDefinition<TSchema, TResult> {
  name: string;
  description: string;
  schema: TSchema;
  handler: (params: any, ctx?: any) => Promise<TResult>;
}

export function createDaydreamsActions(client: KeeperHubClient) {
  const dryRunAction: DaydreamsActionDefinition<
    typeof DryRunActionSchema,
    any
  > = {
    name: "keeperhub_dry_run",
    description:
      "Simulate an on-chain value transfer or contract interaction through KeeperHub without broadcasting to the chain. " +
      "For a plain transfer, set recipient/amount (and token for ERC20). For a contract call, additionally set method " +
      '(the function name) and functionArgs (a JSON array string of arguments, e.g. \'["0x...","1000"]\'); recipient ' +
      'becomes the contract address and amount becomes the native value sent with the call (use "0" for non-payable calls). ' +
      "Verifies liquidity, checks spending policy against the Hallucination Firewall, and asserts invariants (max slippage, min return). " +
      "Returns a dryRunTokenId required for execution.",
    schema: DryRunActionSchema,
    handler: async (args) => {
      logger.info("Executing keeperhub_dry_run tool call", {
        context: { recipient: args.recipient },
      });

      const amount = BigInt(args.amount);
      const expectedInvariant =
        args.maxBalanceLoss || args.minTokensReceived || args.maxGasUnits
          ? {
              maxBalanceLoss: args.maxBalanceLoss
                ? BigInt(args.maxBalanceLoss)
                : undefined,
              minTokensReceived: args.minTokensReceived
                ? BigInt(args.minTokensReceived)
                : undefined,
              maxGasUnits: args.maxGasUnits
                ? BigInt(args.maxGasUnits)
                : undefined,
            }
          : undefined;

      const result = await client.dryRun({
        recipient: args.recipient,
        amount,
        calldata: args.calldata,
        method: args.method,
        token: args.token,
        functionArgs: args.functionArgs,
        abi: args.abi,
        expectedInvariant,
      });

      if (!result.ok) {
        return {
          status: "SIMULATION_FAILED",
          error: result.error,
          revertReason: result.revertReason,
          suggestion:
            "Adjust your intent parameters or verify recipient address against the whitelist.",
        };
      }

      return {
        status: "SIMULATION_SUCCESS",
        dryRunTokenId: result.token?.tokenId,
        expiresAt: result.token?.expiresAt,
        estimatedGasUnits: result.estimatedGasUnits?.toString(),
        projectedDelta: result.projectedDelta?.toString(),
        instructions:
          "Simulation passed all security invariants. Use the returned dryRunTokenId with keeperhub_execute within 60 seconds to broadcast.",
      };
    },
  };

  const executeAction: DaydreamsActionDefinition<
    typeof ExecuteActionSchema,
    any
  > = {
    name: "keeperhub_execute",
    description:
      "Deterministically broadcast an approved transaction via KeeperHub's Turnkey enclaves. " +
      "Requires an active dryRunTokenId from keeperhub_dry_run and a client-persisted idempotencyKey. " +
      "Executes with smart gas repricing and private anti-MEV routing.",
    schema: ExecuteActionSchema,
    handler: async (args) => {
      logger.info("Executing keeperhub_execute tool call", {
        idempotencyKey: args.idempotencyKey,
        context: { recipient: args.recipient },
      });

      const amount = BigInt(args.amount);
      const result = await client.execute({
        idempotencyKey: args.idempotencyKey,
        dryRunTokenId: args.dryRunTokenId,
        recipient: args.recipient,
        amount,
        token: args.token,
        calldata: args.calldata,
        method: args.method,
        functionArgs: args.functionArgs,
        abi: args.abi,
      });

      if (result.state === "CONFIRMED") {
        return {
          status: "CONFIRMED",
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
          runId: result.runId,
          confirmedAt: result.confirmedAt,
          summary: `Transaction successfully mined and confirmed on-chain at ${result.txHash}.`,
        };
      }

      if (result.state === "UNKNOWN") {
        return {
          status: "UNKNOWN",
          idempotencyKey: result.idempotencyKey,
          runId: result.runId,
          warning:
            "Transaction status is currently indeterminate due to a network timeout. Do NOT retry with a new key. Call keeperhub_reconcile with this idempotencyKey to verify on-chain settlement.",
        };
      }

      return {
        status: "FAILED",
        idempotencyKey: result.idempotencyKey,
        error: result.error,
        revertReason: result.revertReason,
      };
    },
  };

  const reconcileAction: DaydreamsActionDefinition<
    typeof ReconcileActionSchema,
    any
  > = {
    name: "keeperhub_reconcile",
    description:
      "Check the settlement status of an UNKNOWN or timed-out execution using its idempotency key. " +
      "Discovers if the transaction was included in a block without risking a duplicate execution.",
    schema: ReconcileActionSchema,
    handler: async (args) => {
      logger.info("Executing keeperhub_reconcile tool call", {
        idempotencyKey: args.idempotencyKey,
      });

      const result = await client.reconcile(args.idempotencyKey);
      return {
        state: result.state,
        idempotencyKey: result.idempotencyKey,
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        runId: result.runId,
        error: result.error,
      };
    },
  };

  const auditAction: DaydreamsActionDefinition<typeof AuditActionSchema, any> =
    {
      name: "keeperhub_get_audit",
      description:
        "Retrieve the cryptographic audit record, execution timestamps, and policy validation logs for a given KeeperHub runId.",
      schema: AuditActionSchema,
      handler: async (args) => {
        const record = await client.getAudit(args.runId);
        if (!record) {
          return {
            found: false,
            message: `No audit record found for runId '${args.runId}'.`,
          };
        }
        return { found: true, audit: record };
      },
    };

  const checkAndExecuteDryRunAction: DaydreamsActionDefinition<
    typeof CheckAndExecuteDryRunActionSchema,
    any
  > = {
    name: "keeperhub_check_and_execute_dry_run",
    description:
      "Simulate an atomic 'read a value, then act only if a condition holds' operation through KeeperHub, " +
      "without broadcasting. Reads checkFunctionName on checkContractAddress, compares the result against " +
      "conditionValue using operator (eq/neq/gt/lt/gte/lte), and — only if the condition would be met — " +
      "simulates calling actionFunctionName on actionContractAddress. Use this for conditional transfers or " +
      "actions (e.g. 'only pay if the vault balance exceeds X') where the check must be fresh at execution " +
      "time, not just at simulation time. Returns a dryRunTokenId required for keeperhub_check_and_execute.",
    schema: CheckAndExecuteDryRunActionSchema,
    handler: async (args) => {
      logger.info("Executing keeperhub_check_and_execute_dry_run tool call", {
        context: {
          checkContract: args.checkContractAddress,
          actionContract: args.actionContractAddress,
        },
      });

      const result = await client.checkAndExecuteDryRun(
        toCheckAndExecuteIntent(args),
      );

      if (!result.ok) {
        return {
          status: "SIMULATION_FAILED",
          error: result.error,
          revertReason: result.revertReason,
          suggestion:
            "Verify the check contract/condition, or confirm the action's contract address and method are whitelisted.",
        };
      }

      return {
        status: "SIMULATION_SUCCESS",
        dryRunTokenId: result.token?.tokenId,
        expiresAt: result.token?.expiresAt,
        estimatedGasUnits: result.estimatedGasUnits?.toString(),
        projectedDelta: result.projectedDelta?.toString(),
        instructions:
          "Condition met and action simulation passed. Use the returned dryRunTokenId with keeperhub_check_and_execute within 60 seconds to broadcast.",
      };
    },
  };

  const checkAndExecuteAction: DaydreamsActionDefinition<
    typeof CheckAndExecuteExecuteActionSchema,
    any
  > = {
    name: "keeperhub_check_and_execute",
    description:
      "Deterministically broadcast an approved check-and-execute operation via KeeperHub. KeeperHub re-reads " +
      "the check condition immediately before acting, atomically server-side, so the condition is fresh at " +
      "broadcast time rather than relying on the earlier dry-run's simulation. Requires an active " +
      "dryRunTokenId from keeperhub_check_and_execute_dry_run and a client-persisted idempotencyKey.",
    schema: CheckAndExecuteExecuteActionSchema,
    handler: async (args) => {
      logger.info("Executing keeperhub_check_and_execute tool call", {
        idempotencyKey: args.idempotencyKey,
        context: {
          checkContract: args.checkContractAddress,
          actionContract: args.actionContractAddress,
        },
      });

      const result = await client.checkAndExecuteExecute({
        ...toCheckAndExecuteIntent(args),
        idempotencyKey: args.idempotencyKey,
        dryRunTokenId: args.dryRunTokenId,
      });

      if (result.state === "CONFIRMED") {
        return {
          status: "CONFIRMED",
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
          runId: result.runId,
          confirmedAt: result.confirmedAt,
          summary: `Check-and-execute action successfully mined and confirmed on-chain at ${result.txHash}.`,
        };
      }

      if (result.state === "UNKNOWN") {
        return {
          status: "UNKNOWN",
          idempotencyKey: result.idempotencyKey,
          runId: result.runId,
          warning:
            "Transaction status is currently indeterminate due to a network timeout. Do NOT retry with a new key. Call keeperhub_reconcile with this idempotencyKey to verify on-chain settlement.",
        };
      }

      return {
        status: "FAILED",
        idempotencyKey: result.idempotencyKey,
        error: result.error,
        revertReason: result.revertReason,
      };
    },
  };

  const protocolActionAction: DaydreamsActionDefinition<
    typeof ProtocolActionSchema,
    any
  > = {
    name: "keeperhub_protocol_action",
    description:
      "Execute a pre-built KeeperHub DeFi protocol action (e.g. 'aave-v3/supply', 'morpho/withdraw', " +
      "'uniswap/swap') by actionType, with parameters as a JSON object string in paramsJson. " +
      "WARNING: unlike keeperhub_dry_run/keeperhub_execute, there is NO simulate/dry-run step for this " +
      "action — it signs and broadcasts immediately once the actionType is approved by the firewall. " +
      "Only pre-approved actionTypes can be called at all; there is no way to preview the result first.",
    schema: ProtocolActionSchema,
    handler: async (args) => {
      logger.info("Executing keeperhub_protocol_action tool call", {
        idempotencyKey: args.idempotencyKey,
        context: { actionType: args.actionType },
      });

      let params: Record<string, unknown>;
      try {
        params = JSON.parse(args.paramsJson);
      } catch {
        return {
          status: "FAILED",
          idempotencyKey: args.idempotencyKey,
          error: "paramsJson must be valid JSON.",
        };
      }

      const result = await client.executeProtocolAction({
        idempotencyKey: args.idempotencyKey,
        actionType: args.actionType,
        params,
      });

      if (result.state === "CONFIRMED") {
        if (result.resultValue !== undefined) {
          return {
            status: "CONFIRMED",
            resultValue: result.resultValue,
            explorerUrl: result.explorerUrl,
            confirmedAt: result.confirmedAt,
            summary: `Protocol action '${args.actionType}' completed synchronously with result: ${result.resultValue}.`,
          };
        }
        return {
          status: "CONFIRMED",
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
          runId: result.runId,
          confirmedAt: result.confirmedAt,
          summary: `Protocol action '${args.actionType}' successfully mined and confirmed on-chain at ${result.txHash}.`,
        };
      }

      if (result.state === "UNKNOWN") {
        return {
          status: "UNKNOWN",
          idempotencyKey: result.idempotencyKey,
          runId: result.runId,
          warning:
            "Transaction status is currently indeterminate due to a network timeout. Do NOT retry with a new key. Call keeperhub_reconcile with this idempotencyKey to verify on-chain settlement.",
        };
      }

      return {
        status: "FAILED",
        idempotencyKey: result.idempotencyKey,
        error: result.error,
        revertReason: result.revertReason,
      };
    },
  };

  const getSpendingLimitsAction: DaydreamsActionDefinition<
    typeof GetSpendingLimitsActionSchema,
    any
  > = {
    name: "keeperhub_get_spending_limits",
    description:
      "Read KeeperHub's own server-side daily spending caps and current usage for this organization. " +
      "This is a second, independent enforcement layer alongside the Hallucination Firewall's local policy " +
      "— KeeperHub itself refuses to execute past its own daily cap even if the local firewall would allow " +
      "it. Read-only; takes no parameters.",
    schema: GetSpendingLimitsActionSchema,
    handler: async () => {
      logger.info("Executing keeperhub_get_spending_limits tool call");

      const limits = await client.getSpendingLimits();
      if (!limits) {
        return {
          available: false,
          message:
            "KeeperHub spending limits are not available on this transport (mock/on-chain fallback modes have no organization-level cap).",
        };
      }

      return {
        available: true,
        dailyCapWei: limits.dailyCapWei?.toString(),
        dailyUsedWei: limits.dailyUsedWei.toString(),
        dailySolanaCapLamports: limits.dailySolanaCapLamports?.toString(),
        dailySolanaUsedLamports: limits.dailySolanaUsedLamports.toString(),
        effectiveDailyCapWei: limits.effectiveDailyCapWei.toString(),
        effectiveDailySolanaCapLamports:
          limits.effectiveDailySolanaCapLamports.toString(),
        usingDefaultDailyCap: limits.usingDefaultDailyCap,
        usingDefaultDailySolanaCap: limits.usingDefaultDailySolanaCap,
      };
    },
  };

  const getTrustSummaryAction: DaydreamsActionDefinition<
    typeof GetTrustSummaryActionSchema,
    any
  > = {
    name: "keeperhub_get_trust_summary",
    description:
      "Read this agent's own self-reported firewall-block and execution-outcome history: how many " +
      "actions were blocked and why, how many real executions confirmed/failed/came back indeterminate, " +
      "and the circuit breaker's current state. This is a local, locally-persisted record this client " +
      "keeps about itself — it is NOT hosted, NOT cryptographically attested, and NOT reachable by a " +
      "counterparty unless they have direct access to this same running instance. Read-only; takes no " +
      "parameters.",
    schema: GetTrustSummaryActionSchema,
    handler: async () => {
      logger.info("Executing keeperhub_get_trust_summary tool call");

      const summary = client.getTrustSummary();
      return {
        circuitBreakerState: summary.circuitBreakerState,
        totalBlockedAttempts: summary.totalBlockedAttempts,
        blockedByReason: summary.blockedByReason,
        totalConfirmedExecutions: summary.totalConfirmedExecutions,
        totalFailedExecutions: summary.totalFailedExecutions,
        totalUnknownExecutions: summary.totalUnknownExecutions,
        trackingSince: summary.trackingSince,
      };
    },
  };

  const tempoSignAndHoldAction: DaydreamsActionDefinition<
    typeof TempoSignAndHoldActionSchema,
    any
  > = {
    name: "keeperhub_tempo_sign_and_hold",
    description:
      "Sign a Tempo stablecoin payment and hold it for later broadcast, without moving any value yet. " +
      "Produces a real signed artifact (not just a simulation) that only becomes a live payment once " +
      "keeperhub_tempo_release_hold is called — until then it can be safely discarded with " +
      "keeperhub_tempo_cancel_hold. network must be an approved Tempo network (e.g. 'tempo-testnet'); " +
      "tokenAddress/tokenSymbol identify the stablecoin; amount is a human-readable decimal string " +
      '(e.g. "1.50"), not atomic units. Returns a paymentId required for release/cancel.',
    schema: TempoSignAndHoldActionSchema,
    handler: async (args) => {
      logger.info("Executing keeperhub_tempo_sign_and_hold tool call", {
        idempotencyKey: args.idempotencyKey,
        context: { network: args.network, recipient: args.recipient },
      });

      const result = await client.tempoSignAndHold({
        idempotencyKey: args.idempotencyKey,
        network: args.network,
        tokenAddress: args.tokenAddress,
        tokenSymbol: args.tokenSymbol,
        amount: args.amount,
        recipient: args.recipient,
        memo: args.memo,
        broadcastMode: args.broadcastMode,
        broadcastAt: args.broadcastAt,
        validBefore: args.validBefore,
      });

      if (!result.ok) {
        return {
          status: "HOLD_FAILED",
          error: result.error,
          revertReason: result.revertReason,
          suggestion:
            "Verify the recipient, Tempo network, and token address are all whitelisted, and that the amount is within the configured caps.",
        };
      }

      return {
        status: "HOLD_CREATED",
        paymentId: result.paymentId,
        precomputedHash: result.precomputedHash,
        validBefore: result.validBefore,
        instructions:
          "Hold created but not yet broadcast. Call keeperhub_tempo_release_hold with this paymentId to broadcast it, or keeperhub_tempo_cancel_hold to discard it.",
      };
    },
  };

  const tempoReleaseHoldAction: DaydreamsActionDefinition<
    typeof TempoReleaseHoldActionSchema,
    any
  > = {
    name: "keeperhub_tempo_release_hold",
    description:
      "Broadcast a previously-created Tempo hold, actually moving the held stablecoin. Requires a " +
      "paymentId from a prior keeperhub_tempo_sign_and_hold call made by this same agent session — " +
      "a paymentId this client did not itself create is refused, even if it belongs to a real hold.",
    schema: TempoReleaseHoldActionSchema,
    handler: async (args) => {
      logger.info("Executing keeperhub_tempo_release_hold tool call", {
        context: { paymentId: args.paymentId },
      });

      const result = await client.tempoReleaseHold(
        args.paymentId,
        args.idempotencyKey,
      );

      if (result.state === "CONFIRMED") {
        return {
          status: "CONFIRMED",
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
          confirmedAt: result.confirmedAt,
          summary: `Tempo hold successfully released and confirmed on-chain at ${result.txHash}.`,
        };
      }

      if (result.state === "UNKNOWN") {
        return {
          status: "UNKNOWN",
          idempotencyKey: result.idempotencyKey,
          warning:
            "Release status is currently indeterminate due to a network timeout. Do NOT retry with a new idempotencyKey.",
        };
      }

      return {
        status: "FAILED",
        idempotencyKey: result.idempotencyKey,
        error: result.error,
        revertReason: result.revertReason,
      };
    },
  };

  const tempoCancelHoldAction: DaydreamsActionDefinition<
    typeof TempoCancelHoldActionSchema,
    any
  > = {
    name: "keeperhub_tempo_cancel_hold",
    description:
      "Cancel a previously-created Tempo hold so it is never broadcast. Same paymentId-ownership guard " +
      "as keeperhub_tempo_release_hold.",
    schema: TempoCancelHoldActionSchema,
    handler: async (args) => {
      logger.info("Executing keeperhub_tempo_cancel_hold tool call", {
        context: { paymentId: args.paymentId },
      });

      const result = await client.tempoCancelHold(args.paymentId);

      if (!result.ok) {
        return { status: "CANCEL_FAILED", error: result.error };
      }

      return {
        status: "CANCELED",
        summary: `Tempo hold '${args.paymentId}' was canceled and will never broadcast.`,
      };
    },
  };

  return {
    dryRunAction,
    executeAction,
    reconcileAction,
    auditAction,
    checkAndExecuteDryRunAction,
    checkAndExecuteAction,
    protocolActionAction,
    getSpendingLimitsAction,
    getTrustSummaryAction,
    tempoSignAndHoldAction,
    tempoReleaseHoldAction,
    tempoCancelHoldAction,
  };
}
