import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StructuredLogger } from "../logger/index.js";

const logger = new StructuredLogger("FileStore");

/**
 * Reads a JSON file synchronously, returning `fallback` if the file doesn't
 * exist yet or fails to parse. Synchronous and dependency-free (plain `fs`)
 * on purpose — this backs opt-in persistence for a CLI/demo-scale process,
 * not a high-throughput server; a real deployment should inject a proper
 * database via the existing `IdempotencyStore` interface instead.
 */
export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err) {
    logger.warn("Failed to read/parse persistence file, using fallback", {
      context: {
        path,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return fallback;
  }
}

/**
 * Writes a JSON file synchronously, creating the parent directory if it
 * doesn't exist yet.
 */
export function writeJsonFile(path: string, data: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}
