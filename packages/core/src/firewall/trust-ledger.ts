import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("TrustLedger");

/** Plain-data snapshot of a TrustLedger's internal counters, for opt-in
 * external persistence (see KeeperHubClientOptions.persistDir) — same
 * filesystem-agnostic convention as CircuitBreakerSnapshot. */
export interface TrustLedgerSnapshot {
  totalBlockedAttempts: number;
  blockedByReason: Record<string, number>;
  totalConfirmedExecutions: number;
  totalFailedExecutions: number;
  totalUnknownExecutions: number;
  trackingSince: number;
}

/**
 * Counts firewall blocks (by reason) and real execution outcomes across
 * every validation/execution path in KeeperHubClient. This is a
 * self-reported, locally-persisted record an agent exposes about its own
 * behavior — not a hosted or cryptographically-attested service, and not
 * queryable by a counterparty unless it has direct access to this same
 * running instance. See docs/LIMITATIONS.md for that scope boundary.
 */
export class TrustLedger {
  private totalBlockedAttempts = 0;
  private blockedByReason: Record<string, number> = {};
  private totalConfirmedExecutions = 0;
  private totalFailedExecutions = 0;
  private totalUnknownExecutions = 0;
  private trackingSince = Date.now();

  public recordBlocked(reason: string): void {
    this.totalBlockedAttempts++;
    this.blockedByReason[reason] = (this.blockedByReason[reason] ?? 0) + 1;
    logger.info("Recorded a firewall block", {
      context: { reason, totalBlockedAttempts: this.totalBlockedAttempts },
    });
  }

  public recordConfirmed(): void {
    this.totalConfirmedExecutions++;
  }

  public recordFailed(): void {
    this.totalFailedExecutions++;
  }

  public recordUnknown(): void {
    this.totalUnknownExecutions++;
  }

  public getSnapshot(): TrustLedgerSnapshot {
    return {
      totalBlockedAttempts: this.totalBlockedAttempts,
      blockedByReason: { ...this.blockedByReason },
      totalConfirmedExecutions: this.totalConfirmedExecutions,
      totalFailedExecutions: this.totalFailedExecutions,
      totalUnknownExecutions: this.totalUnknownExecutions,
      trackingSince: this.trackingSince,
    };
  }

  public restoreSnapshot(snapshot: TrustLedgerSnapshot): void {
    this.totalBlockedAttempts = snapshot.totalBlockedAttempts;
    this.blockedByReason = { ...snapshot.blockedByReason };
    this.totalConfirmedExecutions = snapshot.totalConfirmedExecutions;
    this.totalFailedExecutions = snapshot.totalFailedExecutions;
    this.totalUnknownExecutions = snapshot.totalUnknownExecutions;
    this.trackingSince = snapshot.trackingSince;
  }
}
