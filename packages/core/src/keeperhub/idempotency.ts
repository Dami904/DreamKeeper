import { createHash, randomUUID } from "node:crypto";
import type { ExecutionResult, ExecutionState } from "../types/index.js";
import { StructuredLogger } from "../logger/index.js";
import { readJsonFile, writeJsonFile } from "../persistence/file-store.js";

const logger = new StructuredLogger("IdempotencyStore");

export interface IdempotencyRecord {
  key: string;
  createdAt: number;
  recipient: string;
  amount: string;
  actionPayloadHash: string;
  state: ExecutionState;
  result?: ExecutionResult;
}

export interface IdempotencyStore {
  savePreRequest(record: Omit<IdempotencyRecord, "createdAt">): void;
  updateState(
    key: string,
    state: ExecutionState,
    result?: ExecutionResult,
  ): void;
  get(key: string): IdempotencyRecord | undefined;
  has(key: string): boolean;
}

/**
 * In-Memory Idempotency Store (with deterministic pre-request registration)
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();

  public savePreRequest(record: Omit<IdempotencyRecord, "createdAt">): void {
    if (this.records.has(record.key)) {
      logger.warn("Idempotency record already exists before request", {
        idempotencyKey: record.key,
      });
      return;
    }

    const fullRecord: IdempotencyRecord = {
      ...record,
      createdAt: Date.now(),
    };

    this.records.set(record.key, fullRecord);
    logger.debug("Persisted pre-request idempotency record", {
      idempotencyKey: record.key,
      context: { state: record.state, recipient: record.recipient },
    });
  }

  public updateState(
    key: string,
    state: ExecutionState,
    result?: ExecutionResult,
  ): void {
    const existing = this.records.get(key);
    if (!existing) {
      logger.error("Attempted to update non-existent idempotency record", {
        idempotencyKey: key,
      });
      return;
    }

    existing.state = state;
    if (result) {
      existing.result = result;
    }

    this.records.set(key, existing);
    logger.debug("Updated idempotency record state", {
      idempotencyKey: key,
      context: { newState: state },
    });
  }

  public get(key: string): IdempotencyRecord | undefined {
    return this.records.get(key);
  }

  public has(key: string): boolean {
    return this.records.has(key);
  }

  public clear(): void {
    this.records.clear();
  }
}

/**
 * File-backed Idempotency Store — opt-in persistence for a single-process
 * CLI/demo deployment. Reads the whole table into memory on construction and
 * rewrites the whole file on every write; this is a simple bookkeeping table
 * (idempotency keys, not a high-throughput ledger), so this is deliberately
 * not optimized for concurrent/high-volume writes. A real multi-instance or
 * serverless deployment should implement `IdempotencyStore` against a real
 * database instead (see docs/LIMITATIONS.md).
 */
export class FileIdempotencyStore implements IdempotencyStore {
  private records: Record<string, IdempotencyRecord>;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.records = readJsonFile<Record<string, IdempotencyRecord>>(
      filePath,
      {},
    );
  }

  private persist(): void {
    writeJsonFile(this.filePath, this.records);
  }

  public savePreRequest(record: Omit<IdempotencyRecord, "createdAt">): void {
    if (this.records[record.key]) {
      logger.warn("Idempotency record already exists before request", {
        idempotencyKey: record.key,
      });
      return;
    }
    this.records[record.key] = { ...record, createdAt: Date.now() };
    this.persist();
    logger.debug("Persisted pre-request idempotency record to disk", {
      idempotencyKey: record.key,
      context: { state: record.state, recipient: record.recipient },
    });
  }

  public updateState(
    key: string,
    state: ExecutionState,
    result?: ExecutionResult,
  ): void {
    const existing = this.records[key];
    if (!existing) {
      logger.error("Attempted to update non-existent idempotency record", {
        idempotencyKey: key,
      });
      return;
    }
    existing.state = state;
    if (result) {
      existing.result = result;
    }
    this.persist();
    logger.debug("Updated idempotency record state on disk", {
      idempotencyKey: key,
      context: { newState: state },
    });
  }

  public get(key: string): IdempotencyRecord | undefined {
    return this.records[key];
  }

  public has(key: string): boolean {
    return key in this.records;
  }

  public clear(): void {
    this.records = {};
    this.persist();
  }
}

/**
 * Helper to generate a cryptographically bound semantic idempotency key
 */
export function generateSemanticIdempotencyKey(params: {
  senderId?: string;
  recipient: string;
  amount: bigint;
  calldata?: string;
}): string {
  const normalized = JSON.stringify({
    sender: params.senderId || "default-agent",
    recipient: params.recipient.toLowerCase(),
    amount: params.amount.toString(),
    calldata: params.calldata?.toLowerCase() || "",
  });

  const hashPrefix = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
  const nonce = randomUUID().slice(0, 8);
  return `dk_${hashPrefix}_${nonce}`;
}
