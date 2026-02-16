/**
 * StarRocks Stream Load - HTTP-based bulk data loading
 *
 * Stream Load is a synchronous loading method that uses HTTP PUT to load data.
 * Supports CSV and JSON formats with files up to 10GB.
 */

export interface StreamLoadConfig {
  /** FE or BE host */
  host: string;
  /** HTTP port (default 8030 for FE, 8040 for BE) */
  httpPort: number;
  /** Username */
  user: string;
  /** Password */
  password?: string;
}

export interface StreamLoadOptions {
  /** Target database */
  database: string;
  /** Target table */
  table: string;
  /** Unique label for this load (auto-generated if not provided) */
  label?: string;
  /** Data format: csv or json */
  format?: "csv" | "json";
  /** Column separator for CSV (default: comma) */
  columnSeparator?: string;
  /** Row delimiter for CSV (default: newline) */
  rowDelimiter?: string;
  /** Column mapping (e.g., ["id", "name", "value"]) */
  columns?: string[];
  /** JSON paths for extracting data */
  jsonPaths?: string[];
  /** Strip outer JSON array */
  stripOuterArray?: boolean;
  /** Timeout in seconds (default: 600) */
  timeout?: number;
  /** Max filter ratio (0-1, default: 0) */
  maxFilterRatio?: number;
  /** Strict mode */
  strictMode?: boolean;
  /** Timezone */
  timezone?: string;
  /** Merge commit for high concurrency */
  enableMergeCommit?: boolean;
  /** Merge commit interval in ms */
  mergeCommitIntervalMs?: number;
  /** Enable partial update for PRIMARY KEY tables (only updates specified columns) */
  partialUpdate?: boolean;
  /** Partial update mode: 'row' (default, real-time) or 'column' (batch) */
  partialUpdateMode?: "row" | "column";
}

export interface StreamLoadResult {
  /** Transaction ID */
  txnId: number;
  /** Label */
  label: string;
  /** Status: Success, Fail, Publish Timeout, or Label Already Exists */
  status: "Success" | "Fail" | "Publish Timeout" | "Label Already Exists";
  /** Existing job status if label exists */
  existingJobStatus?: string;
  /** Message */
  message: string;
  /** Number of rows loaded */
  numberLoadedRows: number;
  /** Number of rows filtered */
  numberFilteredRows: number;
  /** Number of rows unselected */
  numberUnselectedRows: number;
  /** Load bytes */
  loadBytes: number;
  /** Load time in ms */
  loadTimeMs: number;
  /** Begin transaction time in ms */
  beginTxnTimeMs: number;
  /** Stream load plan time in ms */
  streamLoadPlanTimeMs: number;
  /** Read data time in ms */
  readDataTimeMs: number;
  /** Write data time in ms */
  writeDataTimeMs: number;
  /** Commit and publish time in ms */
  commitAndPublishTimeMs: number;
  /** Error URL for details */
  errorUrl?: string;
}

/**
 * Generate unique label for stream load
 */
function generateLabel(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `stream_load_${timestamp}_${random}`;
}

/**
 * Build HTTP headers for stream load
 */
function buildHeaders(options: StreamLoadOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Expect": "100-continue",
    "Content-Type": "text/plain",
  };

  // Label
  headers["label"] = options.label ?? generateLabel();

  // Format
  if (options.format === "json") {
    headers["format"] = "json";
    if (options.jsonPaths) {
      headers["jsonpaths"] = JSON.stringify(options.jsonPaths);
    }
    if (options.stripOuterArray) {
      headers["strip_outer_array"] = "true";
    }
  } else {
    // CSV format (default)
    if (options.columnSeparator) {
      headers["column_separator"] = options.columnSeparator;
    }
    if (options.rowDelimiter) {
      headers["row_delimiter"] = options.rowDelimiter;
    }
  }

  // Column mapping
  if (options.columns?.length) {
    headers["columns"] = options.columns.join(", ");
  }

  // Timeout
  if (options.timeout) {
    headers["timeout"] = String(options.timeout);
  }

  // Filter ratio
  if (options.maxFilterRatio !== undefined) {
    headers["max_filter_ratio"] = String(options.maxFilterRatio);
  }

  // Strict mode
  if (options.strictMode !== undefined) {
    headers["strict_mode"] = String(options.strictMode);
  }

  // Timezone
  if (options.timezone) {
    headers["timezone"] = options.timezone;
  }

  // Merge commit
  if (options.enableMergeCommit) {
    headers["enable_merge_commit"] = "true";
    if (options.mergeCommitIntervalMs) {
      headers["merge_commit_interval_ms"] = String(options.mergeCommitIntervalMs);
    }
  }

  // Partial update for PRIMARY KEY tables
  if (options.partialUpdate) {
    headers["partial_update"] = "true";
    if (options.partialUpdateMode) {
      headers["partial_update_mode"] = options.partialUpdateMode;
    }
  }

  return headers;
}

/**
 * Stream Load client for bulk data loading via HTTP
 */
export class StreamLoadClient {
  private config: StreamLoadConfig;

  constructor(config: StreamLoadConfig) {
    this.config = config;
  }

