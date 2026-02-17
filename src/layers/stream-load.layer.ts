// packages/starrocks/src/layers/stream-load.layer.ts
import { Effect, Layer, Schedule, Duration } from "effect"
import {
  StreamLoad,
  type StreamLoadService,
  type StreamLoadResult,
  type StreamLoadOptions,
} from "../services/stream-load.service"
import { StreamLoadError } from "../errors"
import { StarRocksConfig } from "../config/starrocks.config"

/**
 * Default retry configuration
 */
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_INITIAL_DELAY_MS = 1000
const DEFAULT_MAX_DELAY_MS = 30000

/**
 * Check if an error is retryable based on the error message or status
 */
function isRetryableError(error: StreamLoadError): boolean {
  // HTTP status-based retry: 429, 500, 502, 503, 504 are retryable
  if (error.httpStatus !== undefined) {
    const retryableStatuses = [429, 500, 502, 503, 504]
    if (retryableStatuses.includes(error.httpStatus)) return true
    // 4xx errors (except 429) are never retryable
    if (error.httpStatus >= 400 && error.httpStatus < 500) return false
  }

  const message = error.message.toLowerCase()
  const retryablePatterns = [
    "timeout",
    "connection refused",
    "connection reset",
    "econnreset",
    "econnrefused",
    "etimedout",
    "socket hang up",
    "network error",
    "service unavailable",
    "too many requests",
    "rate limit",
    "busy",
    "try again",
    "temporarily unavailable",
    "transaction not found", // Transient state during commit
    "label already exists", // Can retry with new label
  ]

  return retryablePatterns.some((pattern) => message.includes(pattern))
}

/**
 * Create a retry schedule with exponential backoff
 */
function createRetrySchedule(maxRetries: number, initialDelayMs: number, maxDelayMs: number) {
  return Schedule.exponential(Duration.millis(initialDelayMs), 2).pipe(
    Schedule.either(Schedule.spaced(Duration.millis(maxDelayMs))),
    Schedule.compose(Schedule.recurs(maxRetries)),
    Schedule.whileInput((error: StreamLoadError) => isRetryableError(error))
  )
}

/**
 * Validate database/table identifier: must be a valid SQL identifier
 */
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function validateLoadOptions(
  options: StreamLoadOptions
): Effect.Effect<void, StreamLoadError> {
  if (!options.database || !IDENTIFIER_RE.test(options.database)) {
    return Effect.fail(
      new StreamLoadError({
        table: options.table ?? "unknown",
        message: `Invalid database name: '${options.database}'. Must match ${IDENTIFIER_RE}`,
      })
    )
  }
  if (!options.table || !IDENTIFIER_RE.test(options.table)) {
    return Effect.fail(
      new StreamLoadError({
        table: options.table ?? "unknown",
        message: `Invalid table name: '${options.table}'. Must match ${IDENTIFIER_RE}`,
      })
    )
  }
  if (options.maxFilterRatio !== undefined && (options.maxFilterRatio < 0 || options.maxFilterRatio > 1)) {
    return Effect.fail(
      new StreamLoadError({
        table: options.table,
        message: `maxFilterRatio must be between 0 and 1, got ${options.maxFilterRatio}`,
      })
    )
  }
  if (options.timeout !== undefined && (options.timeout <= 0 || !Number.isFinite(options.timeout))) {
    return Effect.fail(
      new StreamLoadError({
        table: options.table,
        message: `timeout must be a positive finite number, got ${options.timeout}`,
      })
    )
  }
  if (options.retry) {
    const { maxRetries, initialDelayMs, maxDelayMs } = options.retry
    if (maxRetries !== undefined && (maxRetries < 0 || !Number.isFinite(maxRetries))) {
      return Effect.fail(
        new StreamLoadError({
          table: options.table,
          message: `retry.maxRetries must be a non-negative finite number, got ${maxRetries}`,
        })
      )
    }
    if (initialDelayMs !== undefined && (initialDelayMs <= 0 || !Number.isFinite(initialDelayMs))) {
      return Effect.fail(
        new StreamLoadError({
          table: options.table,
          message: `retry.initialDelayMs must be a positive finite number, got ${initialDelayMs}`,
        })
      )
    }
    if (maxDelayMs !== undefined && (maxDelayMs <= 0 || !Number.isFinite(maxDelayMs))) {
      return Effect.fail(
        new StreamLoadError({
          table: options.table,
          message: `retry.maxDelayMs must be a positive finite number, got ${maxDelayMs}`,
        })
      )
    }
  }
  return Effect.void
}

