/**
 * StarRocks Data Archive Client
 *
 * Export data to S3/HDFS using INSERT INTO FILES functionality.
 * Supports both manual/ad-hoc archiving and scheduled policy-based archiving.
 */

import type { StarRocksConfig } from "./types";
import { createPool, type Pool } from "mysql2/promise";

/**
 * Validate a SQL identifier (database, table name).
 */
function validateIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}. Only alphanumeric characters and underscores are allowed.`);
  }
  if (name.length > 128) {
    throw new Error(`SQL identifier too long (max 128): ${name}`);
  }
  return name;
}

/**
 * Redact credentials from SQL strings for safe logging.
 */
function redactCredentials(sql: string): string {
  return sql.replace(
    /("(?:access_key|secret_key|password|aws\.s3\.access_key|aws\.s3\.secret_key)")\s*=\s*"[^"]+"/gi,
    '$1 = "[REDACTED]"'
  );
}

// ============================================================================
// Types
// ============================================================================

/**
 * S3 destination configuration
 */
export interface S3Destination {
  type: "s3";
  path: string;
  pathTemplate?: string;
  credentials: {
    accessKey: string;
    secretKey: string;
    region: string;
    endpoint?: string; // For S3-compatible (MinIO, etc.)
  };
}

/**
 * HDFS destination configuration
 */
export interface HDFSDestination {
  type: "hdfs";
  path: string;
  pathTemplate?: string;
  credentials: {
    username: string;
    password?: string;
  };
}

/**
 * Supported archive destinations
 */
export type ArchiveDestination = S3Destination | HDFSDestination;

/**
 * Output file format
 */
export type ArchiveFormat = "parquet" | "csv" | "orc";

/**
 * Compression algorithm
 */
export type ArchiveCompression =
  | "uncompressed"
  | "snappy"
  | "zstd"
  | "lz4"
  | "gzip";

/**
 * Options for archive operation
 */
export interface ArchiveOptions {
  /** SQL query to select data for archiving */
  query: string;
  /** Destination storage configuration */
  destination: ArchiveDestination;
  /** Output file format */
  format: ArchiveFormat;
  /** Compression algorithm (default: uncompressed) */
  compression?: ArchiveCompression;
  /** Column(s) to partition output files by */
  partitionBy?: string | string[];
  /** Target file size in bytes (default: 1GB) */
  maxFileSize?: number;
  /** Force output to single file */
  singleFile?: boolean;
}

/**
 * Result of archive operation
 */
export interface ArchiveResult {
  /** Whether the archive succeeded */
  success: boolean;
  /** List of created file paths */
  files: string[];
  /** Total rows archived */
  totalRows: number;
  /** Total bytes written */
  totalBytes: number;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Source table configuration for policies
 */
export interface ArchivePolicySource {
  /** Database name */
  database: string;
  /** Table name */
  table: string;
  /** Columns to archive (default: all) */
  columns?: string[];
  /** WHERE clause filter */
  filter?: string;
}

/**
 * Archive policy configuration
 */
export interface ArchivePolicyConfig {
  /** Policy name for identification */
  name: string;
  /** Source table configuration */
  source: ArchivePolicySource;
  /** Destination storage configuration */
  destination: ArchiveDestination;
  /** Output file format */
  format: ArchiveFormat;
  /** Compression algorithm */
  compression?: ArchiveCompression;
  /** Column(s) to partition output files by */
  partitionBy?: string | string[];
}

/**
 * Archive policy object
 */
export interface ArchivePolicy extends ArchivePolicyConfig {
  /** Generate archive options for execution */
  toArchiveOptions(date?: Date): ArchiveOptions;
}

/**
 * Options for purging archived data
 */
export interface PurgeOptions {
  /** Database name */
  database: string;
  /** Table name */
  table: string;
  /** WHERE clause filter (required for safety) */
  filter: string;
  /** Preview rows to be deleted without actually deleting */
  dryRun?: boolean;
}

/**
 * Result of purge operation
 */
export interface PurgeResult {
  /** Number of rows deleted (or would be deleted in dry run) */
  deletedRows: number;
  /** Whether this was a dry run */
  dryRun: boolean;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Data Archive Client for exporting data to S3/HDFS
 */
export class DataArchiveClient {
  private pool: Pool;

  constructor(config: StarRocksConfig) {
    this.pool = createPool({
      host: config.host,
      port: config.mysqlPort,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }

  /**
   * Archive data using a custom query
   */
  async archive(options: ArchiveOptions): Promise<ArchiveResult> {
    const startTime = Date.now();
    const sql = this.buildInsertIntoFilesSQL(options);

    try {
      const [rows] = await this.pool.query(sql);
      const result = this.parseArchiveResult(rows);
      return {
        ...result,
        success: true,
        durationMs: Date.now() - startTime,
      };
    } catch {
      return {
        success: false,
        files: [],
        totalRows: 0,
        totalBytes: 0,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Define a reusable archive policy
   */
  definePolicy(config: ArchivePolicyConfig): ArchivePolicy {
    validateIdentifier(config.source.database);
    validateIdentifier(config.source.table);

    const self = this;
    return {
      ...config,
      toArchiveOptions(date?: Date): ArchiveOptions {
        const effectiveDate = date ?? new Date();
        const columns = config.source.columns?.join(", ") ?? "*";
        const filter = config.source.filter
          ? ` WHERE ${config.source.filter}`
          : "";
        const query = `SELECT ${columns} FROM ${config.source.database}.${config.source.table}${filter}`;

        // Expand path template if provided
        const destination = { ...config.destination };
        if (destination.pathTemplate) {
          destination.path = self.expandPathTemplate(
            destination.pathTemplate,
            effectiveDate
          );
        }

        return {
          query,
          destination,
          format: config.format,
          compression: config.compression,
          partitionBy: config.partitionBy,
        };
      },
    };
  }

  /**
   * Execute an archive policy
   */
  async executePolicy(
    policy: ArchivePolicy,
    date?: Date
  ): Promise<ArchiveResult> {
    const options = policy.toArchiveOptions(date);
    return this.archive(options);
  }

  /**
   * Purge (delete) archived data from source table
   */
  async purgeArchived(options: PurgeOptions): Promise<PurgeResult> {
    const { database, table, filter, dryRun = false } = options;

    validateIdentifier(database);
    validateIdentifier(table);

    if (!filter || filter.trim() === "") {
      throw new Error(
        "Filter is required for purgeArchived to prevent accidental full table deletes"
      );
    }

    const qualifiedTable = `${database}.${table}`;

    if (dryRun) {
      // Count rows that would be deleted
      const countSql = `SELECT COUNT(*) as cnt FROM ${qualifiedTable} WHERE ${filter}`;
      const [rows] = await this.pool.query(countSql);
      const count = (rows as Array<{ cnt: number }>)[0]?.cnt ?? 0;
      return { deletedRows: count, dryRun: true };
    }

    // Actually delete the rows
    const deleteSql = `DELETE FROM ${qualifiedTable} WHERE ${filter}`;
    const [result] = await this.pool.query(deleteSql);
    const affectedRows = (result as { affectedRows?: number }).affectedRows ?? 0;

    return { deletedRows: affectedRows, dryRun: false };
  }

  /**
   * Close the database connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Build INSERT INTO FILES SQL statement
   */
  private buildInsertIntoFilesSQL(options: ArchiveOptions): string {
    const properties: string[] = [];

    // Path
    properties.push(`"path" = "${options.destination.path}"`);

    // Format
    properties.push(`"format" = "${options.format}"`);

    // Compression
    if (options.compression) {
      properties.push(`"compression" = "${options.compression}"`);
    }

    // Partition by
    if (options.partitionBy) {
      const partitionCols = Array.isArray(options.partitionBy)
        ? options.partitionBy.join(", ")
        : options.partitionBy;
      properties.push(`"partition_by" = "${partitionCols}"`);
    }

    // Max file size
    if (options.maxFileSize) {
      properties.push(
        `"target_max_file_size" = "${options.maxFileSize}"`
      );
    }

    // Single file
    if (options.singleFile) {
      properties.push(`"single" = "true"`);
    }

    // Destination-specific credentials
    // Note: StarRocks INSERT INTO FILES requires credentials as property strings.
    // Values are escaped to prevent SQL injection via credential fields.
    if (options.destination.type === "s3") {
      const s3 = options.destination;
      properties.push(`"aws.s3.access_key" = "${s3.credentials.accessKey.replace(/["\\]/g, "")}"`);
      properties.push(`"aws.s3.secret_key" = "${s3.credentials.secretKey.replace(/["\\]/g, "")}"`);
      properties.push(`"aws.s3.region" = "${s3.credentials.region.replace(/["\\]/g, "")}"`);
      if (s3.credentials.endpoint) {
        properties.push(`"aws.s3.endpoint" = "${s3.credentials.endpoint.replace(/["\\]/g, "")}"`);
      }
    } else if (options.destination.type === "hdfs") {
      const hdfs = options.destination;
      properties.push(
        `"hadoop.security.authentication" = "simple"`
      );
      properties.push(`"username" = "${hdfs.credentials.username.replace(/["\\]/g, "")}"`);
      if (hdfs.credentials.password) {
        properties.push(`"password" = "${hdfs.credentials.password.replace(/["\\]/g, "")}"`);
      }
    }

    const propertiesStr = properties.join(",\n    ");

    return `INSERT INTO FILES(
    ${propertiesStr}
)
${options.query}`;
  }

  /**
   * Parse the result of INSERT INTO FILES
   */
  private parseArchiveResult(
    rows: unknown
  ): Omit<ArchiveResult, "success" | "durationMs"> {
    // INSERT INTO FILES returns result set with file info
    // Format: FileNumber, TotalRows, FileSize, URL
    const resultRows = rows as Array<{
      FileNumber?: number;
      TotalRows?: number;
      FileSize?: number;
      URL?: string;
    }>;

    const files: string[] = [];
    let totalRows = 0;
    let totalBytes = 0;

    for (const row of resultRows) {
      if (row.URL) {
        files.push(row.URL);
      }
      if (row.TotalRows) {
        totalRows += row.TotalRows;
      }
      if (row.FileSize) {
        totalBytes += row.FileSize;
      }
    }

    return { files, totalRows, totalBytes };
  }

  /**
   * Expand path template with date placeholders
   */
  private expandPathTemplate(template: string, date: Date): string {
    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;

    return template
      .replace(/{year}/g, year)
      .replace(/{month}/g, month)
      .replace(/{day}/g, day)
      .replace(/{date}/g, dateStr);
  }
}

/**
 * Create a new Data Archive Client
 */
export function createDataArchiveClient(
  config: StarRocksConfig
): DataArchiveClient {
  return new DataArchiveClient(config);
}
