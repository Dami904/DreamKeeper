import type { KeeperHubClient } from "../keeperhub/client.js";
import {
  DryRunActionSchema,
  ExecuteActionSchema,
  ReconcileActionSchema,
  AuditActionSchema,
  CheckAndExecuteDryRunActionSchema,
  CheckAndExecuteExecuteActionSchema,
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

  return {
    dryRunAction,
    executeAction,
    reconcileAction,
    auditAction,
    checkAndExecuteDryRunAction,
    checkAndExecuteAction,
  };
}
