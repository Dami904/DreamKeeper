import { randomUUID } from "node:crypto";
import type {
  AuditEntry,
  CheckAndExecuteExecutionIntent,
  CheckAndExecuteIntent,
  DryRunIntent,
  DryRunResult,
  DryRunToken,
  ExecutionIntent,
  ExecutionResult,
  ProtocolActionIntent,
  SpendingLimits,
  SupportedNetwork,
  TempoCancelResult,
  TempoHoldIntent,
  TempoHoldResult,
} from "../types/index.js";
import type { KeeperHubTransport } from "./transport.js";
import { InvariantEvaluator } from "../firewall/invariants.js";
import {
  computeCheckAndExecuteIntentHash,
  computeIntentHash,
} from "../firewall/validator.js";
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
  method?: string | undefined;
  functionArgs?: string | undefined;
  abi?: string | undefined;
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
  // Same recovery purpose as pendingIntents, for check-and-execute intents
  // (a structurally different shape — check + condition + action).
  private pendingCheckAndExecuteIntents = new Map<
    string,
    CheckAndExecuteIntent
  >();
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

  /**
   * Picks execute_transfer vs execute_contract_call and builds its arguments.
   * `method` present means this is a contract-call-shaped intent (see
   * DryRunIntent's doc comment) — `recipient` becomes the contract address
   * and `amount` becomes the native value sent with the call, in ether
   * units (execute_contract_call's `value` is decimal-ether, unlike
   * execute_transfer's `amount` which this codebase treats as 6-decimal
   * USDC — see the existing amount-conversion limitation in LIMITATIONS.md).
   */
  private buildTransferOrCallRequest(
    intent: {
      recipient: string;
      amount: bigint;
      token?: string | undefined;
      method?: string | undefined;
      functionArgs?: string | undefined;
      abi?: string | undefined;
    },
    extra: Record<string, unknown>,
  ): { toolName: string; args: Record<string, unknown> } {
    if (intent.method) {
      return {
        toolName: "execute_contract_call",
        args: {
          contract_address: intent.recipient,
          chain_id: this.chainId,
          function_name: intent.method,
          ...(intent.functionArgs
            ? { function_args: intent.functionArgs }
            : {}),
          ...(intent.abi ? { abi: intent.abi } : {}),
          ...(intent.amount > 0n
            ? { value: (Number(intent.amount) / 1e18).toString() }
            : {}),
          ...extra,
        },
      };
    }
    return {
      toolName: "execute_transfer",
      args: {
        chain_id: this.chainId,
        to_address: intent.recipient,
        amount: (Number(intent.amount) / 1e6).toString(),
        ...(intent.token ? { token_address: intent.token } : {}),
        ...extra,
      },
    };
  }

  /** Builds arguments for the real execute_check_and_execute tool. */
  private buildCheckAndExecuteArgs(
    intent: CheckAndExecuteIntent,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      contract_address: intent.check.contractAddress,
      chain_id: this.chainId,
      function_name: intent.check.functionName,
      ...(intent.check.functionArgs
        ? { function_args: intent.check.functionArgs }
        : {}),
      ...(intent.check.abi ? { abi: intent.check.abi } : {}),
      condition: {
        operator: intent.condition.operator,
        value: intent.condition.value,
      },
      action: {
        contract_address: intent.action.contractAddress,
        function_name: intent.action.functionName,
        ...(intent.action.functionArgs
          ? { function_args: intent.action.functionArgs }
          : {}),
        ...(intent.action.abi ? { abi: intent.action.abi } : {}),
      },
      ...extra,
    };
  }

  public async dryRun(intent: DryRunIntent): Promise<DryRunResult> {
    logger.info("Executing live KeeperHub dryRun simulation", {
      context: {
        recipient: intent.recipient,
        amount: intent.amount.toString(),
        method: intent.method,
      },
    });

    const { toolName, args } = this.buildTransferOrCallRequest(intent, {
      simulate: true,
    });
    const call = await this.callTool(toolName, args);

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
        call.parsed?.estimatedGasUnits ||
          call.parsed?.gasEstimate ||
          call.parsed?.gasUsed ||
          "65000",
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

    // KeeperHub's own success/wouldRevert only tells us the call wouldn't
    // revert — it says nothing about DreamKeeper's own caller-supplied
    // invariants (max loss, min received, gas ceiling). This must be
    // evaluated here too, same as onchain-transport.ts and mock-transport.ts
    // already do — without it, expectedInvariant is silently ignored on the
    // real KeeperHub path.
    if (intent.expectedInvariant) {
      const evalResult = InvariantEvaluator.evaluate(intent.expectedInvariant, {
        estimatedGasUnits,
        actualDelta: projectedDelta,
      });
      if (!evalResult.passed) {
        logger.warn(
          "KeeperHub dryRun passed simulation but failed invariant evaluation",
          {
            context: {
              recipient: intent.recipient,
              violations: evalResult.violations,
            },
          },
        );
        return {
          ok: false,
          revertReason: evalResult.violations.join("; "),
          error: `Invariant violation: ${evalResult.violations.join("; ")}`,
        };
      }
    }

    // KeeperHub's simulate response has no notion of DreamKeeper's own
    // hash-bound DryRunToken — that binding is DreamKeeper's firewall
    // primitive, layered on top of KeeperHub, so it must be synthesized
    // locally (same approach onchain-transport.ts uses).
    const intentHash = computeIntentHash(intent);

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

  public async checkAndExecuteDryRun(
    intent: CheckAndExecuteIntent,
  ): Promise<DryRunResult> {
    logger.info("Executing live KeeperHub check-and-execute dry-run", {
      context: {
        checkContract: intent.check.contractAddress,
        actionContract: intent.action.contractAddress,
      },
    });

    const args = this.buildCheckAndExecuteArgs(intent, { simulate: true });
    const call = await this.callTool("execute_check_and_execute", args);

    if (this.isAuthError(call)) {
      logger.error("KeeperHub check-and-execute dry-run auth failure");
      return { ok: false, error: this.authErrorMessage() };
    }

    if (call.timedOut || call.error) {
      logger.error("KeeperHub check-and-execute dry-run request failed", {
        context: { error: call.error?.message, timedOut: call.timedOut },
      });
      return {
        ok: false,
        error: `Simulation request failed: ${call.error?.message || "Network timeout"}`,
      };
    }

    if (call.rpcError) {
      logger.error(
        "KeeperHub check-and-execute dry-run rejected at the RPC layer",
        { context: { rpcError: call.rpcError } },
      );
      return {
        ok: false,
        error: call.rpcError.message || "KeeperHub simulation request failed.",
      };
    }

    // execute_check_and_execute's real response has no `wouldRevert` at the
    // top level for the "condition not met" case — verified directly:
    // {success:true, executed:false, conditionResult:{met:false, ...}} when
    // the check fails, vs. {success:true, executed:true, wouldRevert:false,
    // gasEstimate, conditionResult:{met:true, ...}} when it's simulated for
    // real. `success` only means the API call itself worked, not that the
    // condition held or the action would succeed — `executed` is the field
    // that actually says whether the action ran/would run.
    const apiCallOk = call.parsed?.success === true;

    if (call.isToolError || !apiCallOk) {
      logger.warn("KeeperHub check-and-execute request failed", {
        context: { rawText: call.text },
      });
      return {
        ok: false,
        revertReason: call.parsed?.revertReason || "REQUEST_FAILED",
        error:
          call.parsed?.error ||
          call.parsed?.originalError ||
          call.text ||
          "KeeperHub check-and-execute request failed.",
      };
    }

    const conditionMet = call.parsed?.conditionResult?.met === true;
    const executed = call.parsed?.executed === true;

    if (!conditionMet || !executed) {
      const observed = call.parsed?.conditionResult?.observedValue;
      const target = call.parsed?.conditionResult?.targetValue;
      const operator = call.parsed?.conditionResult?.operator;
      logger.info("KeeperHub check-and-execute: condition not met", {
        context: { observed, target, operator },
      });
      return {
        ok: false,
        revertReason: "CHECK_CONDITION_NOT_MET",
        error: `Check returned ${observed}; condition (${operator} ${target}) not met, action would not run.`,
      };
    }

    if (call.parsed?.wouldRevert === true) {
      logger.warn(
        "KeeperHub check-and-execute: condition met but action would revert",
        { context: { revertReason: call.parsed?.revertReason } },
      );
      return {
        ok: false,
        revertReason: call.parsed?.revertReason || "SIMULATION_REVERTED",
        error:
          call.parsed?.error ||
          call.parsed?.originalError ||
          "Condition met, but the action would revert on-chain.",
      };
    }

    let estimatedGasUnits: bigint;
    let projectedDelta: bigint;
    try {
      estimatedGasUnits = BigInt(
        call.parsed?.estimatedGasUnits ||
          call.parsed?.gasEstimate ||
          call.parsed?.gasUsed ||
          "65000",
      );
      projectedDelta = BigInt(
        call.parsed?.projectedDelta || `-${intent.action.value ?? 0n}`,
      );
    } catch (err: unknown) {
      logger.error(
        "KeeperHub check-and-execute dry-run returned non-integer numeric fields",
        {
          context: {
            estimatedGasUnits: call.parsed?.estimatedGasUnits,
            projectedDelta: call.parsed?.projectedDelta,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      );
      return {
        ok: false,
        error:
          "KeeperHub returned a non-integer numeric field in the simulation response.",
      };
    }

    if (intent.expectedInvariant) {
      const evalResult = InvariantEvaluator.evaluate(intent.expectedInvariant, {
        estimatedGasUnits,
        actualDelta: projectedDelta,
      });
      if (!evalResult.passed) {
        logger.warn(
          "KeeperHub check-and-execute passed simulation but failed invariant evaluation",
          { context: { violations: evalResult.violations } },
        );
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
    const { toolName, args } = this.buildTransferOrCallRequest(intent, {
      idempotency_key: idempotencyKey,
      simulate: false,
    });
    const call = await this.callTool(toolName, args);

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
    const pendingIntent: PendingIntent = {
      recipient: intent.recipient,
      amount: intent.amount,
      token: intent.token,
      method: intent.method,
      functionArgs: intent.functionArgs,
      abi: intent.abi,
    };
    this.pendingIntents.set(intent.idempotencyKey, pendingIntent);

    const broadcast = await this.broadcastExecuteTransfer(
      intent.idempotencyKey,
      pendingIntent,
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

  /**
   * Calls execute_check_and_execute for real (simulate omitted). Mirrors
   * broadcastExecuteTransfer's error handling and execution_id extraction.
   */
  private async broadcastCheckAndExecute(
    idempotencyKey: string,
    intent: CheckAndExecuteIntent,
  ): Promise<BroadcastResult> {
    const args = this.buildCheckAndExecuteArgs(intent, {
      idempotency_key: idempotencyKey,
      simulate: false,
    });
    const call = await this.callTool("execute_check_and_execute", args);

    if (this.isAuthError(call)) {
      logger.error("KeeperHub check-and-execute auth failure", {
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
      logger.error("KeeperHub check-and-execute network/RPC failure", {
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
            "Network timeout awaiting KeeperHub check-and-execute response.",
        },
      };
    }

    if (call.isToolError || call.parsed?.success === false) {
      logger.warn("KeeperHub check-and-execute rejected the request", {
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
          revertReason: call.parsed?.revertReason || "REQUEST_FAILED",
          error:
            call.parsed?.error ||
            call.parsed?.originalError ||
            call.text ||
            "KeeperHub check-and-execute failed.",
        },
      };
    }

    // Same field semantics as checkAndExecuteDryRun, verified against the
    // real API: `success` only means the call itself worked; `executed` and
    // `conditionResult.met` say whether the action actually ran. If the
    // condition wasn't met at broadcast time, nothing was signed and there
    // is no execution_id to poll — that's a FAILED result, not UNKNOWN.
    const conditionMet = call.parsed?.conditionResult?.met === true;
    const executed = call.parsed?.executed === true;

    if (!conditionMet || !executed) {
      const observed = call.parsed?.conditionResult?.observedValue;
      const target = call.parsed?.conditionResult?.targetValue;
      const operator = call.parsed?.conditionResult?.operator;
      logger.info(
        "KeeperHub check-and-execute: condition not met at broadcast time",
        {
          idempotencyKey,
          context: { observed, target, operator },
        },
      );
      return {
        ok: false,
        result: {
          state: "FAILED",
          idempotencyKey,
          revertReason: "CHECK_CONDITION_NOT_MET",
          error: `Check returned ${observed}; condition (${operator} ${target}) not met at broadcast time, action did not run.`,
        },
      };
    }

    const executionId: string | undefined =
      call.parsed?.execution_id || call.parsed?.executionId || call.parsed?.id;

    if (!executionId) {
      logger.warn("KeeperHub check-and-execute response had no execution_id", {
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

  public async checkAndExecuteExecute(
    intent: CheckAndExecuteExecutionIntent,
  ): Promise<ExecutionResult> {
    logger.info("Broadcasting live KeeperHub check-and-execute action", {
      idempotencyKey: intent.idempotencyKey,
      context: {
        checkContract: intent.check.contractAddress,
        actionContract: intent.action.contractAddress,
      },
    });

    this.pendingCheckAndExecuteIntents.set(intent.idempotencyKey, {
      check: intent.check,
      condition: intent.condition,
      action: intent.action,
      expectedInvariant: intent.expectedInvariant,
    });

    const broadcast = await this.broadcastCheckAndExecute(
      intent.idempotencyKey,
      intent,
    );

    if (!broadcast.ok) {
      return broadcast.result;
    }

    this.executionIds.set(intent.idempotencyKey, broadcast.executionId);

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
      recipient: intent.action.contractAddress,
      amount: (intent.action.value ?? 0n).toString(),
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
      const pendingCheckAndExecute =
        this.pendingCheckAndExecuteIntents.get(idempotencyKey);

      if (!pending && !pendingCheckAndExecute) {
        return {
          state: "UNKNOWN",
          idempotencyKey,
          error:
            "No KeeperHub execution_id or pending intent on record for this idempotency key.",
        };
      }

      // The original execute()/checkAndExecuteExecute() call never got far
      // enough to record an execution_id (network drop/timeout). Retrying
      // with the same idempotency_key is safe per KeeperHub's idempotency
      // guarantee — it resolves to the existing execution rather than
      // broadcasting a second one.
      logger.warn(
        "No execution_id on record; retrying with the same idempotency_key to recover it",
        { idempotencyKey },
      );
      const broadcast = pending
        ? await this.broadcastExecuteTransfer(idempotencyKey, pending)
        : await this.broadcastCheckAndExecute(
            idempotencyKey,
            pendingCheckAndExecute!,
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

  public async executeProtocolAction(
    intent: ProtocolActionIntent,
  ): Promise<ExecutionResult> {
    logger.info("Broadcasting live KeeperHub protocol action", {
      idempotencyKey: intent.idempotencyKey,
      context: { actionType: intent.actionType },
    });

    const call = await this.callTool("execute_protocol_action", {
      actionType: intent.actionType,
      params: intent.params,
      idempotency_key: intent.idempotencyKey,
    });

    if (this.isAuthError(call)) {
      logger.error("KeeperHub protocol action auth failure", {
        idempotencyKey: intent.idempotencyKey,
      });
      return {
        state: "FAILED",
        idempotencyKey: intent.idempotencyKey,
        error: this.authErrorMessage(),
      };
    }

    if (call.timedOut || call.error || call.rpcError) {
      logger.error("KeeperHub protocol action network/RPC failure", {
        idempotencyKey: intent.idempotencyKey,
        context: {
          status: call.status,
          error: call.error?.message,
          rpcError: call.rpcError,
        },
      });
      return {
        state: "UNKNOWN",
        idempotencyKey: intent.idempotencyKey,
        error:
          call.rpcError?.message ||
          call.error?.message ||
          "Network timeout awaiting KeeperHub protocol action response.",
      };
    }

    if (call.isToolError || call.parsed?.success === false) {
      logger.warn("KeeperHub protocol action rejected the request", {
        idempotencyKey: intent.idempotencyKey,
        context: {
          revertReason: call.parsed?.revertReason,
          rawText: call.text,
        },
      });
      return {
        state: "FAILED",
        idempotencyKey: intent.idempotencyKey,
        revertReason: call.parsed?.revertReason || "REQUEST_FAILED",
        error:
          call.parsed?.error ||
          call.parsed?.originalError ||
          call.text ||
          "KeeperHub protocol action failed.",
      };
    }

    const executionId: string | undefined =
      call.parsed?.execution_id || call.parsed?.executionId || call.parsed?.id;

    if (!executionId) {
      logger.warn("KeeperHub protocol action response had no execution_id", {
        idempotencyKey: intent.idempotencyKey,
        context: { rawText: call.text },
      });
      return {
        state: "UNKNOWN",
        idempotencyKey: intent.idempotencyKey,
        error:
          "KeeperHub did not return a recognizable execution_id for this request; verify response shape once a live success sample is available.",
      };
    }

    const polled = await this.pollExecutionStatus(executionId);

    const result: ExecutionResult = {
      state: polled.state,
      idempotencyKey: intent.idempotencyKey,
      runId: executionId,
      txHash: polled.txHash,
      explorerUrl: polled.explorerUrl,
      error: polled.error,
      revertReason: polled.revertReason,
      confirmedAt: polled.state === "CONFIRMED" ? Date.now() : undefined,
    };

    this.audits.set(executionId, {
      runId: executionId,
      idempotencyKey: intent.idempotencyKey,
      state: result.state,
      timestamp: Date.now(),
      recipient: intent.actionType,
      amount: "0",
      txHash: result.txHash,
      policyValidationPassed: true,
    });

    return result;
  }

  public async getSpendingLimits(): Promise<SpendingLimits | undefined> {
    const call = await this.callTool("get_spending_limits", {});

    if (this.isAuthError(call)) {
      logger.error("KeeperHub get_spending_limits auth failure");
      return undefined;
    }

    if (call.timedOut || call.error || call.rpcError || call.isToolError) {
      logger.warn("KeeperHub get_spending_limits request failed", {
        context: {
          error: call.error?.message,
          rpcError: call.rpcError,
          rawText: call.text,
        },
      });
      return undefined;
    }

    const p = call.parsed;
    if (!p) {
      logger.warn("KeeperHub get_spending_limits returned no parseable body", {
        context: { rawText: call.text },
      });
      return undefined;
    }

    try {
      return {
        dailyCapWei: p.dailyCapWei != null ? BigInt(p.dailyCapWei) : undefined,
        dailyUsedWei: BigInt(p.dailyUsedWei ?? "0"),
        dailySolanaCapLamports:
          p.dailySolanaCapLamports != null
            ? BigInt(p.dailySolanaCapLamports)
            : undefined,
        dailySolanaUsedLamports: BigInt(p.dailySolanaUsedLamports ?? "0"),
        effectiveDailyCapWei: BigInt(p.effectiveDailyCapWei ?? "0"),
        effectiveDailySolanaCapLamports: BigInt(
          p.effectiveDailySolanaCapLamports ?? "0",
        ),
        usingDefaultDailyCap: p.usingDefaultDailyCap === true,
        usingDefaultDailySolanaCap: p.usingDefaultDailySolanaCap === true,
      };
    } catch (err: unknown) {
      logger.error(
        "KeeperHub get_spending_limits returned non-integer fields",
        {
          context: {
            rawText: call.text,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      );
      return undefined;
    }
  }

  /**
   * Signs a Tempo stablecoin payment and holds it for later broadcast.
   * Verified real response on success:
   * `{success:true, paymentId, precomputedHash, from, to, amount, memo,
   * broadcastMode, broadcastAt, validBefore, status:"pending", chainId}`.
   * Real errors observed are a flat `{"error": "..."}` (e.g. an unsupported
   * network string, or a malformed tokenConfig) — tokenConfig must be sent
   * as a JSON-stringified `{"mode":"custom","customToken":{"address":...,
   * "symbol":...}}`, not a bare token symbol string.
   */
  public async tempoSignAndHold(
    intent: TempoHoldIntent,
  ): Promise<TempoHoldResult> {
    logger.info("Signing and holding Tempo payment", {
      idempotencyKey: intent.idempotencyKey,
      context: { network: intent.network, recipient: intent.recipient },
    });

    const tokenConfig = JSON.stringify({
      mode: "custom",
      customToken: { address: intent.tokenAddress, symbol: intent.tokenSymbol },
    });

    const call = await this.callTool("tempo_sign_and_hold", {
      network: intent.network,
      tokenConfig,
      amount: intent.amount,
      recipientAddress: intent.recipient,
      memo: intent.memo,
      broadcastMode: intent.broadcastMode,
      broadcastAt: intent.broadcastAt,
      validBefore: intent.validBefore,
      idempotency_key: intent.idempotencyKey,
    });

    if (this.isAuthError(call)) {
      logger.error("KeeperHub tempo_sign_and_hold auth failure", {
        idempotencyKey: intent.idempotencyKey,
      });
      return { ok: false, error: this.authErrorMessage() };
    }

    if (call.timedOut || call.error || call.rpcError) {
      logger.error("KeeperHub tempo_sign_and_hold network/RPC failure", {
        idempotencyKey: intent.idempotencyKey,
        context: {
          status: call.status,
          error: call.error?.message,
          rpcError: call.rpcError,
        },
      });
      return {
        ok: false,
        error:
          call.rpcError?.message ||
          call.error?.message ||
          "Network timeout awaiting KeeperHub tempo_sign_and_hold response.",
      };
    }

    const p = call.parsed;
    if (call.isToolError || !p || p.success === false || p.error) {
      logger.warn("KeeperHub tempo_sign_and_hold rejected the request", {
        idempotencyKey: intent.idempotencyKey,
        context: { rawText: call.text },
      });
      return {
        ok: false,
        error: p?.error || call.text || "KeeperHub tempo_sign_and_hold failed.",
      };
    }

    return {
      ok: true,
      paymentId: p.paymentId,
      precomputedHash: p.precomputedHash,
      from: p.from,
      to: p.to,
      amount: p.amount,
      memo: p.memo,
      broadcastMode: p.broadcastMode,
      broadcastAt: p.broadcastAt ?? undefined,
      validBefore: p.validBefore,
      status: p.status,
      chainId: p.chainId,
    };
  }

  /**
   * Broadcasts a previously-created Tempo hold. Verified real success shape:
   * `{ok:true, status:"confirmed", transactionHash}` — synchronous, unlike
   * the execution_id/poll pattern used by the EVM direct-execution tools.
   */
  public async tempoReleaseHold(
    paymentId: string,
    idempotencyKey?: string,
  ): Promise<ExecutionResult> {
    const key = idempotencyKey ?? paymentId;
    logger.info("Releasing Tempo hold", {
      idempotencyKey: key,
      context: { paymentId },
    });

    const call = await this.callTool("tempo_release_hold", {
      paymentId,
      idempotency_key: key,
    });

    if (this.isAuthError(call)) {
      logger.error("KeeperHub tempo_release_hold auth failure", {
        idempotencyKey: key,
      });
      return {
        state: "FAILED",
        idempotencyKey: key,
        error: this.authErrorMessage(),
      };
    }

    if (call.timedOut || call.error || call.rpcError) {
      logger.error("KeeperHub tempo_release_hold network/RPC failure", {
        idempotencyKey: key,
        context: {
          status: call.status,
          error: call.error?.message,
          rpcError: call.rpcError,
        },
      });
      return {
        state: "UNKNOWN",
        idempotencyKey: key,
        error:
          call.rpcError?.message ||
          call.error?.message ||
          "Network timeout awaiting KeeperHub tempo_release_hold response.",
      };
    }

    const p = call.parsed;
    if (call.isToolError || !p || p.ok === false || p.error) {
      logger.warn("KeeperHub tempo_release_hold rejected the request", {
        idempotencyKey: key,
        context: { rawText: call.text },
      });
      return {
        state: "FAILED",
        idempotencyKey: key,
        revertReason: p?.error || "TEMPO_RELEASE_FAILED",
        error: p?.error || call.text || "KeeperHub tempo_release_hold failed.",
      };
    }

    if (!p.transactionHash) {
      logger.warn(
        "KeeperHub tempo_release_hold response had no transactionHash",
        {
          idempotencyKey: key,
          context: { rawText: call.text },
        },
      );
      return {
        state: "UNKNOWN",
        idempotencyKey: key,
        error: "KeeperHub reported success but returned no transactionHash.",
      };
    }

    return {
      state: "CONFIRMED",
      idempotencyKey: key,
      txHash: p.transactionHash,
      explorerUrl: `https://explore.testnet.tempo.xyz/tx/${p.transactionHash}`,
      confirmedAt: Date.now(),
    };
  }

  /**
   * Cancels a previously-created Tempo hold. Verified real success shape:
   * `{ok:true, status:"canceled"}`.
   */
  public async tempoCancelHold(paymentId: string): Promise<TempoCancelResult> {
    logger.info("Canceling Tempo hold", { context: { paymentId } });

    const call = await this.callTool("tempo_cancel_hold", { paymentId });

    if (this.isAuthError(call)) {
      logger.error("KeeperHub tempo_cancel_hold auth failure", {
        context: { paymentId },
      });
      return { ok: false, error: this.authErrorMessage() };
    }

    if (call.timedOut || call.error || call.rpcError) {
      logger.error("KeeperHub tempo_cancel_hold network/RPC failure", {
        context: {
          paymentId,
          status: call.status,
          error: call.error?.message,
          rpcError: call.rpcError,
        },
      });
      return {
        ok: false,
        error:
          call.rpcError?.message ||
          call.error?.message ||
          "Network timeout awaiting KeeperHub tempo_cancel_hold response.",
      };
    }

    const p = call.parsed;
    if (call.isToolError || !p || p.ok === false || p.error) {
      logger.warn("KeeperHub tempo_cancel_hold rejected the request", {
        context: { paymentId, rawText: call.text },
      });
      return {
        ok: false,
        error: p?.error || call.text || "KeeperHub tempo_cancel_hold failed.",
      };
    }

    return { ok: true, status: p.status ?? "canceled" };
  }
}
