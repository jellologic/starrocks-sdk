// packages/starrocks/src/services/stream-load.service.ts
import { Context, Effect } from "effect"
import type { StreamLoadError } from "../errors"

/**
 * Result from a Stream Load operation
 */
export interface StreamLoadResult {
  /** Transaction ID */
  readonly txnId: number
  /** Label for this load */
  readonly label: string
  /** Status: Success, Fail, or Publish Timeout */
  readonly status: "Success" | "Fail" | "Publish Timeout"
  /** Status message */
  readonly message: string
  /** Number of rows successfully loaded */
  readonly numberLoadedRows: number
  /** Number of rows filtered out */
  readonly numberFilteredRows: number
  /** Number of rows unselected */
  readonly numberUnselectedRows: number
  /** Total bytes loaded */
  readonly loadBytes: number
  /** Total load time in milliseconds */
  readonly loadTimeMs: number
  /** Error URL for debugging (if failed) */
  readonly errorUrl?: string
}

/**
 * Retry configuration for transient failures
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  readonly maxRetries?: number
  /** Initial delay in milliseconds before first retry (default: 1000) */
  readonly initialDelayMs?: number
  /** Maximum delay between retries in milliseconds (default: 30000) */
  readonly maxDelayMs?: number
}

/**
 * Options for Stream Load operations
 */
export interface StreamLoadOptions {
  /** Target database */
  readonly database: string
  /** Target table */
  readonly table: string
  /** Unique label (auto-generated if not provided) */
  readonly label?: string
  /** Column mapping */
  readonly columns?: string[]
  /** Timeout in seconds (default: 600) */
  readonly timeout?: number
  /** Max filter ratio 0-1 (default: 0) */
  readonly maxFilterRatio?: number
  /** Enable partial update for PRIMARY KEY tables (only updates specified columns) */
  readonly partialUpdate?: boolean
  /** Partial update mode: 'row' (default, real-time) or 'column' (batch) */
  readonly partialUpdateMode?: "row" | "column"
  /** Retry configuration for transient failures */
  readonly retry?: RetryConfig
}

/**
 * Options for CSV loading
 */
export interface StreamLoadCsvOptions extends StreamLoadOptions {
  /** Column separator (default: comma) */
  readonly columnSeparator?: string
  /** Row delimiter (default: newline) */
  readonly rowDelimiter?: string
}

/**
 * StreamLoad service interface (port)
 */
export interface StreamLoadService {
  /**
   * Load array of objects to a table
   */
  readonly loadObjects: (
    objects: Record<string, unknown>[],
    options: StreamLoadOptions
  ) => Effect.Effect<StreamLoadResult, StreamLoadError>

  /**
   * Load CSV string to a table
   */
  readonly loadCsv: (
    csv: string,
    options: StreamLoadCsvOptions
  ) => Effect.Effect<StreamLoadResult, StreamLoadError>

  /**
   * Load JSON string to a table
   */
  readonly loadJson: (
    json: string,
    options: StreamLoadOptions & { stripOuterArray?: boolean }
  ) => Effect.Effect<StreamLoadResult, StreamLoadError>
}

/**
 * StreamLoad service tag for dependency injection
 *
 * @example
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const loader = yield* StreamLoad
 *   const result = yield* loader.loadObjects(data, { database: "db", table: "tbl" })
 * })
 * ```
 */
export class StreamLoad extends Context.Tag("@starrocks/StreamLoad")<
  StreamLoad,
  StreamLoadService
>() {}
