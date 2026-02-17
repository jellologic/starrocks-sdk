/**
 * Shared option types between StreamLoad and Transaction services.
 *
 * Both services send data to StarRocks via HTTP Stream Load protocol.
 * These interfaces capture the common configuration surface.
 */

/**
 * Base options shared by all data loading operations.
 * Both StreamLoad and Transaction use these when sending data to StarRocks.
 */
export interface BaseLoadOptions {
  /** Column mapping — specifies which columns the data maps to */
  readonly columns?: string[]
  /** Enable partial update for PRIMARY KEY tables (only updates specified columns) */
  readonly partialUpdate?: boolean
  /** Partial update mode: 'row' (default, real-time) or 'column' (batch, requires StarRocks 3.0+) */
  readonly partialUpdateMode?: "row" | "column"
}

/**
 * CSV-specific loading options, shared between StreamLoad.loadCsv and Transaction.load with format: "csv".
 */
export interface CsvLoadOptions {
  /** Column separator (default: comma) */
  readonly columnSeparator?: string
  /** Row delimiter (default: newline) */
  readonly rowDelimiter?: string
}

/**
 * JSON-specific loading options, used by Transaction.load with format: "json".
 */
export interface JsonLoadOptions {
  /** JSON paths for extracting data from nested JSON structures */
  readonly jsonPaths?: string[]
  /** Strip outer JSON array wrapper (default: true for array data) */
  readonly stripOuterArray?: boolean
}

/**
 * Build StarRocks Stream Load headers from shared options.
 * Used by both StreamLoad and Transaction layer implementations.
 */
export function buildLoadHeaders(
  options: BaseLoadOptions & CsvLoadOptions & JsonLoadOptions & { format?: "csv" | "json" }
): Record<string, string> {
  const headers: Record<string, string> = {}

  if (options.columns?.length) {
    headers["columns"] = options.columns.join(", ")
  }
  if (options.partialUpdate) {
    headers["partial_update"] = "true"
    if (options.partialUpdateMode) {
      headers["partial_update_mode"] = options.partialUpdateMode
    }
  }

  // CSV options
  if (options.columnSeparator) {
    headers["column_separator"] = options.columnSeparator
  }
  if (options.rowDelimiter) {
    headers["row_delimiter"] = options.rowDelimiter
  }

  // JSON options
  if (options.format === "json") {
    headers["format"] = "json"
    if (options.stripOuterArray) {
      headers["strip_outer_array"] = "true"
    }
    if (options.jsonPaths) {
      headers["jsonpaths"] = JSON.stringify(options.jsonPaths)
    }
  }

  return headers
}
