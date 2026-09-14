import { createHash, randomUUID } from "node:crypto";
import type {
  AuditEntry,
  DryRunIntent,
  DryRunResult,
  DryRunToken,
  ExecutionIntent,
  ExecutionResult,
  SupportedNetwork,
} from "../types/index.js";
import type { KeeperHubTransport } from "./transport.js";
import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("LiveKeeperHubTransport");

// KeeperHub MCP `chain_id` values, keyed by DreamKeeper's SupportedNetwork policy setting.
const CHAIN_IDS: Record<SupportedNetwork, string> = {
  "ethereum-mainnet": "1",
  "base-mainnet": "8453",
  "base-sepolia": "84532",
  "ethereum-sepolia": "11155111",
  "arbitrum-one": "42161",
  "arbitrum-sepolia": "421614",
};

// Direct-execution status values per KeeperHub's get_direct_execution_status tool.
// Only "completed" and "failed" are terminal; everything else must keep being polled.
type DirectExecutionStatus =
  "pending" | "running" | "unconfirmed" | "completed" | "failed";

const POLL_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface LiveTransportOptions {
  endpoint?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  network?: SupportedNetwork | undefined;
}

interface ToolCallResult {
  status: number;
  /** Raw JSON-RPC `result` object, e.g. `{ content: [...], isError }`. */
  result?: any;
  /** JSON object extracted from `result.content[0].text`, when present and parseable. */
  parsed?: any;
  /** Raw text content, kept for error messages when `parsed` extraction fails. */
  text?: string | undefined;
  isToolError?: boolean;
  rpcError?: { code?: number; message?: string };
  authError?: boolean | undefined;
  error?: Error | undefined;
  timedOut?: boolean | undefined;
}

interface PendingIntent {
  recipient: string;
  amount: bigint;
  token?: string | undefined;
}

type BroadcastResult =
  { ok: true; executionId: string } | { ok: false; result: ExecutionResult };

export class LiveKeeperHubTransport implements KeeperHubTransport {
  private endpoint: string;
  private apiKey?: string | undefined;
  private timeoutMs: number;
  private chainId: string;

  // MCP Streamable-HTTP requires an initialize handshake before tools/call;
  // the server hands back a session id (header) that must be echoed on every
  // subsequent request, or it responds "Session not initialized".
  private sessionId?: string | undefined;
  private sessionPromise?:
    Promise<{ ok: boolean; authError?: boolean; error?: string }> | undefined;

  // KeeperHub execution_id, keyed by DreamKeeper's idempotencyKey, so reconcile()
  // can resume polling get_direct_execution_status without the caller needing to
  // track KeeperHub's own identifier.
  private executionIds = new Map<string, string>();
  // Transfer parameters, keyed by idempotencyKey, recorded *before* the network
  // call is fired. If that call never gets far enough to yield an execution_id
  // (network drop, timeout), reconcile() uses this to safely retry
  // execute_transfer with the same idempotency_key — KeeperHub's idempotency
  // guarantee makes that a status lookup, not a second broadcast — rather than
  // being permanently unable to resolve an UNKNOWN execution.
  private pendingIntents = new Map<string, PendingIntent>();
  // Audit trail synthesized locally: KeeperHub's MCP surface has no direct-execution
  // audit-log endpoint distinct from get_direct_execution_status.
  private audits = new Map<string, AuditEntry>();

  constructor(options?: LiveTransportOptions) {
    this.endpoint = options?.endpoint || "https://app.keeperhub.com/mcp";
    this.apiKey = options?.apiKey;
    this.timeoutMs = options?.timeoutMs || 15_000;
    this.chainId = CHAIN_IDS[options?.network || "base-sepolia"];
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    return headers;
  }

