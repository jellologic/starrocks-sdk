/**
 * StarRocks Stream Load Transaction Interface - Two-Phase Commit (2PC)
 *
 * Provides exactly-once semantics for data loading with application-controlled
 * orchestration. Supports multiple load operations within a single atomic transaction.
 *
 * Flow: begin → load → load → ... → prepare → commit/rollback
 *
 * Key benefit: After prepare(), data is durably staged. If app crashes,
 * it can still commit() after recovery.
 */

import type { StreamLoadConfig } from "./stream-load";

/**
 * Configuration for starting a new transaction
 */
export interface TransactionConfig {
  /** Target database */
  database: string;
  /** Target table (primary table for single-table transactions) */
  table: string;
  /** Unique label for this transaction - must be consistent across all operations */
  label: string;
  /** Timeout from begin to prepare in seconds (default: 600) */
  timeout?: number;
  /** Idle timeout - rollback if no data written within this period (seconds) */
  idleTimeout?: number;
  /** Enable multi-table transaction (v4.0+) */
  multiTable?: boolean;
}

/**
 * Options for loading data within a transaction
 */
export interface TransactionLoadOptions {
  /** Target table (required for multi-table transactions) */
  table?: string;
  /** Column mapping */
  columns?: string[];
  /** Data format */
  format?: "csv" | "json";
  /** Column separator for CSV (default: \t) */
  columnSeparator?: string;
  /** Row delimiter for CSV (default: \n) */
  rowDelimiter?: string;
  /** JSON paths for extracting data */
  jsonPaths?: string[];
  /** Strip outer JSON array */
  stripOuterArray?: boolean;
}

/**
 * Result from transaction operations
 */
export interface TransactionResult {
  /** Transaction ID */
  txnId: number;
  /** Transaction label */
  label: string;
  /** Operation status */
  status: "OK" | "FAILED" | "LABEL_ALREADY_EXISTS";
  /** Existing job status (if label already exists) */
  existingJobStatus?: string;
  /** Status message */
  message: string;
  /** Sequence number for load operations */
  seq?: number;
  /** Number of rows loaded (available after prepare/commit) */
  numberLoadedRows?: number;
  /** Number of rows filtered (available after prepare/commit) */
  numberFilteredRows?: number;
  /** Number of rows unselected (available after prepare/commit) */
  numberUnselectedRows?: number;
  /** Total bytes loaded (available after prepare/commit) */
  loadBytes?: number;
  /** Total load time in ms (available after prepare/commit) */
  loadTimeMs?: number;
  /** Begin transaction time in ms */
  beginTxnTimeMs?: number;
  /** Stream load plan time in ms */
  streamLoadPlanTimeMs?: number;
  /** Read data time in ms */
  readDataTimeMs?: number;
  /** Write data time in ms */
  writeDataTimeMs?: number;
  /** Commit and publish time in ms */
  commitAndPublishTimeMs?: number;
}

/**
 * Error thrown for transaction-specific failures.
 * Note: For Effect-based code, use TransactionError from "@jellologic/starrocks-sdk/errors" instead.
 * This class exists for compatibility with non-Effect code.
 */
export class LegacyTransactionError extends Error {
  constructor(
    message: string,
    public readonly status: string,
    public readonly label: string,
    public readonly txnId?: number,
    public readonly table?: string
  ) {
    super(message);
    this.name = "TransactionError";
  }

  /** Formatted error message with context */
  get formattedMessage(): string {
    let msg = `Transaction '${this.label}' failed: ${this.message}`
    if (this.txnId) msg += ` (txnId: ${this.txnId})`
    if (this.table) msg += ` [table: ${this.table}]`
    if (this.status) msg += ` (status: ${this.status})`
    return msg
  }
}

/**
 * Build HTTP headers for transaction operations
 */
