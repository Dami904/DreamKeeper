import { describe, it, expect } from "vitest";
import { ExecutionStateMachine } from "../src/keeperhub/state-machine.js";
import {
  MemoryIdempotencyStore,
  generateSemanticIdempotencyKey,
} from "../src/keeperhub/idempotency.js";

describe("ExecutionStateMachine & Idempotency Store", () => {
  describe("3-State Response Classification", () => {
    it("classifies verified txHash as CONFIRMED", () => {
      const result = ExecutionStateMachine.classifyResponse({
        txHash: "0x" + "a".repeat(64),
      });
      expect(result.state).toBe("CONFIRMED");
    });

    it("classifies HTTP 400 client rejection as FAILED", () => {
      const result = ExecutionStateMachine.classifyResponse({
        statusCode: 400,
        serverMessage: "Invalid recipient",
      });
      expect(result.state).toBe("FAILED");
      expect(result.error).toContain("Invalid recipient");
    });

    it("classifies on-chain revert as FAILED", () => {
      const result = ExecutionStateMachine.classifyResponse({
        revertReason: "INSUFFICIENT_OUTPUT_AMOUNT",
      });
      expect(result.state).toBe("FAILED");
      expect(result.revertReason).toBe("INSUFFICIENT_OUTPUT_AMOUNT");
    });

    it("classifies timeout as UNKNOWN (never FAILED)", () => {
      const result = ExecutionStateMachine.classifyResponse({
        timedOut: true,
      });
      expect(result.state).toBe("UNKNOWN");
    });

    it("classifies HTTP 502/504 as UNKNOWN (server state indeterminate)", () => {
      const result = ExecutionStateMachine.classifyResponse({
        statusCode: 504,
        serverMessage: "Gateway Timeout",
      });
      expect(result.state).toBe("UNKNOWN");
    });
  });

  describe("State Transition Safety", () => {
    it("allows UNKNOWN to transition to CONFIRMED on reconciliation", () => {
      expect(ExecutionStateMachine.canTransition("UNKNOWN", "CONFIRMED")).toBe(
        true,
      );
    });

    it("allows UNKNOWN to transition to FAILED on reconciliation", () => {
      expect(ExecutionStateMachine.canTransition("UNKNOWN", "FAILED")).toBe(
        true,
      );
    });

    it("disallows terminal CONFIRMED state to transition", () => {
      expect(ExecutionStateMachine.canTransition("CONFIRMED", "FAILED")).toBe(
        false,
      );
      expect(ExecutionStateMachine.canTransition("CONFIRMED", "UNKNOWN")).toBe(
        false,
      );
    });

    it("disallows terminal FAILED state to transition", () => {
      expect(ExecutionStateMachine.canTransition("FAILED", "CONFIRMED")).toBe(
        false,
      );
      expect(ExecutionStateMachine.canTransition("FAILED", "UNKNOWN")).toBe(
        false,
      );
    });
  });

  describe("Idempotency Persistence", () => {
    it("generates deterministic semantic keys bound to recipient, amount, and calldata", () => {
      const key1 = generateSemanticIdempotencyKey({
        senderId: "agent-1",
        recipient: "0x1111111111111111111111111111111111111111",
        amount: 500n,
      });

      const key2 = generateSemanticIdempotencyKey({
        senderId: "agent-1",
        recipient: "0x1111111111111111111111111111111111111111",
        amount: 500n,
      });

      // Keys have identical semantic hash prefix
      const prefix1 = key1.split("_")[1];
      const prefix2 = key2.split("_")[1];
      expect(prefix1).toBe(prefix2);
    });

    it("persists records pre-request and updates terminal state", () => {
      const store = new MemoryIdempotencyStore();
      const key = "test-idem-key";

      store.savePreRequest({
        key,
        recipient: "0x1111111111111111111111111111111111111111",
        amount: "1000",
        actionPayloadHash: "hash123",
        state: "UNKNOWN",
      });

      expect(store.get(key)?.state).toBe("UNKNOWN");

      store.updateState(key, "CONFIRMED", {
        state: "CONFIRMED",
        idempotencyKey: key,
        txHash: "0x" + "b".repeat(64),
      });

      expect(store.get(key)?.state).toBe("CONFIRMED");
      expect(store.get(key)?.result?.txHash).toBe("0x" + "b".repeat(64));
    });
  });
});
