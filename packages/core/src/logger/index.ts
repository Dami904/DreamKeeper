export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogPayload {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  traceId?: string | undefined;
  idempotencyKey?: string | undefined;
  runId?: string | undefined;
  context?: Record<string, unknown> | undefined;
  error?:
    | {
        name: string;
        message: string;
        stack?: string | undefined;
      }
    | undefined;
}

export class StructuredLogger {
  private component: string;
  private minLevel: LogLevel;
  private logs: LogPayload[] = []; // In-memory buffer for testing/auditing

  private readonly levelWeights: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };

  constructor(component: string, minLevel: LogLevel = "info") {
    this.component = component;
    this.minLevel = minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelWeights[level] >= this.levelWeights[this.minLevel];
  }

  private write(
    level: LogLevel,
    message: string,
    meta?: {
      traceId?: string;
      idempotencyKey?: string;
      runId?: string;
      context?: Record<string, unknown>;
      error?: Error;
    },
  ): LogPayload {
    const payload: LogPayload = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...(meta?.traceId ? { traceId: meta.traceId } : {}),
      ...(meta?.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
      ...(meta?.runId ? { runId: meta.runId } : {}),
      ...(meta?.context ? { context: meta.context } : {}),
      ...(meta?.error
        ? {
            error: {
              name: meta.error.name,
              message: meta.error.message,
              stack: meta.error.stack,
            },
          }
        : {}),
    };

    this.logs.push(payload);

    if (this.shouldLog(level)) {
      const output = JSON.stringify(payload, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      if (level === "error") {
        console.error(output);
      } else if (level === "warn") {
        console.warn(output);
      } else {
        console.log(output);
      }
    }

    return payload;
  }

  debug(
    message: string,
    meta?: Parameters<StructuredLogger["write"]>[2],
  ): LogPayload {
    return this.write("debug", message, meta);
  }

  info(
    message: string,
    meta?: Parameters<StructuredLogger["write"]>[2],
  ): LogPayload {
    return this.write("info", message, meta);
  }

  warn(
    message: string,
    meta?: Parameters<StructuredLogger["write"]>[2],
  ): LogPayload {
    return this.write("warn", message, meta);
  }

  error(
    message: string,
    meta?: Parameters<StructuredLogger["write"]>[2],
  ): LogPayload {
    return this.write("error", message, meta);
  }

  getRecentLogs(): readonly LogPayload[] {
    return this.logs;
  }

  clearLogs(): void {
    this.logs = [];
  }
}
