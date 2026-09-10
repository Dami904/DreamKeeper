import type { KeeperHubClient } from "../keeperhub/client.js";
import {
  DryRunActionSchema,
  ExecuteActionSchema,
  ReconcileActionSchema,
  AuditActionSchema,
} from "../types/index.js";
import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("DaydreamsActions");

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

  return {
    dryRunAction,
    executeAction,
    reconcileAction,
    auditAction,
  };
}