  private async rawPost(body: unknown): Promise<{
    status: number;
    headers: Headers;
    data?: any;
    error?: Error | undefined;
    timedOut?: boolean | undefined;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = await res.json().catch(() => undefined);
      return { status: res.status, headers: res.headers, data: json };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const timedOut = error.name === "AbortError";
      return { status: 0, headers: new Headers(), error, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Performs the MCP `initialize` handshake once and caches the resulting
   * session id for the lifetime of this transport instance. Concurrent
   * callers await the same in-flight handshake rather than each starting one.
   */
  private async ensureSession(): Promise<{
    ok: boolean;
    authError?: boolean;
    error?: string;
  }> {
    if (this.sessionId) return { ok: true };
    if (!this.sessionPromise) {
      this.sessionPromise = this.initializeSession();
    }
    return this.sessionPromise;
  }

  private async initializeSession(): Promise<{
    ok: boolean;
    authError?: boolean;
    error?: string;
  }> {
    const res = await this.rawPost({
      jsonrpc: "2.0",
      id: `init_${randomUUID()}`,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "dreamkeeper", version: "0.1.0" },
      },
    });

    if (res.status === 401 || res.status === 403) {
      this.sessionPromise = undefined;
      logger.error("KeeperHub rejected the API key during session initialize", {
        context: { status: res.status },
      });
      return {
        ok: false,
        authError: true,
        error: "KeeperHub rejected the API key during session initialize.",
      };
    }

    if (res.error || res.timedOut || res.data?.error) {
      this.sessionPromise = undefined;
      const message =
        res.data?.error?.message ||
        res.error?.message ||
        "Failed to initialize KeeperHub MCP session.";
      logger.error("KeeperHub MCP session initialize failed", {
        context: { status: res.status, message },
      });
      return { ok: false, error: message };
    }

    const sessionId = res.headers.get("mcp-session-id");
    if (!sessionId) {
      this.sessionPromise = undefined;
      logger.error("KeeperHub did not return an Mcp-Session-Id header");
      return {
        ok: false,
        error: "KeeperHub did not return an Mcp-Session-Id header.",
      };
    }

    this.sessionId = sessionId;

    // Required MCP handshake notification; best-effort, no response body expected.
    await this.rawPost({ jsonrpc: "2.0", method: "notifications/initialized" });

    return { ok: true };
  }

