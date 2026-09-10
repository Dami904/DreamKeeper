import type { ExecutionState } from "../types/index.js";
import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("ExecutionStateMachine");

export class ExecutionStateMachine {
  /**
   * Evaluates raw transport/network result and maps it deterministically to 3-state enum
   */
  public static classifyResponse(response: {
    statusCode?: number | undefined;
    networkError?: Error | null | undefined;
    timedOut?: boolean | undefined;
    txHash?: string | undefined;
    revertReason?: string | undefined;
    serverMessage?: string | undefined;
  }): {
    state: ExecutionState;
    error?: string | undefined;
    revertReason?: string | undefined;
  } {
    // 1. Network drop, timeout, or dropped socket -> UNKNOWN
    if (response.timedOut || response.networkError) {
      logger.warn(
        "Classified response as UNKNOWN due to transport/timeout error",
        {
          context: {
            timedOut: response.timedOut,
            error: response.networkError?.message,
          },
        },
      );
      return {
        state: "UNKNOWN",
        error: `Network timeout or dropped connection: ${response.networkError?.message || "Operation timed out without server acknowledgment."}`,
      };
    }

    // 2. 5xx Server Error -> UNKNOWN (server may have processed or queued the transaction)
    if (response.statusCode && response.statusCode >= 500) {
      logger.warn(
        "Classified response as UNKNOWN due to HTTP 5xx server status",
        {
          context: {
            statusCode: response.statusCode,
            message: response.serverMessage,
          },
        },
      );
      return {
        state: "UNKNOWN",
        error: `HTTP ${response.statusCode}: KeeperHub server error. Transaction status indeterminate until reconciled.`,
      };
    }

    // 3. 4xx Client Error or Pre-Flight Rejection -> FAILED
    if (
      response.statusCode &&
      response.statusCode >= 400 &&
      response.statusCode < 500
    ) {
      logger.info("Classified response as FAILED due to 4xx client rejection", {
        context: {
          statusCode: response.statusCode,
          message: response.serverMessage,
        },
      });
      return {
        state: "FAILED",
        error:
          response.serverMessage ||
          `HTTP ${response.statusCode}: Request rejected by execution gateway.`,
      };
    }

    // 4. Onchain Reversion -> FAILED
    if (response.revertReason) {
      logger.info(
        "Classified response as FAILED due to onchain execution revert",
        {
          context: { revertReason: response.revertReason },
        },
      );
      return {
        state: "FAILED",
        revertReason: response.revertReason,
        error: `Transaction reverted on-chain: ${response.revertReason}`,
      };
    }

    // 5. Positive Proof of Inclusion (Mined Tx Hash) -> CONFIRMED
    if (response.txHash && /^0x[a-fA-F0-9]{64}$/.test(response.txHash)) {
      logger.info("Classified response as CONFIRMED with verified txHash", {
        context: { txHash: response.txHash },
      });
      return {
        state: "CONFIRMED",
      };
    }

    // Fallback: If 200 OK was returned without a definitive txHash, status is UNKNOWN until verified
    logger.warn(
      "200 OK received without verified txHash; treating as UNKNOWN until reconciled",
    );
    return {
      state: "UNKNOWN",
      error: "Execution accepted but pending confirmation on-chain.",
    };
  }

  /**
   * Validates legal state transitions
   */
  public static canTransition(
    current: ExecutionState,
    next: ExecutionState,
  ): boolean {
    if (current === next) return true;

    switch (current) {
      case "UNKNOWN":
        // UNKNOWN can resolve to either CONFIRMED or FAILED once reconciled
        return next === "CONFIRMED" || next === "FAILED";
      case "FAILED":
        // Terminal state: cannot transition
        return false;
      case "CONFIRMED":
        // Terminal state: cannot transition
        return false;
      default:
        return false;
    }
  }
}
