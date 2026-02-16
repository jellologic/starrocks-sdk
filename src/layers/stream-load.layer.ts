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
 * Generate unique label for stream load
 */
function generateLabel(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 10)
  return `stream_load_${timestamp}_${random}`
}

/**
 * Parse Stream Load response from StarRocks
 */
function parseResponse(result: Record<string, unknown>): StreamLoadResult {
  return {
    txnId: (result.TxnId as number) ?? 0,
    label: (result.Label as string) ?? "",
    status: (result.Status as StreamLoadResult["status"]) ?? "Fail",
    message: (result.Message as string) ?? "",
    numberLoadedRows: (result.NumberLoadedRows as number) ?? 0,
    numberFilteredRows: (result.NumberFilteredRows as number) ?? 0,
    numberUnselectedRows: (result.NumberUnselectedRows as number) ?? 0,
    loadBytes: (result.LoadBytes as number) ?? 0,
    loadTimeMs: (result.LoadTimeMs as number) ?? 0,
    errorUrl: result.ErrorURL as string | undefined,
  }
}

/**
 * StreamLoad live layer implementation
 */
export const StreamLoadLive = Layer.effect(
  StreamLoad,
  Effect.gen(function* () {
    const config = yield* StarRocksConfig

    const baseUrl = `http://${config.host}:${config.httpPort}`
    const auth = Buffer.from(`${config.user}:${config.password ?? ""}`).toString("base64")

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

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              method: "PUT",
              headers,
              body,
              redirect: "follow",
            }),
          catch: (e) =>
            new StreamLoadError({
              table: options.table,
              message: e instanceof Error ? e.message : "HTTP request failed",
            }),
        })

        const result = yield* Effect.tryPromise({
          try: () => response.json() as Promise<Record<string, unknown>>,
          catch: () =>
            new StreamLoadError({
              table: options.table,
              message: "Failed to parse response JSON",
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
          Effect.sync(() => {
            if (attemptCount > 1) {
              console.warn(
                `Stream load to ${options.table} failed after ${attemptCount} attempts: ${error.message}`
              )
            }
          })
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
