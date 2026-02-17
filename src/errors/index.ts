import { Schema } from "@effect/schema"

/**
 * Connection/configuration errors
 */
export class ConnectionError extends Schema.TaggedError<ConnectionError>()(
  "ConnectionError",
  {
    host: Schema.String,
    port: Schema.Number,
    cause: Schema.String,
  }
) {
  /** Formatted error message with context */
  get formattedMessage(): string {
    return `Connection to ${this.host}:${this.port} failed: ${this.cause}`
  }
}

/**
 * Stream Load errors - bulk data loading failures
 */
export class StreamLoadError extends Schema.TaggedError<StreamLoadError>()(
  "StreamLoadError",
  {
    table: Schema.String,
    message: Schema.String,
    status: Schema.optional(Schema.String),
    /** HTTP status code from the response (e.g., 200, 401, 500) */
    httpStatus: Schema.optional(Schema.Number),
    errorUrl: Schema.optional(Schema.String),
    numberFilteredRows: Schema.optional(Schema.Number),
  }
) {
  /** Formatted error message with context */
  get formattedMessage(): string {
    let msg = `Stream load to '${this.table}' failed: ${this.message}`
    if (this.status) msg += ` (status: ${this.status})`
    if (this.httpStatus) msg += ` (HTTP ${this.httpStatus})`
    if (this.numberFilteredRows) msg += ` [${this.numberFilteredRows} rows filtered]`
    if (this.errorUrl) msg += ` - Details: ${this.errorUrl}`
    return msg
  }
}

/**
 * Transaction (2PC) errors - two-phase commit failures
 */
export class TransactionError extends Schema.TaggedError<TransactionError>()(
  "TransactionError",
  {
    label: Schema.String,
    phase: Schema.Literal("begin", "load", "prepare", "commit", "abort"),
    txnId: Schema.optional(Schema.Number),
    cause: Schema.String,
    /** StarRocks response status (e.g., "FAILED", "LABEL_ALREADY_EXISTS") */
    status: Schema.optional(Schema.String),
    /** HTTP status code from the response (e.g., 200, 401, 500) */
    httpStatus: Schema.optional(Schema.Number),
    /** Target table (if known) */
    table: Schema.optional(Schema.String),
  }
) {
  /** Formatted error message with context */
  get formattedMessage(): string {
    let msg = `Transaction '${this.label}' failed at ${this.phase} phase: ${this.cause}`
    if (this.txnId) msg += ` (txnId: ${this.txnId})`
    if (this.table) msg += ` [table: ${this.table}]`
    if (this.status) msg += ` (status: ${this.status})`
    if (this.httpStatus) msg += ` (HTTP ${this.httpStatus})`
    return msg
  }
}

/**
 * Data Archive errors - S3/HDFS export failures
 */
export class ArchiveError extends Schema.TaggedError<ArchiveError>()(
  "ArchiveError",
  {
    operation: Schema.Literal("export", "retention", "status"),
    target: Schema.String,
    cause: Schema.String,
  }
) {
  /** Formatted error message with context */
  get formattedMessage(): string {
    return `Archive ${this.operation} to '${this.target}' failed: ${this.cause}`
  }
}

/**
 * Migration errors - schema migration failures
 */
export class MigrationError extends Schema.TaggedError<MigrationError>()(
  "MigrationError",
  {
    migrationId: Schema.String,
    step: Schema.optional(Schema.String),
    cause: Schema.String,
  }
) {
  /** Formatted error message with context */
  get formattedMessage(): string {
    let msg = `Migration '${this.migrationId}' failed: ${this.cause}`
    if (this.step) msg += ` (at step: ${this.step})`
    return msg
  }
}

/**
 * Materialized View errors - MV operation failures
 */
export class MaterializedViewError extends Schema.TaggedError<MaterializedViewError>()(
  "MaterializedViewError",
  {
    viewName: Schema.String,
    operation: Schema.Literal("create", "refresh", "drop", "status"),
    cause: Schema.String,
  }
) {
  /** Formatted error message with context */
  get formattedMessage(): string {
    return `Materialized view '${this.viewName}' ${this.operation} failed: ${this.cause}`
  }
}

/**
 * Query builder errors - validation failures
 */
export class QueryError extends Schema.TaggedError<QueryError>()(
  "QueryError",
  {
    operation: Schema.Literal("select", "insert", "update", "delete"),
    table: Schema.optional(Schema.String),
    reason: Schema.String,
  }
) {
  /** Formatted error message with context */
  get formattedMessage(): string {
    let msg = `Query ${this.operation} failed: ${this.reason}`
    if (this.table) msg += ` [table: ${this.table}]`
    return msg
  }
}
