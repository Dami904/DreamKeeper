import type {
  AuditEntry,
  DryRunIntent,
  DryRunResult,
  ExecutionIntent,
  ExecutionResult,
} from "../types/index.js";
import type { KeeperHubTransport } from "./transport.js";
import { ExecutionStateMachine } from "./state-machine.js";
import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("LiveKeeperHubTransport");

export interface LiveTransportOptions {
  endpoint?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
}

export class LiveKeeperHubTransport implements KeeperHubTransport {
  private endpoint: string;
  private apiKey?: string | undefined;
  private timeoutMs: number;

  constructor(options?: LiveTransportOptions) {
    this.endpoint = options?.endpoint || "https://app.keeperhub.com/mcp";
    this.apiKey = options?.apiKey;
    this.timeoutMs = options?.timeoutMs || 15_000;
  }

  private async postJson(
    path: string,
    body: unknown,
  ): Promise<{
    status: number;
    data?: any;
    error?: Error | undefined;
    timedOut?: boolean | undefined;
  }> {
    const url = `${this.endpoint.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = await res.json().catch(() => undefined);
      return { status: res.status, data: json };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const timedOut = error.name === "AbortError";
      return { status: 0, error, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }

  public async dryRun(intent: DryRunIntent): Promise<DryRunResult> {
    logger.info("Executing live KeeperHub dryRun simulation", {
      context: {
        recipient: intent.recipient,
        amount: intent.amount.toString(),
      },
    });

    const isMcp = this.endpoint.includes("/mcp");
    const path = isMcp ? "" : "dry-run";
    const body = isMcp
      ? {
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: "execute_transfer",
            arguments: {
              chain_id: "84532",
              to_address: intent.recipient,
              amount: (Number(intent.amount) / 1e6).toString(),
              simulate: true,
            },
          },
        }
      : {
          recipient: intent.recipient,
          amount: intent.amount.toString(),
          calldata: intent.calldata,
          method: intent.method,
        };

    const res = await this.postJson(path, body);

    if (res.timedOut || res.error) {
      return {
        ok: false,
        error: `Simulation request failed: ${res.error?.message || "Network timeout"}`,
      };
    }

    if (res.data?.error === "invalid_token") {
      return {
        ok: false,
        error:
          "KeeperHub Auth Error: Missing or invalid API key. Set KEEPERHUB_API_KEY with a valid 'kh_' bearer token to run live.",
      };
    }

    const mcpResult = isMcp ? res.data?.result : res.data;

    if (
      res.status >= 400 ||
      (mcpResult && !mcpResult.ok && mcpResult.isError)
    ) {
      return {
        ok: false,
        revertReason: mcpResult?.revertReason || "SIMULATION_REVERTED",
        error:
          mcpResult?.error ||
          mcpResult?.content?.[0]?.text ||
          `HTTP ${res.status}: Simulation reverted on-chain.`,
      };
    }

    return {
      ok: true,
      token: mcpResult?.token,
      estimatedGasUnits: BigInt(mcpResult?.estimatedGasUnits || "65000"),
      projectedDelta: BigInt(mcpResult?.projectedDelta || `-${intent.amount}`),
    };
  }

  public async execute(
    intent: ExecutionIntent,
    _dryRunResult?: DryRunResult,
  ): Promise<ExecutionResult> {
    logger.info("Broadcasting live KeeperHub executeWorkflow", {
      idempotencyKey: intent.idempotencyKey,
      context: {
        recipient: intent.recipient,
        amount: intent.amount.toString(),
      },
    });

    const isMcp = this.endpoint.includes("/mcp");
    const path = isMcp ? "" : "execute";
    const body = isMcp
      ? {
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: "execute_transfer",
            arguments: {
              chain_id: "84532",
              to_address: intent.recipient,
              amount: (Number(intent.amount) / 1e6).toString(),
              idempotency_key: intent.idempotencyKey,
              simulate: false,
            },
          },
        }
      : {
          idempotencyKey: intent.idempotencyKey,
          dryRunTokenId: intent.dryRunTokenId,
          recipient: intent.recipient,
          amount: intent.amount.toString(),
          calldata: intent.calldata,
        };

    const res = await this.postJson(path, body);

    if (res.data?.error === "invalid_token") {
      return {
        state: "FAILED",
        idempotencyKey: intent.idempotencyKey,
        error:
          "KeeperHub Auth Error: Missing or invalid API key. Set KEEPERHUB_API_KEY with a valid 'kh_' bearer token to run live.",
      };
    }

    const mcpData = isMcp ? res.data?.result : res.data;

    const classified = ExecutionStateMachine.classifyResponse({
      statusCode: res.status,
      networkError: res.error,
      timedOut: res.timedOut,
      txHash: mcpData?.txHash || mcpData?.transactionHash,
      revertReason: mcpData?.revertReason,
      serverMessage:
        mcpData?.message || mcpData?.error || mcpData?.content?.[0]?.text,
    });

    return {
      state: classified.state,
      idempotencyKey: intent.idempotencyKey,
      runId: res.data?.runId,
      txHash: res.data?.txHash,
      explorerUrl: res.data?.txHash
        ? `https://sepolia.basescan.org/tx/${res.data.txHash}`
        : undefined,
      error: classified.error,
      revertReason: classified.revertReason,
      confirmedAt: classified.state === "CONFIRMED" ? Date.now() : undefined,
    };
  }

  public async reconcile(idempotencyKey: string): Promise<ExecutionResult> {
    logger.info("Reconciling live KeeperHub transaction status", {
      idempotencyKey,
    });

    const res = await this.postJson("reconcile", { idempotencyKey });
    const classified = ExecutionStateMachine.classifyResponse({
      statusCode: res.status,
      networkError: res.error,
      timedOut: res.timedOut,
      txHash: res.data?.txHash,
      revertReason: res.data?.revertReason,
      serverMessage: res.data?.message,
    });

    return {
      state: classified.state,
      idempotencyKey,
      runId: res.data?.runId,
      txHash: res.data?.txHash,
      explorerUrl: res.data?.txHash
        ? `https://sepolia.basescan.org/tx/${res.data.txHash}`
        : undefined,
      error: classified.error,
      confirmedAt: classified.state === "CONFIRMED" ? Date.now() : undefined,
    };
  }

  public async getAudit(runId: string): Promise<AuditEntry | undefined> {
    const res = await this.postJson("audit", { runId });
    if (res.status === 200 && res.data) {
      return res.data;
    }
    return undefined;
  }
}
