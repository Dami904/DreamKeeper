import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker } from "../src/firewall/circuit-breaker.js";

describe("CircuitBreaker (Runaway Loop Protection)", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      unknownThreshold: 2,
      cooldownMs: 50, // 50ms for fast testing
    });
  });

  it("starts in CLOSED state allowing execution", () => {
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.isExecutionAllowed()).toBe(true);
  });

  it("trips to OPEN after 3 consecutive failures", () => {
    breaker.recordFailure("revert 1");
    expect(breaker.getState()).toBe("CLOSED");

    breaker.recordFailure("revert 2");
    expect(breaker.getState()).toBe("CLOSED");

    breaker.recordFailure("revert 3");
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.isExecutionAllowed()).toBe(false);
  });

  it("trips to OPEN after 2 consecutive UNKNOWN states", () => {
    breaker.recordUnknown("timeout 1");
    expect(breaker.getState()).toBe("CLOSED");

    breaker.recordUnknown("timeout 2");
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.isExecutionAllowed()).toBe(false);
  });

  it("recovers to HALF_OPEN after cooldown and resets to CLOSED on success", async () => {
    breaker.recordFailure("1");
    breaker.recordFailure("2");
    breaker.recordFailure("3");
    expect(breaker.getState()).toBe("OPEN");

    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(breaker.getState()).toBe("HALF_OPEN");
    expect(breaker.isExecutionAllowed()).toBe(true);

    // Record successful execution during trial
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.isExecutionAllowed()).toBe(true);
  });

  it("re-trips to OPEN immediately if a failure occurs in HALF_OPEN state", async () => {
    breaker.recordFailure("1");
    breaker.recordFailure("2");
    breaker.recordFailure("3");

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(breaker.getState()).toBe("HALF_OPEN");

    // Fails on trial
    breaker.recordFailure("trial failed");
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.isExecutionAllowed()).toBe(false);
  });
});