  /**
   * Rewrite redirect URL to handle docker port mapping.
   *
   * When FE redirects to BE, it uses the internal BE HTTP port (8040).
   * In docker environments, this port might be mapped to a different external port.
   *
   * Common port mappings:
   * - Internal BE HTTP: 8040 -> External: 18040
   * - Internal FE HTTP: 8030 -> External: 18030
   */
  private rewriteRedirectUrl(url: string): string {
    try {
      const parsed = new URL(url);

      // If using FE port (18030), redirect to BE port was internal (8040)
      // Rewrite to the likely external BE port (18040)
      if (this.config.httpPort === 18030 && parsed.port === "8040") {
        parsed.port = "18040";
      }

      // Also handle if we're already on external port mapping
      // 8030 -> 18030, 8040 -> 18040
      if (this.config.httpPort >= 18000) {
        if (parseInt(parsed.port) < 18000 && parseInt(parsed.port) >= 8000) {
          parsed.port = String(18000 + (parseInt(parsed.port) - 8000));
        }
      }

      return parsed.toString();
    } catch {
      return url;
    }
  }

  /**
   * Load data from a string (CSV or JSON content)
   *
   * Note: StarRocks FE may redirect to BE. We handle this manually to preserve
   * the Authorization header, which browsers/fetch strip on cross-origin redirects.
   */
  async loadData(
    data: string | Buffer,
    options: StreamLoadOptions
  ): Promise<StreamLoadResult> {
    const url = `http://${this.config.host}:${this.config.httpPort}/api/${options.database}/${options.table}/_stream_load`;

    const headers = buildHeaders(options);

    // Add basic auth
    const auth = Buffer.from(
      `${this.config.user}:${this.config.password ?? ""}`
    ).toString("base64");
    headers["Authorization"] = `Basic ${auth}`;

    // Use manual redirect handling to preserve Authorization header
    const body = typeof data === "string" ? data : new Uint8Array(data);
    let response = await fetch(url, {
      method: "PUT",
      headers,
      body,
      redirect: "manual",
    });

    // Handle FE -> BE redirect (307 Temporary Redirect)
    // FE redirects to BE for actual data loading, but Authorization header is
    // stripped on cross-origin redirects. We re-send the request manually.
    if (response.status === 307) {
      const location = response.headers.get("location");
      if (location) {
        // Rewrite internal BE port (8040) to external port if needed
        // FE returns internal BE address, which may not be accessible from outside
        const redirectUrl = this.rewriteRedirectUrl(location);

        response = await fetch(redirectUrl, {
          method: "PUT",
          headers, // Include Authorization header
          body,
        });
      }
    }

    const result = await response.json() as Record<string, unknown>;

    return {
      txnId: result.TxnId as number ?? 0,
      label: result.Label as string ?? "",
      status: result.Status as StreamLoadResult["status"] ?? "Fail",
      existingJobStatus: result.ExistingJobStatus as string | undefined,
      message: result.Message as string ?? "",
      numberLoadedRows: result.NumberLoadedRows as number ?? 0,
      numberFilteredRows: result.NumberFilteredRows as number ?? 0,
      numberUnselectedRows: result.NumberUnselectedRows as number ?? 0,
      loadBytes: result.LoadBytes as number ?? 0,
      loadTimeMs: result.LoadTimeMs as number ?? 0,
      beginTxnTimeMs: result.BeginTxnTimeMs as number ?? 0,
      streamLoadPlanTimeMs: result.StreamLoadPlanTimeMs as number ?? 0,
      readDataTimeMs: result.ReadDataTimeMs as number ?? 0,
      writeDataTimeMs: result.WriteDataTimeMs as number ?? 0,
      commitAndPublishTimeMs: result.CommitAndPublishTimeMs as number ?? 0,
      errorUrl: result.ErrorURL as string | undefined,
    };
  }

  /**
   * Load CSV data
   */
  async loadCsv(
    csvData: string,
    options: Omit<StreamLoadOptions, "format">
  ): Promise<StreamLoadResult> {
    return this.loadData(csvData, { ...options, format: "csv" });
  }

  /**
   * Load JSON data (array of objects or newline-delimited JSON)
   */
  async loadJson(
    jsonData: string | object[],
    options: Omit<StreamLoadOptions, "format">
  ): Promise<StreamLoadResult> {
    const data =
      typeof jsonData === "string"
        ? jsonData
        : JSON.stringify(jsonData);

    return this.loadData(data, {
      ...options,
      format: "json",
      stripOuterArray: Array.isArray(jsonData),
    });
  }

  /**
   * Load array of objects as JSON
   */
  async loadObjects<T extends Record<string, unknown>>(
    objects: T[],
    options: Omit<StreamLoadOptions, "format" | "jsonPaths" | "columns">
  ): Promise<StreamLoadResult> {
    if (objects.length === 0) {
      throw new Error("Cannot load empty array");
    }

    // Extract column names from first object
    const columns = Object.keys(objects[0]!);

    return this.loadJson(objects, {
      ...options,
      columns,
      stripOuterArray: true,
    });
  }
}

export function createStreamLoadClient(config: StreamLoadConfig): StreamLoadClient {
  return new StreamLoadClient(config);
}
