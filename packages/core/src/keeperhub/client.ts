import type {
  AuditEntry,
  CheckAndExecuteExecutionIntent,
  CheckAndExecuteIntent,
  DryRunIntent,
  DryRunResult,
  DryRunToken,
  ExecutionIntent,
  ExecutionResult,
  KeeperHubConfig,
  ProtocolActionIntent,
} from "../types/index.js";
import type { KeeperHubTransport } from "./transport.js";
import { MockKeeperHubTransport } from "./mock-transport.js";
import { LiveKeeperHubTransport } from "./live-transport.js";
import { OnChainKeeperHubTransport } from "./onchain-transport.js";
import {
  FirewallValidator,
  computeCheckAndExecuteIntentHash,
} from "../firewall/validator.js";
import { CircuitBreaker } from "../firewall/circuit-breaker.js";
import {
  type IdempotencyStore,
  MemoryIdempotencyStore,
  generateSemanticIdempotencyKey,
} from "./idempotency.js";
import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("KeeperHubClient");

export class KeeperHubClient {
  private config: KeeperHubConfig;
  private transport: KeeperHubTransport;
  private firewall: FirewallValidator;
  private circuitBreaker: CircuitBreaker;
  private idempotencyStore: IdempotencyStore;

  // Cache active approved dry-run tokens by tokenId
  private activeDryRunTokens = new Map<string, DryRunToken>();

  constructor(
    config: KeeperHubConfig,
    dependencies?: {
      transport?: KeeperHubTransport;
      idempotencyStore?: IdempotencyStore;
      circuitBreaker?: CircuitBreaker;
    },
  ) {
    this.config = config;
    this.firewall = new FirewallValidator(config.policy);
    this.idempotencyStore =
      dependencies?.idempotencyStore ?? new MemoryIdempotencyStore();
    this.circuitBreaker = dependencies?.circuitBreaker ?? new CircuitBreaker();

    if (dependencies?.transport) {
      this.transport = dependencies.transport;
    } else if (config.mode === "live") {
      if (config.apiKey) {
        this.transport = new LiveKeeperHubTransport({
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          network: config.policy.network,
        });
      } else if (config.privateKey) {
        this.transport = new OnChainKeeperHubTransport({
          privateKey: config.privateKey as `0x${string}`,
          rpcUrl: config.rpcUrl,
        });
      } else {
        throw new Error(
          "KeeperHubClient mode 'live' requires either config.apiKey (KeeperHub MCP) or config.privateKey (direct on-chain fallback).",
        );
      }
    } else {
      this.transport = new MockKeeperHubTransport();
    }
  }

  public getConfig(): Readonly<KeeperHubConfig> {
    return this.config;
  }

  public getFirewall(): FirewallValidator {
    return this.firewall;
  }

  public getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  public getIdempotencyStore(): IdempotencyStore {
    return this.idempotencyStore;
  }

  public getTransport(): KeeperHubTransport {
    return this.transport;
  }

  /**
   * Pre-Flight Simulation with Invariant Validation and Firewall Guard
   */
  public async dryRun(intent: DryRunIntent): Promise<DryRunResult> {
    logger.info("Evaluating dryRun intent", {
      context: {
        recipient: intent.recipient,
        amount: intent.amount.toString(),
      },
    });

    // 1. Circuit Breaker Guard
    if (!this.circuitBreaker.isExecutionAllowed()) {
      logger.warn("dryRun blocked: Circuit breaker is OPEN");
      return {
        ok: false,
        error:
          "CIRCUIT_BREAKER_OPEN: All outbound writes are temporarily halted due to repeated failures.",
      };
    }

    // 2. Firewall Policy Guard
    const validation = this.firewall.validateIntent(intent);
    if (!validation.valid) {
      logger.warn("dryRun blocked by Firewall", {
        context: { reason: validation.reason },
      });
      return {
        ok: false,
        revertReason: validation.reason,
        error: `FIREWALL_BLOCKED: ${validation.message}`,
      };
    }

    // 3. Transport Simulation
    const result = await this.transport.dryRun(intent);
    if (!result.ok) {
      this.circuitBreaker.recordFailure(result.revertReason || result.error);
      return result;
    }

    // 4. Record active DryRunToken with TTL
    if (result.token) {
      this.activeDryRunTokens.set(result.token.tokenId, result.token);
    }

    return result;
  }

