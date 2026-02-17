/**
 * Observability hooks for StarRocks SDK.
 *
 * Provides Effect Metrics and Spans for Stream Load and Transaction operations.
 * Metrics are automatically recorded by the live layers — consumers can collect
 * them using Effect's MetricPolling or any compatible exporter.
 *
 * @example
 * ```typescript
 * import { Metric } from "effect"
 * import { streamLoadMetrics } from "@jellologic/starrocks-sdk"
 *
 * // Read current metric values
 * const snapshot = Metric.unsafeSnapshot(streamLoadMetrics.duration)
 * ```
 */

import { Metric, MetricBoundaries } from "effect"

// ============================================================================
// Stream Load Metrics
// ============================================================================

const loadDurationBoundaries = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 12,
}) // 10ms, 20ms, 40ms, ..., ~40s

export const streamLoadMetrics = {
  /** Histogram of Stream Load durations in milliseconds */
  duration: Metric.histogram("starrocks.stream_load.duration_ms", loadDurationBoundaries),

  /** Counter of total rows loaded */
  rowsLoaded: Metric.counter("starrocks.stream_load.rows_loaded"),

  /** Counter of total bytes loaded */
  bytesLoaded: Metric.counter("starrocks.stream_load.bytes_loaded"),

  /** Counter of total errors */
  errors: Metric.counter("starrocks.stream_load.errors"),

  /** Counter of total retries */
  retries: Metric.counter("starrocks.stream_load.retries"),

  /** Counter of filtered rows (potential data loss) */
  rowsFiltered: Metric.counter("starrocks.stream_load.rows_filtered"),
} as const

// ============================================================================
// Transaction Metrics
// ============================================================================

export const transactionMetrics = {
  /** Counter of transaction begins */
  begins: Metric.counter("starrocks.transaction.begins"),

  /** Counter of transaction prepares */
  prepares: Metric.counter("starrocks.transaction.prepares"),

  /** Counter of transaction commits */
  commits: Metric.counter("starrocks.transaction.commits"),

  /** Counter of transaction aborts */
  aborts: Metric.counter("starrocks.transaction.aborts"),

  /** Counter of transaction errors by phase */
  errors: Metric.counter("starrocks.transaction.errors"),

  /** Histogram of transaction load durations in milliseconds */
  loadDuration: Metric.histogram("starrocks.transaction.load_duration_ms", loadDurationBoundaries),
} as const