/**
 * Generate unique label for stream load
 */
function generateLabel(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 10)
  return `stream_load_${timestamp}_${random}`
}

/**
 * Parse and validate Stream Load response from StarRocks.
 * Uses runtime type checks instead of unsafe `as` casts.
 */
function parseResponse(result: Record<string, unknown>): StreamLoadResult {
  const validStatuses = ["Success", "Fail", "Publish Timeout", "Label Already Exists"] as const
  const rawStatus = typeof result.Status === "string" ? result.Status : "Fail"
  const status = validStatuses.includes(rawStatus as typeof validStatuses[number])
    ? (rawStatus as StreamLoadResult["status"])
    : "Fail"

  const numberLoadedRows = typeof result.NumberLoadedRows === "number" ? result.NumberLoadedRows : 0
  const numberFilteredRows = typeof result.NumberFilteredRows === "number" ? result.NumberFilteredRows : 0
  const numberUnselectedRows = typeof result.NumberUnselectedRows === "number" ? result.NumberUnselectedRows : 0
  const numberTotalRows = typeof result.NumberTotalRows === "number"
    ? result.NumberTotalRows
    : numberLoadedRows + numberFilteredRows + numberUnselectedRows

  return {
    txnId: typeof result.TxnId === "number" ? result.TxnId : 0,
    label: typeof result.Label === "string" ? result.Label : "",
    status,
    message: typeof result.Message === "string" ? result.Message : "",
    numberLoadedRows,
    numberFilteredRows,
    numberUnselectedRows,
    numberTotalRows,
    loadBytes: typeof result.LoadBytes === "number" ? result.LoadBytes : 0,
    loadTimeMs: typeof result.LoadTimeMs === "number" ? result.LoadTimeMs : 0,
    errorUrl: typeof result.ErrorURL === "string" ? result.ErrorURL : undefined,
  }
}

/**
 * StreamLoad live layer implementation
 *
 * Uses Layer.scoped for proper resource lifecycle management.
 * Finalizer runs when the scope is closed.
 */
