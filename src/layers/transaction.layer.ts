// packages/starrocks/src/layers/transaction.layer.ts
import { Effect, Layer, Schedule, Duration } from "effect"
import {
  Transaction,
  type TransactionService,
  type TransactionHandle,
  type TransactionResult,
} from "../services/transaction.service"
import { TransactionError } from "../errors"
import { StarRocksConfig } from "../config/starrocks.config"

/**
 * Parse and validate transaction response from StarRocks.
 * Uses runtime type checks instead of unsafe `as` casts.
 * Returns Effect to properly handle errors in the Effect error channel.
 */
function parseResponse(
  result: Record<string, unknown>,
  label: string,
  phase: "begin" | "load" | "prepare" | "commit" | "abort"
): Effect.Effect<TransactionResult, TransactionError> {
  const status = typeof result.Status === "string" ? result.Status : "FAILED"
  const message = typeof result.Message === "string" ? result.Message : ""

  const errorStatuses = [
    "FAILED",
    "LABEL_ALREADY_EXISTS",
    "TXN_NOT_EXISTS",
    "ANALYSIS_ERROR",
    "INTERNAL_ERROR",
  ]

  if (errorStatuses.includes(status)) {
    return Effect.fail(
      new TransactionError({
        label,
        phase,
        txnId: typeof result.TxnId === "number" ? result.TxnId : undefined,
        cause: message || `Transaction ${phase} failed with status: ${status}`,
      })
    )
  }

  return Effect.succeed({
    txnId: typeof result.TxnId === "number" ? result.TxnId : 0,
    label: typeof result.Label === "string" ? result.Label : label,
    status: status === "OK" ? "OK" : "FAILED",
    message,
    numberLoadedRows: typeof result.NumberLoadedRows === "number" ? result.NumberLoadedRows : undefined,
    numberFilteredRows: typeof result.NumberFilteredRows === "number" ? result.NumberFilteredRows : undefined,
    numberUnselectedRows: typeof result.NumberUnselectedRows === "number" ? result.NumberUnselectedRows : undefined,
    loadBytes: typeof result.LoadBytes === "number" ? result.LoadBytes : undefined,
    loadTimeMs: typeof result.LoadTimeMs === "number" ? result.LoadTimeMs : undefined,
    beginTxnTimeMs: typeof result.BeginTxnTimeMs === "number" ? result.BeginTxnTimeMs : undefined,
    streamLoadPlanTimeMs: typeof result.StreamLoadPlanTimeMs === "number" ? result.StreamLoadPlanTimeMs : undefined,
    readDataTimeMs: typeof result.ReadDataTimeMs === "number" ? result.ReadDataTimeMs : undefined,
    writeDataTimeMs: typeof result.WriteDataTimeMs === "number" ? result.WriteDataTimeMs : undefined,
    commitAndPublishTimeMs: typeof result.CommitAndPublishTimeMs === "number" ? result.CommitAndPublishTimeMs : undefined,
  })
}

/** Default HTTP timeout for transaction operations (2 minutes) */
const DEFAULT_HTTP_TIMEOUT_MS = 120_000

/**
 * Check if an error is retryable
 */
function isRetryableError(error: TransactionError): boolean {
  const message = (error.cause ?? "").toLowerCase()
  const retryablePatterns = [
    "timeout", "connection refused", "connection reset",
    "econnreset", "econnrefused", "etimedout", "socket hang up",
    "network error", "service unavailable", "temporarily unavailable",
  ]
  return retryablePatterns.some((p) => message.includes(p))
}

/**
 * Transaction live layer implementation
 *
 * Uses Layer.scoped for proper resource lifecycle management.
 * Finalizer runs when the scope is closed.
 */