  /**
   * Deterministic Onchain Execution via Turnkey Enclave with 3-State Lifecycle
   */
  public async execute(intent: ExecutionIntent): Promise<ExecutionResult> {
    logger.info("Received execution request", {
      idempotencyKey: intent.idempotencyKey,
      context: {
        recipient: intent.recipient,
        amount: intent.amount.toString(),
      },
    });

    // 1. Circuit Breaker Check
    if (!this.circuitBreaker.isExecutionAllowed()) {
      return {
        state: "FAILED",
        idempotencyKey: intent.idempotencyKey,
        error: "CIRCUIT_BREAKER_OPEN: Outbound execution is locked.",
      };
    }

    // 2. Idempotency Check: if already executed or pending, return cached state
    const existing = this.idempotencyStore.get(intent.idempotencyKey);
    if (existing && existing.result) {
      logger.info("Returning cached idempotency result", {
        idempotencyKey: intent.idempotencyKey,
      });
      return existing.result;
    }

    // 3. Retrieve dry-run token
    const token = this.activeDryRunTokens.get(intent.dryRunTokenId);

    // 4. Firewall Execution & TTL Validation
    const validation = this.firewall.validateExecution(intent, token);
    if (!validation.valid) {
      return {
        state: "FAILED",
        idempotencyKey: intent.idempotencyKey,
        error: `FIREWALL_EXECUTION_BLOCKED: ${validation.message}`,
        revertReason: validation.reason,
      };
    }

    // 5. Persist Idempotency Record PRE-REQUEST
    this.idempotencyStore.savePreRequest({
      key: intent.idempotencyKey,
      recipient: intent.recipient,
      amount: intent.amount.toString(),
      actionPayloadHash: this.firewall.computeIntentHash(intent),
      state: "UNKNOWN", // Initial state is unknown until receipt
    });

    // 6. Broadcast via Transport
    const result = await this.transport.execute(intent);

    // 7. Update Idempotency Store and Circuit Breaker
    this.idempotencyStore.updateState(
      intent.idempotencyKey,
      result.state,
      result,
    );

    if (result.state === "CONFIRMED") {
      this.circuitBreaker.recordSuccess();
      this.firewall.recordSpend(intent.amount);
      // Consume the dryRunToken so it cannot be re-used
      this.activeDryRunTokens.delete(intent.dryRunTokenId);
    } else if (result.state === "FAILED") {
      this.circuitBreaker.recordFailure(result.revertReason || result.error);
    } else if (result.state === "UNKNOWN") {
      this.circuitBreaker.recordUnknown(result.error);
    }

    return result;
  }

  /**
   * Reconciles an UNKNOWN or timed-out transaction
   */
  public async reconcile(idempotencyKey: string): Promise<ExecutionResult> {
    logger.info("Reconciling idempotency key", { idempotencyKey });

    const result = await this.transport.reconcile(idempotencyKey);
    this.idempotencyStore.updateState(idempotencyKey, result.state, result);

    if (result.state === "CONFIRMED") {
      this.circuitBreaker.recordSuccess();
    } else if (result.state === "FAILED") {
      this.circuitBreaker.recordFailure(result.revertReason || result.error);
    } else if (result.state === "UNKNOWN") {
      this.circuitBreaker.recordUnknown(result.error);
    }

    return result;
  }

  /**
   * Retrieves audit record
   */
  public async getAudit(runId: string): Promise<AuditEntry | undefined> {
    return this.transport.getAudit(runId);
  }

