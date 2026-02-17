// packages/starrocks/src/services/transaction.service.ts
import { Context, Effect } from "effect"
import type { TransactionError } from "../errors"
import type { BaseLoadOptions, CsvLoadOptions, JsonLoadOptions } from "./shared-options"

/**
 * Handle returned from begin() for subsequent operations
 */
export interface TransactionHandle {
  /** Transaction label */
  readonly label: string
  /** Transaction ID */
  readonly txnId: number
  /** Target database */
  readonly database: string
  /** Primary table */
  readonly table: string
  /** Whether this is a multi-table transaction */
  readonly multiTable: boolean
}

/**
 * Result from transaction operations
 */
export interface TransactionResult {
  /** Transaction ID */
  readonly txnId: number
  /** Transaction label */
  readonly label: string
  /** Operation status */
  readonly status: "OK" | "FAILED"
  /** Status message */
  readonly message: string
  /** Number of rows loaded (after commit) */
  readonly numberLoadedRows?: number
  /** Number of rows filtered (after commit) */
  readonly numberFilteredRows?: number
  /** Number of rows unselected */
  readonly numberUnselectedRows?: number
  /** Total bytes loaded (after commit) */
  readonly loadBytes?: number
  /** Total load time in ms */
  readonly loadTimeMs?: number
  /** Begin transaction time in ms */
  readonly beginTxnTimeMs?: number
  /** Stream load plan time in ms */
  readonly streamLoadPlanTimeMs?: number
  /** Read data time in ms */
  readonly readDataTimeMs?: number
  /** Write data time in ms */
  readonly writeDataTimeMs?: number
  /** Commit and publish time in ms */
  readonly commitAndPublishTimeMs?: number
}

/**
 * Options for loading data within a transaction.
 * Extends {@link BaseLoadOptions}, {@link CsvLoadOptions}, and {@link JsonLoadOptions}
 * for shared fields with StreamLoad.
 */
export interface TransactionLoadOptions extends BaseLoadOptions, CsvLoadOptions, JsonLoadOptions {
  /** Target table (for multi-table transactions) */
  readonly table?: string
  /** Data format */
  readonly format?: "csv" | "json"
}

/**
 * Options for beginning a transaction
 */
export interface TransactionBeginOptions {
  /** Target database */
  readonly database: string
  /** Primary target table */
  readonly table: string
  /** Unique transaction label */
  readonly label: string
  /** Timeout in seconds (default: 600) */
  readonly timeout?: number
  /** Idle timeout in seconds */
  readonly idleTimeout?: number
  /** Enable multi-table transaction */
  readonly multiTable?: boolean
}

/**
 * Transaction service interface (port) for 2PC data loading
 */
export interface TransactionService {
  /**
   * Begin a new transaction
   */
  readonly begin: (
    options: TransactionBeginOptions
  ) => Effect.Effect<TransactionHandle, TransactionError>

  /**
   * Load data within an active transaction (can be called multiple times)
   */
  readonly load: (
    handle: TransactionHandle,
    data: string | Record<string, unknown>[],
    options?: TransactionLoadOptions
  ) => Effect.Effect<void, TransactionError>

  /**
   * Prepare (pre-commit) a transaction - makes data durable
   * Returns metrics (row counts, bytes, timing) from StarRocks.
   */
  readonly prepare: (
    handle: TransactionHandle
  ) => Effect.Effect<TransactionResult, TransactionError>

  /**
   * Commit a transaction - makes data visible
   */
  readonly commit: (
    handle: TransactionHandle
  ) => Effect.Effect<TransactionResult, TransactionError>

  /**
   * Abort/rollback a transaction - discards all data
   */
  readonly abort: (
    handle: TransactionHandle
  ) => Effect.Effect<void, TransactionError>
}

/**
 * Transaction service tag for dependency injection
 *
 * @example
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const tx = yield* Transaction
 *   const handle = yield* tx.begin({ database: "db", table: "tbl", label: "load-1" })
 *   yield* tx.load(handle, data)
 *   yield* tx.commit(handle)
 * })
 * ```
 */
export class Transaction extends Context.Tag("@starrocks/Transaction")<
  Transaction,
  TransactionService
>() {}