export const StreamLoadLive = Layer.scoped(
  StreamLoad,
  Effect.gen(function* () {
    const config = yield* StarRocksConfig

    const baseUrl = `http://${config.host}:${config.httpPort}`
    const auth = Buffer.from(`${config.user}:${config.password ?? ""}`).toString("base64")

    yield* Effect.addFinalizer(() =>
      Effect.logDebug("StreamLoad layer finalized")
    )

    /**
     * Internal function to perform a single load attempt
     */
    const doLoadAttempt = (
      data: string | Buffer,
      options: StreamLoadOptions & { format: "csv" | "json"; headers?: Record<string, string> },
      label: string
    ): Effect.Effect<StreamLoadResult, StreamLoadError> =>
      Effect.gen(function* () {
        const url = `${baseUrl}/api/${options.database}/${options.table}/_stream_load`

        const headers: Record<string, string> = {
          Authorization: `Basic ${auth}`,
          Expect: "100-continue",
          label,
          ...options.headers,
        }

        if (options.format === "json") {
          headers["format"] = "json"
          headers["strip_outer_array"] = "true"
        }

        if (options.columns?.length) {
          headers["columns"] = options.columns.join(", ")
        }

        if (options.timeout) {
          headers["timeout"] = String(options.timeout)
        }

        if (options.maxFilterRatio !== undefined) {
          headers["max_filter_ratio"] = String(options.maxFilterRatio)
        }

        // Partial update for PRIMARY KEY tables
        if (options.partialUpdate) {
          headers["partial_update"] = "true"
          if (options.partialUpdateMode) {
            headers["partial_update_mode"] = options.partialUpdateMode
          }
        }

        // Convert Buffer to Uint8Array for fetch compatibility
        const body = Buffer.isBuffer(data) ? new Uint8Array(data) : data

        // Default HTTP timeout: 2 minutes (separate from StarRocks server-side timeout)
        const httpTimeoutMs = (options.timeout ?? 120) * 1000
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              method: "PUT",
              headers,
              body,
              redirect: "follow",
              signal: AbortSignal.timeout(httpTimeoutMs),
            }),
          catch: (e) =>
            new StreamLoadError({
              table: options.table,
              message: e instanceof Error && e.name === "TimeoutError"
                ? `HTTP request timed out after ${httpTimeoutMs}ms`
                : e instanceof Error ? e.message : "HTTP request failed",
            }),
        })

        // Validate HTTP status before parsing body
        if (!response.ok) {
          const bodyText = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: () =>
              new StreamLoadError({
                table: options.table,
                message: `HTTP ${response.status}: Unable to read response body`,
                httpStatus: response.status,
              }),
          })

          // Try to parse JSON error from StarRocks even on HTTP errors
          let serverMessage = bodyText
          try {
            const json = JSON.parse(bodyText)
            if (typeof json?.Message === "string") serverMessage = json.Message
          } catch {
            // Use raw body text
          }

          return yield* Effect.fail(
            new StreamLoadError({
              table: options.table,
              message: `HTTP ${response.status}: ${serverMessage}`,
              httpStatus: response.status,
            })
          )
        }

        const result = yield* Effect.tryPromise({
          try: () => response.json() as Promise<Record<string, unknown>>,
          catch: () =>
            new StreamLoadError({
              table: options.table,
              message: "Failed to parse response JSON",
              httpStatus: response.status,
            }),
        })

        const parsed = parseResponse(result)

        if (parsed.status === "Fail") {
          return yield* Effect.fail(
            new StreamLoadError({
              table: options.table,
              message: parsed.message,
              status: parsed.status,
              errorUrl: parsed.errorUrl,
              numberFilteredRows: parsed.numberFilteredRows,
            })
          )
        }

        return parsed
      })

    /**
     * Load with automatic retry for transient failures
     */
    const doLoad = (
      data: string | Buffer,
      options: StreamLoadOptions & { format: "csv" | "json"; headers?: Record<string, string> }
    ): Effect.Effect<StreamLoadResult, StreamLoadError> =>
      Effect.gen(function* () {
        yield* validateLoadOptions(options)

        // Validate non-empty data for string payloads
        if (typeof data === "string" && data.length === 0) {
          return yield* Effect.fail(
            new StreamLoadError({
              table: options.table,
              message: "Cannot load empty data",
            })
          )
        }

        return yield* doLoadInner(data, options)
      })

    const doLoadInner = (
      data: string | Buffer,
      options: StreamLoadOptions & { format: "csv" | "json"; headers?: Record<string, string> }
    ): Effect.Effect<StreamLoadResult, StreamLoadError> => {
      const maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES
      const initialDelayMs = options.retry?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
      const maxDelayMs = options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS

      // Generate base label - will append retry suffix for subsequent attempts
      const baseLabel = options.label ?? generateLabel()
      let attemptCount = 0

      const attempt = (): Effect.Effect<StreamLoadResult, StreamLoadError> => {
        attemptCount++
        // For retries, append suffix to avoid "label already exists" error
        const label = attemptCount === 1 ? baseLabel : `${baseLabel}_retry${attemptCount}`
        return doLoadAttempt(data, options, label)
      }

      // Create retry policy
      const schedule = createRetrySchedule(maxRetries, initialDelayMs, maxDelayMs)

      return attempt().pipe(
        Effect.retry(schedule),
        Effect.tapError((error) =>
          attemptCount > 1
            ? Effect.logWarning("Stream load failed after retries", {
                table: options.table,
                attempts: attemptCount,
                error: error.message,
              })
            : Effect.void
        )
      )
    }

    return {
      loadObjects: (objects, options) =>
        Effect.gen(function* () {
          if (objects.length === 0) {
            return yield* Effect.fail(
              new StreamLoadError({
                table: options.table,
                message: "Cannot load empty array",
              })
            )
          }

          const columns = Object.keys(objects[0]!)
          const json = JSON.stringify(objects)

          return yield* doLoad(json, {
            ...options,
            format: "json",
            columns: options.columns ?? columns,
          })
        }),

      loadCsv: (csv, options) =>
        doLoad(csv, {
          ...options,
          format: "csv",
          headers: {
            ...(options.columnSeparator && { column_separator: options.columnSeparator }),
            ...(options.rowDelimiter && { row_delimiter: options.rowDelimiter }),
          },
        }),

      loadJson: (json, options) =>
        doLoad(json, {
          ...options,
          format: "json",
          headers: {
            ...(options.stripOuterArray && { strip_outer_array: "true" }),
          },
        }),
    } satisfies StreamLoadService
  })
)