  /**
   * Broadcasts a pre-built KeeperHub protocol action (e.g. "aave-v3/supply").
   * No dry-run/TTL/intent-hash step exists here — execute_protocol_action has
   * no simulate mode at all, so the actionType whitelist is the only
   * pre-flight gate available before it signs and broadcasts.
   */
  public async executeProtocolAction(
    intent: ProtocolActionIntent,
  ): Promise<ExecutionResult> {
    logger.info("Received protocol action request", {
      idempotencyKey: intent.idempotencyKey,
      context: { actionType: intent.actionType },
    });

    if (!this.circuitBreaker.isExecutionAllowed()) {
      return {
        state: "FAILED",
        idempotencyKey: intent.idempotencyKey,
        error: "CIRCUIT_BREAKER_OPEN: Outbound execution is locked.",
      };
    }

    const existing = this.idempotencyStore.get(intent.idempotencyKey);
    if (existing && existing.result) {
      logger.info("Returning cached idempotency result", {
        idempotencyKey: intent.idempotencyKey,
      });
      return existing.result;
    }

    const validation = this.firewall.validateProtocolAction(intent.actionType);
    if (!validation.valid) {
      return {
        state: "FAILED",
        idempotencyKey: intent.idempotencyKey,
        error: `FIREWALL_BLOCKED: ${validation.message}`,
        revertReason: validation.reason,
      };
    }

    this.idempotencyStore.savePreRequest({
      key: intent.idempotencyKey,
      recipient: intent.actionType,
      amount: "0",
      actionPayloadHash: JSON.stringify(intent.params),
      state: "UNKNOWN",
    });

    const result = await this.transport.executeProtocolAction(intent);

    this.idempotencyStore.updateState(
      intent.idempotencyKey,
      result.state,
      result,
    );

    if (result.state === "CONFIRMED") {
      this.circuitBreaker.recordSuccess();
    } else if (result.state === "FAILED") {
      this.circuitBreaker.recordFailure(result.revertReason || result.error);
    } else if (result.state === "UNKNOWN") {
      this.circuitBreaker.recordUnknown(result.error);
    }

    return result;
  }

  /**
   * Pre-flight simulation for an atomic check-and-execute intent. Only the
   * action side (contractAddress/functionName) is firewall-gated — the check
   * is a read call, nothing to protect.
   */
  public async checkAndExecuteDryRun(
    intent: CheckAndExecuteIntent,
  ): Promise<DryRunResult> {
    logger.info("Evaluating check-and-execute dryRun intent", {
      context: {
        checkContract: intent.check.contractAddress,
        actionContract: intent.action.contractAddress,
      },
    });

    if (!this.circuitBreaker.isExecutionAllowed()) {
      logger.warn("check-and-execute dryRun blocked: Circuit breaker is OPEN");
      return {
        ok: false,
        error:
          "CIRCUIT_BREAKER_OPEN: All outbound writes are temporarily halted due to repeated failures.",
      };
    }

    const validation = this.firewall.validateIntent({
      recipient: intent.action.contractAddress,
      amount: intent.action.value ?? 0n,
      method: intent.action.functionName,
    });
    if (!validation.valid) {
      logger.warn("check-and-execute dryRun blocked by Firewall", {
        context: { reason: validation.reason },
      });
      return {
        ok: false,
        revertReason: validation.reason,
        error: `FIREWALL_BLOCKED: ${validation.message}`,
      };
    }

    const result = await this.transport.checkAndExecuteDryRun(intent);
    if (!result.ok) {
      this.circuitBreaker.recordFailure(result.revertReason || result.error);
      return result;
    }

    if (result.token) {
      this.activeDryRunTokens.set(result.token.tokenId, result.token);
    }

    return result;
  }

