import type { CircuitState } from "../types/index.js";
import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("CircuitBreaker");

export interface CircuitBreakerConfig {
  failureThreshold?: number; // Default 3 consecutive failures
  unknownThreshold?: number; // Default 2 consecutive unknown states
  cooldownMs?: number; // Default 15 minutes (900,000 ms)
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private consecutiveUnknowns = 0;
  private lastTrippedAt = 0;

  private readonly failureThreshold: number;
  private readonly unknownThreshold: number;
  private readonly cooldownMs: number;

  constructor(config?: CircuitBreakerConfig) {
    this.failureThreshold = config?.failureThreshold ?? 3;
    this.unknownThreshold = config?.unknownThreshold ?? 2;
    this.cooldownMs = config?.cooldownMs ?? 15 * 60 * 1000;
  }

  public getState(): CircuitState {
    this.checkCooldown();
    return this.state;
  }

  public isExecutionAllowed(): boolean {
    const currentState = this.getState();
    return currentState === "CLOSED" || currentState === "HALF_OPEN";
  }

  public recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      logger.info(
        "Circuit breaker recovered: transitioning from HALF_OPEN to CLOSED",
      );
    }
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.consecutiveUnknowns = 0;
  }

  public recordFailure(reason?: string): void {
    this.consecutiveFailures++;
    logger.warn(
      `Execution failure recorded (${this.consecutiveFailures}/${this.failureThreshold})`,
      {
        context: { reason, state: this.state },
      },
    );

    if (
      this.state === "HALF_OPEN" ||
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.trip(
        `Exceeded consecutive failure threshold (${this.consecutiveFailures})`,
      );
    }
  }

  public recordUnknown(reason?: string): void {
    this.consecutiveUnknowns++;
    logger.warn(
      `Unknown state recorded (${this.consecutiveUnknowns}/${this.unknownThreshold})`,
      {
        context: { reason, state: this.state },
      },
    );

    if (
      this.state === "HALF_OPEN" ||
      this.consecutiveUnknowns >= this.unknownThreshold
    ) {
      this.trip(
        `Exceeded consecutive unknown state threshold (${this.consecutiveUnknowns})`,
      );
    }
  }

  private trip(reason: string): void {
    this.state = "OPEN";
    this.lastTrippedAt = Date.now();
    logger.error(
      "Circuit breaker TRIPPED to OPEN: All outbound executions are locked",
      {
        context: { reason, cooldownMs: this.cooldownMs },
      },
    );
  }

  private checkCooldown(): void {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - this.lastTrippedAt;
      if (elapsed >= this.cooldownMs) {
        this.state = "HALF_OPEN";
        logger.info(
          "Circuit breaker cooldown elapsed: transitioning to HALF_OPEN trial state",
        );
      }
    }
  }

  public reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.consecutiveUnknowns = 0;
    this.lastTrippedAt = 0;
  }

  public forceOpen(): void {
    this.trip("Manually forced open by operator/policy");
  }
}
