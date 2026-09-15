import { createHash } from "node:crypto";
import type {
  CheckAndExecuteIntent,
  DryRunIntent,
  DryRunToken,
  ExecutionIntent,
  FirewallPolicy,
  TempoHoldIntent,
} from "../types/index.js";
import { SUPPORTED_NETWORK_CHAIN_IDS } from "../types/index.js";
import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("FirewallValidator");

export interface ValidationSuccess {
  valid: true;
}

export interface ValidationFailure {
  valid: false;
  reason:
    | "RECIPIENT_NOT_WHITELISTED"
    | "AMOUNT_EXCEEDS_TX_CAP"
    | "AMOUNT_EXCEEDS_DAILY_LIMIT"
    | "METHOD_NOT_ALLOWED"
    | "DRY_RUN_REQUIRED"
    | "DRY_RUN_TOKEN_EXPIRED"
    | "DRY_RUN_INTENT_MISMATCH"
    | "PROTOCOL_ACTION_NOT_ALLOWED"
    | "PROTOCOL_ACTION_NETWORK_MISMATCH"
    | "TEMPO_NETWORK_NOT_ALLOWED"
    | "TEMPO_TOKEN_NOT_ALLOWED"
    | "TEMPO_AMOUNT_EXCEEDS_HOLD_CAP"
    | "TEMPO_AMOUNT_EXCEEDS_DAILY_LIMIT"
    | "TEMPO_PAYMENT_ID_UNKNOWN";
  message: string;
  details?: Record<string, unknown>;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

interface DailySpendEntry {
  amount: bigint;
  timestamp: number;
}

interface TempoDailySpendEntry {
  amount: bigint;
  timestamp: number;
}

/** Fixed decimal precision used for internal Tempo cap bookkeeping — this is
 * cap-enforcement precision, not the token's actual on-chain decimals, which
 * KeeperHub handles separately. */
const TEMPO_AMOUNT_DECIMALS = 6;

/**
 * Converts a human-readable Tempo decimal amount string (e.g. "1.50") into a
 * bigint scaled to TEMPO_AMOUNT_DECIMALS, without ever going through
 * Number.parseFloat — repeated float addition on a rolling spend history
 * (this.tempoSpendHistory) risks precision drift that a single parseFloat
 * comparison wouldn't show.
 */
export function parseTempoAmountMicros(amount: string): bigint {
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const [wholePart, fractionalPart = ""] = unsigned.split(".");
  const paddedFraction = (
    fractionalPart + "0".repeat(TEMPO_AMOUNT_DECIMALS)
  ).slice(0, TEMPO_AMOUNT_DECIMALS);
  const digits = `${wholePart || "0"}${paddedFraction}`;
  const value = BigInt(digits);
  return negative ? -value : value;
}

/** Converts a static config cap (a plain JS number) to the same micro-unit
 * scale used for parsed Tempo amounts, for comparison purposes only. */
function tempoCapToMicros(cap: number): bigint {
  return BigInt(Math.round(cap * 10 ** TEMPO_AMOUNT_DECIMALS));
}

/**
 * Calculates the SHA-256 hash binding an intent to a dry-run token.
 *
 * Exported standalone (not just as a FirewallValidator method) because every
 * transport (mock/live/on-chain) also builds this same hash locally when
 * constructing the DryRunToken it returns from dryRun() — they must all stay
 * byte-for-byte identical to FirewallValidator's own computation, or
 * validateExecution()'s token.intentHash comparison will spuriously fail
 * (DRY_RUN_INTENT_MISMATCH) even for an untampered intent. One shared
 * function is used everywhere instead of four duplicated copies.
 */
export function computeIntentHash(
  intent: DryRunIntent | ExecutionIntent,
): string {
  const canonical = JSON.stringify({
    recipient: intent.recipient.toLowerCase(),
    amount: intent.amount.toString(),
    calldata: intent.calldata?.toLowerCase() || "",
    token: intent.token?.toLowerCase() || "",
    method: intent.method?.toLowerCase() || "",
    functionArgs: intent.functionArgs || "",
    abi: intent.abi || "",
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Same purpose as computeIntentHash, for the structurally different
 * check-and-execute intent shape (a read-only check + a condition + a write
 * action, not a recipient/amount transfer or contract call).
 */
export function computeCheckAndExecuteIntentHash(
  intent: CheckAndExecuteIntent,
): string {
  const canonical = JSON.stringify({
    check: {
      contractAddress: intent.check.contractAddress.toLowerCase(),
      functionName: intent.check.functionName.toLowerCase(),
      functionArgs: intent.check.functionArgs || "",
      abi: intent.check.abi || "",
    },
    condition: {
      operator: intent.condition.operator,
      value: intent.condition.value.toLowerCase(),
    },
    action: {
      contractAddress: intent.action.contractAddress.toLowerCase(),
      functionName: intent.action.functionName.toLowerCase(),
      functionArgs: intent.action.functionArgs || "",
      abi: intent.action.abi || "",
      value: (intent.action.value ?? 0n).toString(),
    },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class FirewallValidator {
  private policy: FirewallPolicy;
  private spendHistory: DailySpendEntry[] = [];
  private tempoSpendHistory: TempoDailySpendEntry[] = [];
  private readonly defaultTtlMs = 60_000; // 60s TTL on dry-run tokens

  constructor(policy: FirewallPolicy) {
    this.policy = policy;
  }

  getPolicy(): Readonly<FirewallPolicy> {
    return this.policy;
  }

  updatePolicy(newPolicy: Partial<FirewallPolicy>): void {
    this.policy = { ...this.policy, ...newPolicy };
  }

  /**
   * Calculates SHA-256 hash of an intent to bind it to a dry-run token
   */
  public computeIntentHash(intent: DryRunIntent | ExecutionIntent): string {
    return computeIntentHash(intent);
  }

  /**
   * Validates pre-flight intent before any simulation or network call
   */
  public validateIntent(intent: DryRunIntent): ValidationResult {
    const normalizedRecipient = intent.recipient.toLowerCase();
    const allowed = this.policy.allowedRecipients.map((r) => r.toLowerCase());

    // 1. Recipient Whitelist Guard
    if (!allowed.includes(normalizedRecipient)) {
      logger.warn("Firewall blocked transaction: Recipient not whitelisted", {
        context: { recipient: intent.recipient, allowed },
      });
      return {
        valid: false,
        reason: "RECIPIENT_NOT_WHITELISTED",
        message: `Recipient ${intent.recipient} is not on the approved address whitelist.`,
        details: { recipient: intent.recipient },
      };
    }

    // 2. Per-Transaction Cap Guard
    if (intent.amount > this.policy.maxAmountPerTx) {
      logger.warn(
        "Firewall blocked transaction: Amount exceeds single tx limit",
        {
          context: {
            requestedAmount: intent.amount.toString(),
            maxAllowed: this.policy.maxAmountPerTx.toString(),
          },
        },
      );
      return {
        valid: false,
        reason: "AMOUNT_EXCEEDS_TX_CAP",
        message: `Transaction amount ${intent.amount} exceeds maximum allowed per transaction (${this.policy.maxAmountPerTx}).`,
        details: {
          requested: intent.amount.toString(),
          max: this.policy.maxAmountPerTx.toString(),
        },
      };
    }

    // 3. Rolling 24h Cumulative Daily Spend Guard
    const current24hSpend = this.getRolling24hSpend();
    if (current24hSpend + intent.amount > this.policy.maxCumulativeDailySpend) {
      logger.warn(
        "Firewall blocked transaction: Exceeds 24h daily velocity limit",
        {
          context: {
            current24hSpend: current24hSpend.toString(),
            requested: intent.amount.toString(),
            dailyLimit: this.policy.maxCumulativeDailySpend.toString(),
          },
        },
      );
      return {
        valid: false,
        reason: "AMOUNT_EXCEEDS_DAILY_LIMIT",
        message: `Transaction amount would cause 24h spend (${current24hSpend + intent.amount}) to exceed daily limit (${this.policy.maxCumulativeDailySpend}).`,
        details: {
          currentSpend: current24hSpend.toString(),
          limit: this.policy.maxCumulativeDailySpend.toString(),
        },
      };
    }

    // 4. Method / Calldata Selector Whitelist Guard (if configured)
    if (this.policy.allowedMethods && this.policy.allowedMethods.length > 0) {
      const method =
        intent.method ||
        (intent.calldata ? intent.calldata.slice(0, 10) : undefined);
      if (method && !this.policy.allowedMethods.includes(method)) {
        logger.warn(
          "Firewall blocked transaction: Function method/selector not allowed",
          {
            context: { method, allowedMethods: this.policy.allowedMethods },
          },
        );
        return {
          valid: false,
          reason: "METHOD_NOT_ALLOWED",
          message: `Method '${method}' is not approved for execution.`,
          details: { method },
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validates execution intent against dry-run token and TTL
   */
  public validateExecution(
    intent: ExecutionIntent,
    token?: DryRunToken,
  ): ValidationResult {
    // 1. Re-validate base policy invariants (including method whitelist,
    // previously silently skipped here since ExecutionIntent had no `method`
    // field to pass through)
    const baseValidation = this.validateIntent({
      recipient: intent.recipient,
      amount: intent.amount,
      calldata: intent.calldata,
      method: intent.method,
    });
    if (!baseValidation.valid) {
      return baseValidation;
    }

    // 2. Enforce dry-run token requirement
    if (this.policy.requireSimulationSuccess) {
      if (!token) {
        logger.error("Execution blocked: Missing required dry-run token");
        return {
          valid: false,
          reason: "DRY_RUN_REQUIRED",
          message: "Execution requires an approved pre-flight dry-run token.",
        };
      }

      // 3. Enforce TTL on dry-run token
      const now = Date.now();
      const ttl = this.policy.dryRunTtlMs ?? this.defaultTtlMs;
      if (now > token.issuedAt + ttl) {
        logger.warn("Execution blocked: Dry-run token has expired", {
          context: { issuedAt: token.issuedAt, now, ttl },
        });
        return {
          valid: false,
          reason: "DRY_RUN_TOKEN_EXPIRED",
          message: `Dry-run token expired ${now - (token.issuedAt + ttl)}ms ago. Re-run simulation before broadcasting.`,
          details: {
            issuedAt: token.issuedAt,
            expiredAt: token.issuedAt + ttl,
            now,
          },
        };
      }

      // 4. Enforce Intent Binding: intent executed must match intent simulated
      const currentHash = this.computeIntentHash(intent);
      if (token.intentHash !== currentHash) {
        logger.error(
          "Execution blocked: Intent mismatch with simulation token",
          {
            context: {
              expectedHash: token.intentHash,
              actualHash: currentHash,
            },
          },
        );
        return {
          valid: false,
          reason: "DRY_RUN_INTENT_MISMATCH",
          message:
            "Transaction payload does not match the intent authorized in the dry-run simulation.",
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validates a KeeperHub protocol action type against the whitelist.
   *
   * Unlike allowedMethods (which only applies "if configured", defaulting to
   * allow-all otherwise), this is default-deny even when unconfigured:
   * execute_protocol_action has no simulate/dry-run mode at all, so there is
   * no other safety net catching a bad call before it signs and broadcasts.
   * An empty/unset allowedProtocolActions means "no protocol actions
   * approved yet", not "all protocol actions approved".
   *
   * Also soft-checks `params.network` against the configured policy network
   * when present: only `actionType` is whitelisted otherwise, so an approved
   * action carrying an unexpected chain id in its params would previously
   * pass through unchecked. This only blocks an explicit mismatch — a
   * missing/unrecognized network is left to KeeperHub itself to reject.
   */
  public validateProtocolAction(
    actionType: string,
    params?: Record<string, unknown>,
  ): ValidationResult {
    const allowed = this.policy.allowedProtocolActions ?? [];
    if (!allowed.includes(actionType)) {
      logger.warn(
        "Firewall blocked protocol action: actionType not whitelisted",
        { context: { actionType, allowed } },
      );
      return {
        valid: false,
        reason: "PROTOCOL_ACTION_NOT_ALLOWED",
        message: `Protocol action '${actionType}' is not on the approved actionType whitelist.`,
        details: { actionType },
      };
    }

    const paramsNetwork = params?.["network"];
    const expectedChainId = SUPPORTED_NETWORK_CHAIN_IDS[this.policy.network];
    if (
      typeof paramsNetwork === "string" &&
      paramsNetwork !== expectedChainId
    ) {
      logger.warn(
        "Firewall blocked protocol action: params.network does not match policy network",
        {
          context: {
            actionType,
            paramsNetwork,
            policyNetwork: this.policy.network,
            expectedChainId,
          },
        },
      );
      return {
        valid: false,
        reason: "PROTOCOL_ACTION_NETWORK_MISMATCH",
        message: `Protocol action '${actionType}' targets network '${paramsNetwork}', but the firewall policy is configured for '${this.policy.network}' (chain id ${expectedChainId}).`,
        details: { actionType, paramsNetwork, expectedChainId },
      };
    }

    return { valid: true };
  }

  /**
   * Validates a Tempo sign-and-hold intent. Recipient reuses the same
   * allowedRecipients whitelist as the EVM path — a rogue address should be
   * blocked regardless of which KeeperHub tool tries to pay it. Network,
   * token, and amount caps are default-deny even when unconfigured, the same
   * posture as validateProtocolAction: there is no simulate/dry-run mode for
   * the network/token choice itself, and this is a brand-new value system
   * with no "unlimited by default" precedent in this codebase.
   */
  public validateTempoHold(intent: TempoHoldIntent): ValidationResult {
    const normalizedRecipient = intent.recipient.toLowerCase();
    const allowedRecipients = this.policy.allowedRecipients.map((r) =>
      r.toLowerCase(),
    );
    if (!allowedRecipients.includes(normalizedRecipient)) {
      logger.warn("Firewall blocked Tempo hold: Recipient not whitelisted", {
        context: { recipient: intent.recipient, allowed: allowedRecipients },
      });
      return {
        valid: false,
        reason: "RECIPIENT_NOT_WHITELISTED",
        message: `Recipient ${intent.recipient} is not on the approved address whitelist.`,
        details: { recipient: intent.recipient },
      };
    }

    const allowedNetworks = this.policy.allowedTempoNetworks ?? [];
    if (!allowedNetworks.includes(intent.network)) {
      logger.warn("Firewall blocked Tempo hold: network not whitelisted", {
        context: { network: intent.network, allowed: allowedNetworks },
      });
      return {
        valid: false,
        reason: "TEMPO_NETWORK_NOT_ALLOWED",
        message: `Tempo network '${intent.network}' is not on the approved network whitelist.`,
        details: { network: intent.network },
      };
    }

    const allowedTokens = (this.policy.allowedTempoTokens ?? []).map((t) =>
      t.toLowerCase(),
    );
    if (!allowedTokens.includes(intent.tokenAddress.toLowerCase())) {
      logger.warn("Firewall blocked Tempo hold: token not whitelisted", {
        context: { tokenAddress: intent.tokenAddress, allowed: allowedTokens },
      });
      return {
        valid: false,
        reason: "TEMPO_TOKEN_NOT_ALLOWED",
        message: `Tempo token '${intent.tokenAddress}' is not on the approved token whitelist.`,
        details: { tokenAddress: intent.tokenAddress },
      };
    }

    const amountMicros = parseTempoAmountMicros(intent.amount);
    const maxPerHold = this.policy.maxTempoAmountPerHold;
    const maxPerHoldMicros =
      maxPerHold === undefined ? undefined : tempoCapToMicros(maxPerHold);
    if (maxPerHoldMicros === undefined || amountMicros > maxPerHoldMicros) {
      logger.warn("Firewall blocked Tempo hold: amount exceeds per-hold cap", {
        context: { requestedAmount: intent.amount, maxAllowed: maxPerHold },
      });
      return {
        valid: false,
        reason: "TEMPO_AMOUNT_EXCEEDS_HOLD_CAP",
        message:
          maxPerHold === undefined
            ? "No maxTempoAmountPerHold is configured, so no Tempo hold is approved."
            : `Hold amount ${intent.amount} exceeds maximum allowed per hold (${maxPerHold}).`,
        details: { requested: intent.amount, max: maxPerHold },
      };
    }

    const currentTempo24hSpendMicros = this.getRollingTempo24hSpend();
    const maxDaily = this.policy.maxTempoCumulativeDailySpend;
    const maxDailyMicros =
      maxDaily === undefined ? undefined : tempoCapToMicros(maxDaily);
    if (
      maxDailyMicros === undefined ||
      currentTempo24hSpendMicros + amountMicros > maxDailyMicros
    ) {
      logger.warn(
        "Firewall blocked Tempo hold: exceeds 24h daily velocity limit",
        {
          context: {
            current24hSpend: currentTempo24hSpendMicros.toString(),
            requested: intent.amount,
            dailyLimit: maxDaily,
          },
        },
      );
      return {
        valid: false,
        reason: "TEMPO_AMOUNT_EXCEEDS_DAILY_LIMIT",
        message:
          maxDaily === undefined
            ? "No maxTempoCumulativeDailySpend is configured, so no Tempo hold is approved."
            : `Hold would cause 24h Tempo spend to exceed daily limit (${maxDaily}).`,
        details: {
          currentSpendMicros: currentTempo24hSpendMicros.toString(),
          limit: maxDaily,
        },
      };
    }

    return { valid: true };
  }

  /**
   * Records a confirmed Tempo spend (called only once a hold is actually
   * released/broadcast, mirroring recordSpend()'s CONFIRMED-only timing).
   */
  public recordTempoSpend(
    amount: string,
    timestamp: number = Date.now(),
  ): void {
    this.tempoSpendHistory.push({
      amount: parseTempoAmountMicros(amount),
      timestamp,
    });
    this.pruneOldTempoSpend();
  }

  /**
   * Calculates total Tempo spend within the past 24 hours, in micro-units
   * (see parseTempoAmountMicros) — bigint summation avoids the float
   * accumulation drift a Number-based reduce would risk over many entries.
   */
  public getRollingTempo24hSpend(now: number = Date.now()): bigint {
    const cutoff = now - 24 * 60 * 60 * 1000;
    return this.tempoSpendHistory
      .filter((entry) => entry.timestamp >= cutoff)
      .reduce((sum, entry) => sum + entry.amount, 0n);
  }

  private pruneOldTempoSpend(now: number = Date.now()): void {
    const cutoff = now - 24 * 60 * 60 * 1000;
    this.tempoSpendHistory = this.tempoSpendHistory.filter(
      (entry) => entry.timestamp >= cutoff,
    );
  }

  /**
   * Records a confirmed spend to update daily rolling velocity
   */
  public recordSpend(amount: bigint, timestamp: number = Date.now()): void {
    this.spendHistory.push({ amount, timestamp });
    this.pruneOldSpend();
  }

  /**
   * Calculates total spend within the past 24 hours
   */
  public getRolling24hSpend(now: number = Date.now()): bigint {
    const cutoff = now - 24 * 60 * 60 * 1000;
    return this.spendHistory
      .filter((entry) => entry.timestamp >= cutoff)
      .reduce((sum, entry) => sum + entry.amount, 0n);
  }

  private pruneOldSpend(now: number = Date.now()): void {
    const cutoff = now - 24 * 60 * 60 * 1000;
    this.spendHistory = this.spendHistory.filter(
      (entry) => entry.timestamp >= cutoff,
    );
  }

  public resetSpendHistory(): void {
    this.spendHistory = [];
    this.tempoSpendHistory = [];
  }
}