  /**
   * Broadcasts an approved check-and-execute intent. Re-validates the action
   * side against the firewall, the dry-run token's TTL, and its intent-hash
   * binding (via computeCheckAndExecuteIntentHash — a different hash than
   * transfers/contract calls use, since the intent shape is structurally
   * different, so this can't reuse FirewallValidator.validateExecution()).
   */
  public async checkAndExecuteExecute(
    intent: CheckAndExecuteExecutionIntent,
  ): Promise<ExecutionResult> {
    logger.info("Received check-and-execute request", {
      idempotencyKey: intent.idempotencyKey,
      context: {
        checkContract: intent.check.contractAddress,
        actionContract: intent.action.contractAddress,
      },
    });

    if (!this.circuitBreaker.isExecutionAllowed()) {
      return {
        state: "FAILED",
        idempotencyKey: intent.idempotencyKey,
        error: "CIRCUIT_BREAKER_OPEN: Outbound execution is locked.",
      };
    }

    const existing = this.idempotencyStore.get(intent.idempotencyKey);
    if (existing && existing.result) {
      logger.info("Returning cached idempotency result", {
        idempotencyKey: intent.idempotencyKey,
      });
      return existing.result;
    }

    const policy = this.firewall.getPolicy();

    const baseValidation = this.firewall.validateIntent({
      recipient: intent.action.contractAddress,
      amount: intent.action.value ?? 0n,
      method: intent.action.functionName,
    });
    if (!baseValidation.valid) {
      return {
        state: "FAILED",
        idempotencyKey: intent.idempotencyKey,
        error: `FIREWALL_EXECUTION_BLOCKED: ${baseValidation.message}`,
        revertReason: baseValidation.reason,
      };
    }

    const token = this.activeDryRunTokens.get(intent.dryRunTokenId);

    if (policy.requireSimulationSuccess) {
      if (!token) {
        return {
          state: "FAILED",
          idempotencyKey: intent.idempotencyKey,
          error:
            "FIREWALL_EXECUTION_BLOCKED: Execution requires an approved pre-flight dry-run token.",
          revertReason: "DRY_RUN_REQUIRED",
        };
      }

      const ttl = policy.dryRunTtlMs ?? 60_000;
      if (Date.now() > token.issuedAt + ttl) {
        return {
          state: "FAILED",
          idempotencyKey: intent.idempotencyKey,
          error:
            "FIREWALL_EXECUTION_BLOCKED: Dry-run token expired. Re-run simulation before broadcasting.",
          revertReason: "DRY_RUN_TOKEN_EXPIRED",
        };
      }

      const currentHash = computeCheckAndExecuteIntentHash(intent);
      if (token.intentHash !== currentHash) {
        return {
          state: "FAILED",
          idempotencyKey: intent.idempotencyKey,
          error:
            "FIREWALL_EXECUTION_BLOCKED: Transaction payload does not match the intent authorized in the dry-run simulation.",
          revertReason: "DRY_RUN_INTENT_MISMATCH",
        };
      }
    }

    this.idempotencyStore.savePreRequest({
      key: intent.idempotencyKey,
      recipient: intent.action.contractAddress,
      amount: (intent.action.value ?? 0n).toString(),
      actionPayloadHash: computeCheckAndExecuteIntentHash(intent),
      state: "UNKNOWN",
    });

    const result = await this.transport.checkAndExecuteExecute(intent);

    this.idempotencyStore.updateState(
      intent.idempotencyKey,
      result.state,
      result,
    );

    if (result.state === "CONFIRMED") {
      this.circuitBreaker.recordSuccess();
      this.firewall.recordSpend(intent.action.value ?? 0n);
      this.activeDryRunTokens.delete(intent.dryRunTokenId);
    } else if (result.state === "FAILED") {
      this.circuitBreaker.recordFailure(result.revertReason || result.error);
    } else if (result.state === "UNKNOWN") {
      this.circuitBreaker.recordUnknown(result.error);
    }

    return result;
  }

  /**
   * Generates a pre-bound semantic idempotency key
   */
  public createIdempotencyKey(params: {
    senderId?: string;
    recipient: string;
    amount: bigint;
    calldata?: string;
  }): string {
    return generateSemanticIdempotencyKey(params);
  }
}