  /** Extracts the first balanced `{...}` JSON object found in a text blob. */
  private extractJson(text: string): any | undefined {
    const start = text.indexOf("{");
    if (start === -1) return undefined;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            return undefined;
          }
        }
      }
    }
    return undefined;
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const session = await this.ensureSession();
    if (!session.ok) {
      return {
        status: 0,
        authError: session.authError,
        error: new Error(
          session.error || "KeeperHub session initialization failed.",
        ),
      };
    }

    const res = await this.rawPost({
      jsonrpc: "2.0",
      id: `call_${randomUUID()}`,
      method: "tools/call",
      params: { name, arguments: args },
    });

    if (res.status === 401 || res.status === 403) {
      // Session may have expired; drop it so the next call re-initializes.
      this.sessionId = undefined;
      this.sessionPromise = undefined;
      return { status: res.status, authError: true };
    }

    const result = res.data?.result;
    // KeeperHub's tool responses wrap their payload as MCP text content:
    // result.content[0].text holds a JSON object, sometimes followed by
    // human-readable guidance prose appended after it.
    const text: string | undefined = result?.content?.[0]?.text;
    const parsed =
      typeof text === "string" ? this.extractJson(text) : undefined;

    return {
      status: res.status,
      result,
      parsed,
      text,
      isToolError: result?.isError === true,
      rpcError: res.data?.error,
      error: res.error,
      timedOut: res.timedOut,
    };
  }

  private isAuthError(call: ToolCallResult): boolean {
    if (call.authError) return true;
    const msg = call.rpcError?.message?.toLowerCase() || "";
    return msg.includes("api key") || msg.includes("unauthorized");
  }

  private authErrorMessage(): string {
    return "KeeperHub Auth Error: Missing or invalid API key. Set KEEPERHUB_API_KEY with a valid 'kh_' bearer token to run live.";
  }

  public async dryRun(intent: DryRunIntent): Promise<DryRunResult> {
    logger.info("Executing live KeeperHub dryRun simulation", {
      context: {
        recipient: intent.recipient,
        amount: intent.amount.toString(),
      },
    });

    const call = await this.callTool("execute_transfer", {
      chain_id: this.chainId,
      to_address: intent.recipient,
      amount: (Number(intent.amount) / 1e6).toString(),
      ...(intent.token ? { token_address: intent.token } : {}),
      simulate: true,
    });

    if (this.isAuthError(call)) {
      logger.error("KeeperHub dryRun auth failure", {
        context: { recipient: intent.recipient },
      });
      return { ok: false, error: this.authErrorMessage() };
    }

    if (call.timedOut || call.error) {
      logger.error("KeeperHub dryRun simulation request failed", {
        context: {
          recipient: intent.recipient,
          error: call.error?.message,
          timedOut: call.timedOut,
        },
      });
      return {
        ok: false,
        error: `Simulation request failed: ${call.error?.message || "Network timeout"}`,
      };
    }

    if (call.rpcError) {
      logger.error("KeeperHub dryRun request rejected at the RPC layer", {
        context: { recipient: intent.recipient, rpcError: call.rpcError },
      });
      return {
        ok: false,
        error: call.rpcError.message || "KeeperHub simulation request failed.",
      };
    }

    const success = call.parsed?.success === true;
    const wouldRevert = call.parsed?.wouldRevert === true;

    if (call.isToolError || !success || wouldRevert) {
      logger.warn("KeeperHub dryRun simulation reverted or failed", {
        context: {
          recipient: intent.recipient,
          revertReason: call.parsed?.revertReason,
          rawText: call.text,
        },
      });
      return {
        ok: false,
        revertReason:
          call.parsed?.revertReason ||
          call.parsed?.failureKind ||
          "SIMULATION_REVERTED",
        error:
          call.parsed?.error ||
          call.parsed?.originalError ||
          call.text ||
          "Simulation would revert on-chain.",
      };
    }

    let estimatedGasUnits: bigint;
    let projectedDelta: bigint;
    try {
      estimatedGasUnits = BigInt(
        call.parsed?.estimatedGasUnits || call.parsed?.gasUsed || "65000",
      );
      projectedDelta = BigInt(
        call.parsed?.projectedDelta || `-${intent.amount}`,
      );
    } catch (err: unknown) {
      logger.error("KeeperHub dryRun returned non-integer numeric fields", {
        context: {
          recipient: intent.recipient,
          estimatedGasUnits: call.parsed?.estimatedGasUnits,
          projectedDelta: call.parsed?.projectedDelta,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return {
        ok: false,
        error:
          "KeeperHub returned a non-integer numeric field in the simulation response.",
      };
    }

    // KeeperHub's simulate response has no notion of DreamKeeper's own
    // hash-bound DryRunToken — that binding is DreamKeeper's firewall
    // primitive, layered on top of KeeperHub, so it must be synthesized
    // locally (same approach onchain-transport.ts uses).
    const canonical = JSON.stringify({
      recipient: intent.recipient.toLowerCase(),
      amount: intent.amount.toString(),
      calldata: intent.calldata?.toLowerCase() || "",
      token: intent.token?.toLowerCase() || "",
    });
    const intentHash = createHash("sha256").update(canonical).digest("hex");

    const token: DryRunToken = {
      tokenId: `drt_${randomUUID().slice(0, 12)}`,
      intentHash,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      simulationTrace: { estimatedGasUnits, projectedDelta },
    };

    return {
      ok: true,
      token,
      estimatedGasUnits,
      projectedDelta,
    };
  }

  /**
   * Calls execute_transfer for real (simulate omitted) and classifies the
   * result. Shared by execute() and reconcile()'s recovery path so both go
   * through identical error handling and logging.
   */
  private async broadcastExecuteTransfer(
    idempotencyKey: string,
    intent: PendingIntent,
  ): Promise<BroadcastResult> {
    const call = await this.callTool("execute_transfer", {
      chain_id: this.chainId,
      to_address: intent.recipient,
      amount: (Number(intent.amount) / 1e6).toString(),
      ...(intent.token ? { token_address: intent.token } : {}),
      idempotency_key: idempotencyKey,
      simulate: false,
    });

    if (this.isAuthError(call)) {
      logger.error("KeeperHub execute_transfer auth failure", {
        idempotencyKey,
      });
      return {
        ok: false,
        result: {
          state: "FAILED",
          idempotencyKey,
          error: this.authErrorMessage(),
        },
      };
    }

    if (call.timedOut || call.error || call.rpcError) {
      logger.error("KeeperHub execute_transfer network/RPC failure", {
        idempotencyKey,
        context: {
          status: call.status,
          error: call.error?.message,
          rpcError: call.rpcError,
        },
      });
      return {
        ok: false,
        result: {
          state: "UNKNOWN",
          idempotencyKey,
          error:
            call.rpcError?.message ||
            call.error?.message ||
            "Network timeout awaiting KeeperHub execution response.",
        },
      };
    }

    if (call.isToolError || call.parsed?.success === false) {
      logger.warn("KeeperHub execute_transfer rejected the request", {
        idempotencyKey,
        context: {
          revertReason: call.parsed?.revertReason,
          rawText: call.text,
        },
      });
      return {
        ok: false,
        result: {
          state: "FAILED",
          idempotencyKey,
          revertReason: call.parsed?.revertReason || call.parsed?.failureKind,
          error:
            call.parsed?.error ||
            call.parsed?.originalError ||
            call.text ||
            "KeeperHub execution failed.",
        },
      };
    }

    const executionId: string | undefined =
      call.parsed?.execution_id || call.parsed?.executionId || call.parsed?.id;

    if (!executionId) {
      logger.warn("KeeperHub execute_transfer response had no execution_id", {
        idempotencyKey,
        context: { rawText: call.text },
      });
      return {
        ok: false,
        result: {
          state: "UNKNOWN",
          idempotencyKey,
          error:
            "KeeperHub did not return a recognizable execution_id for this request; verify response shape once a live success sample is available.",
        },
      };
    }

    return { ok: true, executionId };
  }

  public async execute(
    intent: ExecutionIntent,
    _dryRunResult?: DryRunResult,
  ): Promise<ExecutionResult> {
    logger.info("Broadcasting live KeeperHub direct execution", {
      idempotencyKey: intent.idempotencyKey,
      context: {
        recipient: intent.recipient,
        amount: intent.amount.toString(),
      },
    });

    // Recorded *before* the network call, so that if the call itself times
    // out or drops (never yielding an execution_id), reconcile() can still
    // safely retry execute_transfer with this same idempotency_key later.
    this.pendingIntents.set(intent.idempotencyKey, {
      recipient: intent.recipient,
      amount: intent.amount,
      token: intent.token,
    });

    const broadcast = await this.broadcastExecuteTransfer(
      intent.idempotencyKey,
      {
        recipient: intent.recipient,
        amount: intent.amount,
        token: intent.token,
      },
    );

    if (!broadcast.ok) {
      return broadcast.result;
    }

    this.executionIds.set(intent.idempotencyKey, broadcast.executionId);

    // Poll get_direct_execution_status with bounded backoff, per KeeperHub's
    // documented direct-execution flow. If it's still non-terminal after the
    // budget, return UNKNOWN — the caller (keeperhub_reconcile) can resume
    // polling later via reconcile() without re-broadcasting.
    const polled = await this.pollExecutionStatus(broadcast.executionId);

    const result: ExecutionResult = {
      state: polled.state,
      idempotencyKey: intent.idempotencyKey,
      runId: broadcast.executionId,
      txHash: polled.txHash,
      explorerUrl: polled.explorerUrl,
      error: polled.error,
      revertReason: polled.revertReason,
      confirmedAt: polled.state === "CONFIRMED" ? Date.now() : undefined,
    };

    this.audits.set(broadcast.executionId, {
      runId: broadcast.executionId,
      idempotencyKey: intent.idempotencyKey,
      state: result.state,
      timestamp: Date.now(),
      recipient: intent.recipient,
      amount: intent.amount.toString(),
      txHash: result.txHash,
      policyValidationPassed: true,
    });

    return result;
  }

  private async pollExecutionStatus(executionId: string): Promise<{
    state: ExecutionResult["state"];
    txHash?: string | undefined;
    explorerUrl?: string | undefined;
    error?: string | undefined;
    revertReason?: string | undefined;
  }> {
    let transportFailures = 0;
    let lastFailureReason: string | undefined;

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      const call = await this.callTool("get_direct_execution_status", {
        execution_id: executionId,
      });

      if (
        call.timedOut ||
        call.error ||
        call.rpcError ||
        this.isAuthError(call)
      ) {
        transportFailures++;
        lastFailureReason =
          call.rpcError?.message ||
          call.error?.message ||
          (this.isAuthError(call) ? "auth error" : "unknown transport failure");
        logger.warn("get_direct_execution_status poll attempt failed", {
          context: {
            executionId,
            attempt: attempt + 1,
            of: POLL_ATTEMPTS,
            reason: lastFailureReason,
          },
        });
        continue;
      }

      const status: DirectExecutionStatus | undefined = call.parsed?.status;
      const txHash: string | undefined =
        call.parsed?.transactionHash || call.parsed?.txHash;
      const explorerUrl: string | undefined = call.parsed?.transactionLink;

      if (status === "completed") {
        return { state: "CONFIRMED", txHash, explorerUrl };
      }
      if (status === "failed") {
        return {
          state: "FAILED",
          txHash,
          explorerUrl,
          revertReason: call.parsed?.revertReason || "EXECUTION_FAILED",
          error:
            call.parsed?.error || call.text || "KeeperHub execution failed.",
        };
      }
      // pending / running / unconfirmed: not terminal, keep polling.
    }

    if (transportFailures === POLL_ATTEMPTS) {
      return {
        state: "UNKNOWN",
        error: `All ${POLL_ATTEMPTS} status polls failed (last: ${lastFailureReason}) — investigate KeeperHub connectivity before assuming this execution is merely pending.`,
      };
    }

    return {
      state: "UNKNOWN",
      error:
        "Execution still pending after bounded poll window; call keeperhub_reconcile to continue checking.",
    };
  }

  public async reconcile(idempotencyKey: string): Promise<ExecutionResult> {
    logger.info("Reconciling live KeeperHub execution status", {
      idempotencyKey,
    });

    let executionId = this.executionIds.get(idempotencyKey);

    if (!executionId) {
      const pending = this.pendingIntents.get(idempotencyKey);
      if (!pending) {
        return {
          state: "UNKNOWN",
          idempotencyKey,
          error:
            "No KeeperHub execution_id or pending intent on record for this idempotency key.",
        };
      }

      // The original execute() call never got far enough to record an
      // execution_id (network drop/timeout). Retrying execute_transfer with
      // the same idempotency_key is safe per KeeperHub's idempotency
      // guarantee — it resolves to the existing execution rather than
      // broadcasting a second transfer.
      logger.warn(
        "No execution_id on record; retrying execute_transfer with the same idempotency_key to recover it",
        { idempotencyKey },
      );
      const broadcast = await this.broadcastExecuteTransfer(
        idempotencyKey,
        pending,
      );
      if (!broadcast.ok) {
        return broadcast.result;
      }
      executionId = broadcast.executionId;
      this.executionIds.set(idempotencyKey, executionId);
    }

    const polled = await this.pollExecutionStatus(executionId);

    return {
      state: polled.state,
      idempotencyKey,
      runId: executionId,
      txHash: polled.txHash,
      explorerUrl: polled.explorerUrl,
      error: polled.error,
      revertReason: polled.revertReason,
      confirmedAt: polled.state === "CONFIRMED" ? Date.now() : undefined,
    };
  }

  public async getAudit(runId: string): Promise<AuditEntry | undefined> {
    return this.audits.get(runId);
  }
}
