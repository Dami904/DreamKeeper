import { createHash } from "node:crypto";
import type {
  DryRunIntent,
  DryRunToken,
  ExecutionIntent,
  FirewallPolicy,
} from "../types/index.js";
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
    | "DRY_RUN_INTENT_MISMATCH";
  message: string;
  details?: Record<string, unknown>;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

interface DailySpendEntry {
  amount: bigint;
  timestamp: number;
}

export class FirewallValidator {
  private policy: FirewallPolicy;
  private spendHistory: DailySpendEntry[] = [];
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
    const canonical = JSON.stringify({
      recipient: intent.recipient.toLowerCase(),
      amount: intent.amount.toString(),
      calldata: intent.calldata?.toLowerCase() || "",
    });
    return createHash("sha256").update(canonical).digest("hex");
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
    // 1. Re-validate base policy invariants
    const baseValidation = this.validateIntent({
      recipient: intent.recipient,
      amount: intent.amount,
      calldata: intent.calldata,
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
  }
}