function buildTransactionHeaders(
  config: StreamLoadConfig,
  label: string,
  database: string,
  table?: string,
  options?: {
    timeout?: number;
    idleTimeout?: number;
    preparedTimeout?: number;
    multiTable?: boolean;
    loadOptions?: TransactionLoadOptions;
  }
): Record<string, string> {
  const headers: Record<string, string> = {
    Expect: "100-continue",
    label: label,
    db: database,
  };

  // Add table if provided
  if (table) {
    headers["table"] = table;
  }

  // Add basic auth
  const auth = Buffer.from(
    `${config.user}:${config.password ?? ""}`
  ).toString("base64");
  headers["Authorization"] = `Basic ${auth}`;

  // Multi-table transaction
  if (options?.multiTable) {
    headers["transaction_type"] = "multi";
  }

  // Timeout settings
  if (options?.timeout) {
    headers["timeout"] = String(options.timeout);
  }
  if (options?.idleTimeout) {
    headers["idle_transaction_timeout"] = String(options.idleTimeout);
  }
  if (options?.preparedTimeout) {
    headers["prepared_timeout"] = String(options.preparedTimeout);
  }

  // Load-specific options
  if (options?.loadOptions) {
    const loadOpts = options.loadOptions;

    if (loadOpts.format === "json") {
      headers["format"] = "json";
      if (loadOpts.jsonPaths) {
        headers["jsonpaths"] = JSON.stringify(loadOpts.jsonPaths);
      }
      if (loadOpts.stripOuterArray) {
        headers["strip_outer_array"] = "true";
      }
    } else {
      // CSV format
      if (loadOpts.columnSeparator) {
        headers["column_separator"] = loadOpts.columnSeparator;
      }
      if (loadOpts.rowDelimiter) {
        headers["row_delimiter"] = loadOpts.rowDelimiter;
      }
    }

    if (loadOpts.columns?.length) {
      headers["columns"] = loadOpts.columns.join(", ");
    }

    if (loadOpts.table) {
      headers["table"] = loadOpts.table;
    }
  }

  return headers;
}

/**
 * Parse response from transaction API
 */
function parseTransactionResponse(
  result: Record<string, unknown>,
  label: string
): TransactionResult {
  const status = (result.Status as string) ?? "FAILED";
  const message = (result.Message as string) ?? "";

  // Check for error conditions - any non-OK status is an error
  const errorStatuses = [
    "FAILED",
    "LABEL_ALREADY_EXISTS",
    "TXN_NOT_EXISTS",
    "ANALYSIS_ERROR",
    "INTERNAL_ERROR",
  ];

  if (errorStatuses.includes(status) || (status !== "OK" && message.includes("error"))) {
    throw new LegacyTransactionError(
      message || `Transaction operation failed with status: ${status}`,
      status,
      label,
      result.TxnId as number | undefined
    );
  }

  return {
    txnId: (result.TxnId as number) ?? 0,
    label: (result.Label as string) ?? label,
    status: status as TransactionResult["status"],
    existingJobStatus: result.ExistingJobStatus as string | undefined,
    message: (result.Message as string) ?? "",
    seq: result.Seq as number | undefined,
    numberLoadedRows: result.NumberLoadedRows as number | undefined,
    numberFilteredRows: result.NumberFilteredRows as number | undefined,
    numberUnselectedRows: result.NumberUnselectedRows as number | undefined,
    loadBytes: result.LoadBytes as number | undefined,
    loadTimeMs: result.LoadTimeMs as number | undefined,
    beginTxnTimeMs: result.BeginTxnTimeMs as number | undefined,
    streamLoadPlanTimeMs: result.StreamLoadPlanTimeMs as number | undefined,
    readDataTimeMs: result.ReadDataTimeMs as number | undefined,
    writeDataTimeMs: result.WriteDataTimeMs as number | undefined,
    commitAndPublishTimeMs: result.CommitAndPublishTimeMs as number | undefined,
  };
}

/**
 * Stream Load Transaction Client for two-phase commit data loading
 */
export class StreamLoadTransactionClient {
  private config: StreamLoadConfig;

  constructor(config: StreamLoadConfig) {
    this.config = config;
  }

  /**
   * Get the base URL for transaction API
   */
  private getBaseUrl(): string {
    return `http://${this.config.host}:${this.config.httpPort}/api/transaction`;
  }

  /**
   * Begin a new transaction
   *
   * @param config Transaction configuration including database, table, and label
   * @returns Transaction result with txnId
   */
  async beginTransaction(config: TransactionConfig): Promise<TransactionResult> {
    const url = `${this.getBaseUrl()}/begin`;

    const headers = buildTransactionHeaders(
      this.config,
      config.label,
      config.database,
      config.table,
      {
        timeout: config.timeout,
        idleTimeout: config.idleTimeout,
        multiTable: config.multiTable,
      }
    );

    const response = await fetch(url, {
      method: "POST",
      headers,
    });

    const result = (await response.json()) as Record<string, unknown>;
    return parseTransactionResponse(result, config.label);
  }