export const TransactionLive = Layer.scoped(
  Transaction,
  Effect.gen(function* () {
    const config = yield* StarRocksConfig

    const baseUrl = `http://${config.host}:${config.httpPort}/api/transaction`
    const auth = Buffer.from(`${config.user}:${config.password ?? ""}`).toString("base64")

    yield* Effect.addFinalizer(() =>
      Effect.logDebug("Transaction layer finalized")
    )

    const makeHeaders = (
      label: string,
      database: string,
      table?: string,
      extra?: Record<string, string>
    ): Record<string, string> => ({
      Authorization: `Basic ${auth}`,
      Expect: "100-continue",
      label,
      db: database,
      ...(table && { table }),
      ...extra,
    })

    // Retry schedule for transient failures (3 retries, exponential backoff)
    const retrySchedule = Schedule.exponential(Duration.millis(1000), 2).pipe(
      Schedule.either(Schedule.spaced(Duration.millis(30_000))),
      Schedule.compose(Schedule.recurs(3)),
      Schedule.whileInput((error: TransactionError) => isRetryableError(error))
    )

    return {
      begin: (options) =>
        Effect.gen(function* () {
          const headers = makeHeaders(options.label, options.database, options.table, {
            ...(options.timeout && { timeout: String(options.timeout) }),
            ...(options.idleTimeout && { idle_transaction_timeout: String(options.idleTimeout) }),
            ...(options.multiTable && { transaction_type: "multi" }),
          })

          const timeoutMs = options.timeout ? options.timeout * 1000 : DEFAULT_HTTP_TIMEOUT_MS
          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/begin`, {
              method: "POST",
              headers,
              signal: AbortSignal.timeout(timeoutMs),
            }),
            catch: (e) =>
              new TransactionError({
                label: options.label,
                phase: "begin",
                cause: e instanceof Error && e.name === "TimeoutError"
                  ? `HTTP request timed out after ${timeoutMs}ms`
                  : e instanceof Error ? e.message : "HTTP request failed",
              }),
          })

          const result = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new TransactionError({
                label: options.label,
                phase: "begin",
                cause: "Failed to parse response",
              }),
          })

          const parsed = yield* parseResponse(result, options.label, "begin")

          return {
            label: options.label,
            txnId: parsed.txnId,
            database: options.database,
            table: options.table,
            multiTable: options.multiTable ?? false,
          } satisfies TransactionHandle
        }).pipe(Effect.retry(retrySchedule)),

      load: (handle, data, options) =>
        Effect.gen(function* () {
          const table = options?.table ?? handle.table
          const body = Array.isArray(data) ? JSON.stringify(data) : data
          const format = options?.format ?? (Array.isArray(data) ? "json" : "csv")

          // Determine strip_outer_array: respect explicit option, default to true for array data
          const stripOuterArray = options?.stripOuterArray ?? Array.isArray(data)

          const headers = makeHeaders(handle.label, handle.database, table, {
            "Content-Type": "text/plain",
            ...(format === "json" && { format: "json" }),
            ...(format === "json" && stripOuterArray && { strip_outer_array: "true" }),
            ...(format === "json" && options?.jsonPaths && { jsonpaths: JSON.stringify(options.jsonPaths) }),
            ...(options?.columns && { columns: options.columns.join(", ") }),
            ...(options?.columnSeparator && { column_separator: options.columnSeparator }),
            ...(options?.rowDelimiter && { row_delimiter: options.rowDelimiter }),
            ...(options?.partialUpdate && { partial_update: "true" }),
            ...(options?.partialUpdateMode && { partial_update_mode: options.partialUpdateMode }),
          })

          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/load`, {
              method: "PUT",
              headers,
              body,
              signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
            }),
            catch: (e) =>
              new TransactionError({
                label: handle.label,
                phase: "load",
                txnId: handle.txnId,
                cause: e instanceof Error && e.name === "TimeoutError"
                  ? `HTTP request timed out after ${DEFAULT_HTTP_TIMEOUT_MS}ms`
                  : e instanceof Error ? e.message : "HTTP request failed",
              }),
          })

          const result = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new TransactionError({
                label: handle.label,
                phase: "load",
                txnId: handle.txnId,
                cause: "Failed to parse response",
              }),
          })

          yield* parseResponse(result, handle.label, "load")
        }).pipe(Effect.retry(retrySchedule)),

      prepare: (handle) =>
        Effect.gen(function* () {
          const headers = makeHeaders(handle.label, handle.database, undefined, {
            ...(handle.multiTable && { transaction_type: "multi" }),
          })

          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/prepare`, {
              method: "POST",
              headers,
              signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
            }),
            catch: (e) =>
              new TransactionError({
                label: handle.label,
                phase: "prepare",
                txnId: handle.txnId,
                cause: e instanceof Error && e.name === "TimeoutError"
                  ? `HTTP request timed out after ${DEFAULT_HTTP_TIMEOUT_MS}ms`
                  : e instanceof Error ? e.message : "HTTP request failed",
              }),
          })

          const result = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new TransactionError({
                label: handle.label,
                phase: "prepare",
                txnId: handle.txnId,
                cause: "Failed to parse response",
              }),
          })

          yield* parseResponse(result, handle.label, "prepare")
        }).pipe(Effect.retry(retrySchedule)),

      commit: (handle) =>
        Effect.gen(function* () {
          const headers = makeHeaders(handle.label, handle.database, undefined, {
            ...(handle.multiTable && { transaction_type: "multi" }),
          })

          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/commit`, {
              method: "POST",
              headers,
              signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
            }),
            catch: (e) =>
              new TransactionError({
                label: handle.label,
                phase: "commit",
                txnId: handle.txnId,
                cause: e instanceof Error && e.name === "TimeoutError"
                  ? `HTTP request timed out after ${DEFAULT_HTTP_TIMEOUT_MS}ms`
                  : e instanceof Error ? e.message : "HTTP request failed",
              }),
          })

          const result = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new TransactionError({
                label: handle.label,
                phase: "commit",
                txnId: handle.txnId,
                cause: "Failed to parse response",
              }),
          })

          return yield* parseResponse(result, handle.label, "commit")
        }).pipe(Effect.retry(retrySchedule)),

      abort: (handle) =>
        Effect.gen(function* () {
          const headers = makeHeaders(handle.label, handle.database, undefined, {
            ...(handle.multiTable && { transaction_type: "multi" }),
          })

          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/rollback`, {
              method: "POST",
              headers,
              signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
            }),
            catch: (e) =>
              new TransactionError({
                label: handle.label,
                phase: "abort",
                txnId: handle.txnId,
                cause: e instanceof Error && e.name === "TimeoutError"
                  ? `HTTP request timed out after ${DEFAULT_HTTP_TIMEOUT_MS}ms`
                  : e instanceof Error ? e.message : "HTTP request failed",
              }),
          })

          const result = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new TransactionError({
                label: handle.label,
                phase: "abort",
                txnId: handle.txnId,
                cause: "Failed to parse response",
              }),
          })

          yield* parseResponse(result, handle.label, "abort")
        }),
    } satisfies TransactionService
  })
)
