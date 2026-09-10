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

    const res = await this.postJson("dry-run", {
      recipient: intent.recipient,
      amount: intent.amount.toString(),
      calldata: intent.calldata,
      method: intent.method,
    });

    if (res.timedOut || res.error) {
      return {
        ok: false,
        error: `Simulation request failed: ${res.error?.message || "Network timeout"}`,
      };
    }

    if (res.status >= 400 || !res.data?.ok) {
      return {
        ok: false,
        revertReason: res.data?.revertReason || "SIMULATION_REVERTED",
        error:
          res.data?.error ||
          `HTTP ${res.status}: Simulation reverted on-chain.`,
      };
    }

    return {
      ok: true,
      token: res.data.token,
      estimatedGasUnits: BigInt(res.data.estimatedGasUnits || "65000"),
      projectedDelta: BigInt(res.data.projectedDelta || `-${intent.amount}`),
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

    const res = await this.postJson("execute", {
      idempotencyKey: intent.idempotencyKey,
      dryRunTokenId: intent.dryRunTokenId,
      recipient: intent.recipient,
      amount: intent.amount.toString(),
      calldata: intent.calldata,
    });

    const classified = ExecutionStateMachine.classifyResponse({
      statusCode: res.status,
      networkError: res.error,
      timedOut: res.timedOut,
      txHash: res.data?.txHash,
      revertReason: res.data?.revertReason,
      serverMessage: res.data?.message || res.data?.error,
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