  /**
   * Load data within an active transaction
   *
   * Can be called multiple times to load multiple batches of data.
   * All loads must complete before calling prepare().
   *
   * @param label Transaction label (must match beginTransaction)
   * @param database Target database
   * @param table Target table
   * @param data Data to load (CSV or JSON string, or Buffer)
   * @param options Load options (format, columns, separators)
   * @returns Transaction result with load metrics
   */
  async transactionLoad(
    label: string,
    database: string,
    table: string,
    data: string | Buffer,
    options?: TransactionLoadOptions
  ): Promise<TransactionResult> {
    const url = `${this.getBaseUrl()}/load`;

    const headers = buildTransactionHeaders(
      this.config,
      label,
      database,
      table,
      {
        multiTable: options?.table !== undefined,
        loadOptions: options,
      }
    );
    headers["Content-Type"] = "text/plain";

    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: typeof data === "string" ? data : new Uint8Array(data),
    });

    const result = (await response.json()) as Record<string, unknown>;
    return parseTransactionResponse(result, label);
  }

  /**
   * Prepare (pre-commit) a transaction
   *
   * After prepare succeeds, data is durably staged. The transaction can
   * still be committed or rolled back. If the cluster crashes after prepare,
   * the transaction can be committed after recovery.
   *
   * Do not call transactionLoad() after prepare().
   *
   * @param label Transaction label
   * @param database Target database
   * @param options Optional settings like preparedTimeout and multiTable
   * @returns Transaction result with aggregate load metrics
   */
  async prepareTransaction(
    label: string,
    database: string,
    options?: { preparedTimeout?: number; multiTable?: boolean }
  ): Promise<TransactionResult> {
    const url = `${this.getBaseUrl()}/prepare`;

    const headers = buildTransactionHeaders(
      this.config,
      label,
      database,
      undefined,
      {
        preparedTimeout: options?.preparedTimeout,
        multiTable: options?.multiTable,
      }
    );

    const response = await fetch(url, {
      method: "POST",
      headers,
    });

    const result = (await response.json()) as Record<string, unknown>;
    return parseTransactionResponse(result, label);
  }

  /**
   * Commit a transaction
   *
   * Finalizes the transaction and makes all loaded data visible.
   * Can be called after prepare() or directly (skipping prepare).
   *
   * @param label Transaction label
   * @param database Target database
   * @param options Optional settings like multiTable
   * @returns Transaction result with final metrics
   */
  async commitTransaction(
    label: string,
    database: string,
    options?: { multiTable?: boolean }
  ): Promise<TransactionResult> {
    const url = `${this.getBaseUrl()}/commit`;

    const headers = buildTransactionHeaders(
      this.config,
      label,
      database,
      undefined,
      { multiTable: options?.multiTable }
    );

    const response = await fetch(url, {
      method: "POST",
      headers,
    });

    const result = (await response.json()) as Record<string, unknown>;
    return parseTransactionResponse(result, label);
  }

  /**
   * Rollback a transaction
   *
   * Aborts the transaction and discards all loaded data.
   * Can be called at any point before commit.
   *
   * @param label Transaction label
   * @param database Target database
   * @param options Optional settings like multiTable
   * @returns Transaction result confirming rollback
   */
  async rollbackTransaction(
    label: string,
    database: string,
    options?: { multiTable?: boolean }
  ): Promise<TransactionResult> {
    const url = `${this.getBaseUrl()}/rollback`;

    const headers = buildTransactionHeaders(
      this.config,
      label,
      database,
      undefined,
      { multiTable: options?.multiTable }
    );

    const response = await fetch(url, {
      method: "POST",
      headers,
    });

    const result = (await response.json()) as Record<string, unknown>;
    return parseTransactionResponse(result, label);
  }
}

/**
 * Create a new Stream Load Transaction Client
 */
export function createStreamLoadTransactionClient(
  config: StreamLoadConfig
): StreamLoadTransactionClient {
  return new StreamLoadTransactionClient(config);
}
