/**
 * StarRocks Materialized Views - Async MV management
 *
 * Asynchronous materialized views support multi-table joins, complex aggregations,
 * automatic query rewrite, and flexible refresh strategies.
 */

import type { DistributionConfig, PartitionConfig, TableProperties } from "./types";

// ============================================================================
// Refresh Strategies
// ============================================================================

/** Manual refresh - only refresh when explicitly triggered */
export interface ManualRefresh {
  type: "MANUAL";
}

/** Async refresh - refresh at intervals or on data change */
export interface AsyncRefresh {
  type: "ASYNC";
  /** Start time for first refresh (ISO timestamp) */
  startTime?: string;
  /** Refresh interval */
  every?: {
    value: number;
    unit: "SECOND" | "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH";
  };
}

export type RefreshStrategy = ManualRefresh | AsyncRefresh;

// ============================================================================
// Materialized View Options
// ============================================================================

export interface MaterializedViewOptions {
  /** Name of the materialized view */
  name: string;
  /** The SELECT query defining the view */
  query: string;
  /** Data distribution */
  distribution?: DistributionConfig;
  /** Partition configuration */
  partition?: PartitionConfig;
  /** Refresh strategy */
  refresh?: RefreshStrategy;
  /** Properties */
  properties?: MaterializedViewProperties;
  /** Comment */
  comment?: string;
}

export interface MaterializedViewProperties extends TableProperties {
  /** Partition refresh number - max partitions per refresh */
  partition_refresh_number?: number;
  /** Partition TTL in seconds */
  partition_ttl_second?: number;
  /** Number of partitions to keep */
  partition_ttl_number?: number;
  /** Refresh range start (-1 for all partitions) */
  auto_refresh_partitions_limit?: number;
  /** Tables to exclude from triggering refresh */
  excluded_trigger_tables?: string[];
  /** Resource group for refresh tasks */
  resource_group?: string;
  /** Force external table query rewrite */
  force_external_table_query_rewrite?: "true" | "false";
  /** Query rewrite consistency mode */
  query_rewrite_consistency?: "disable" | "checked" | "loose" | "force";
}

// ============================================================================
// Materialized View Info
// ============================================================================

export interface MaterializedViewInfo {
  id: string;
  name: string;
  databaseName: string;
  refreshType: string;
  isActive: boolean;
  inactiveReason?: string;
  partitionType: string;
  taskId?: string;
  taskName?: string;
  createTime: string;
  lastRefreshStartTime?: string;
  lastRefreshFinishedTime?: string;
  lastRefreshDuration?: string;
  lastRefreshState?: string;
  rows: number;
  text: string;
}

export interface RefreshTaskInfo {
  taskRunId: string;
  taskId: string;
  createTime: string;
  finishTime?: string;
  state: "PENDING" | "RUNNING" | "FAILED" | "SUCCESS";
  database: string;
  definition: string;
  expireTime?: string;
  errorCode?: number;
  errorMessage?: string;
  progress: string;
  extraMessage?: string;
  properties?: Record<string, string>;
}

// ============================================================================
// Materialized View Manager
// ============================================================================

/**
 * Manager for StarRocks Materialized Views
 */
export class MaterializedViewManager {
  private executeQuery: (sql: string) => Promise<void>;
  private rawQuery: <T>(sql: string) => Promise<T[]>;

  constructor(
    executeQuery: (sql: string) => Promise<void>,
    rawQuery: <T>(sql: string) => Promise<T[]>
  ) {
    this.executeQuery = executeQuery;
    this.rawQuery = rawQuery;
  }

  /**
   * Create an asynchronous materialized view
   */
  async create(options: MaterializedViewOptions): Promise<void> {
    let sql = `CREATE MATERIALIZED VIEW ${options.name}`;

    // Comment
    if (options.comment) {
      sql += `\nCOMMENT '${options.comment}'`;
    }

    // Partition
    if (options.partition) {
      sql += this.formatPartition(options.partition);
    }

    // Distribution
    if (options.distribution) {
      sql += this.formatDistribution(options.distribution);
    }

    // Refresh strategy
    if (options.refresh) {
      sql += this.formatRefresh(options.refresh);
    }

    // Properties
    if (options.properties) {
      sql += this.formatProperties(options.properties);
    }

    // Query
    sql += `\nAS ${options.query}`;

    await this.executeQuery(sql);
  }

  /**
   * Drop a materialized view
   */
  async drop(name: string, ifExists = true): Promise<void> {
    const clause = ifExists ? "IF EXISTS" : "";
    await this.executeQuery(`DROP MATERIALIZED VIEW ${clause} ${name}`);
  }

  /**
   * Refresh a materialized view
   * @param syncMode If true, wait for refresh to complete
   */
  async refresh(name: string, options?: {
    syncMode?: boolean;
    partitions?: string[];
    force?: boolean;
  }): Promise<void> {
    let sql = `REFRESH MATERIALIZED VIEW ${name}`;

    if (options?.partitions?.length) {
      sql += ` PARTITION (${options.partitions.map(p => `'${p}'`).join(", ")})`;
    }

    if (options?.force) {
      sql += " FORCE";
    }

    if (options?.syncMode) {
      sql += " WITH SYNC MODE";
    }

    await this.executeQuery(sql);
  }

  /**
   * Cancel a running refresh task
   */
  async cancelRefresh(name: string): Promise<void> {
    await this.executeQuery(`CANCEL REFRESH MATERIALIZED VIEW ${name}`);
  }

  /**
   * Alter a materialized view
   */
  async alter(
    name: string,
    changes: {
      rename?: string;
      active?: boolean;
      refresh?: RefreshStrategy;
      properties?: MaterializedViewProperties;
    }
  ): Promise<void> {
    if (changes.rename) {
      await this.executeQuery(`ALTER MATERIALIZED VIEW ${name} RENAME ${changes.rename}`);
      return;
    }

    if (changes.active !== undefined) {
      const status = changes.active ? "ACTIVE" : "INACTIVE";
      await this.executeQuery(`ALTER MATERIALIZED VIEW ${name} ${status}`);
      return;
    }

    if (changes.refresh) {
      const refreshClause = this.formatRefresh(changes.refresh).trim();
      await this.executeQuery(`ALTER MATERIALIZED VIEW ${name} ${refreshClause}`);
      return;
    }

    if (changes.properties) {
      const props = Object.entries(changes.properties)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `"${k}" = "${v}"`)
        .join(", ");
      await this.executeQuery(`ALTER MATERIALIZED VIEW ${name} SET (${props})`);
    }
  }

  /**
   * Show materialized views
   */
  async list(pattern?: string): Promise<MaterializedViewInfo[]> {
    let sql = "SHOW MATERIALIZED VIEWS";
    if (pattern) {
      sql += ` WHERE NAME LIKE '${pattern}'`;
    }

    const rows = await this.rawQuery<Record<string, unknown>>(sql);

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      name: String(row.name ?? ""),
      databaseName: String(row.database_name ?? ""),
      refreshType: String(row.refresh_type ?? ""),
      isActive: row.is_active === "true" || row.is_active === true,
      inactiveReason: row.inactive_reason as string | undefined,
      partitionType: String(row.partition_type ?? ""),
      taskId: row.task_id as string | undefined,
      taskName: row.task_name as string | undefined,
      createTime: String(row.create_time ?? ""),
      lastRefreshStartTime: row.last_refresh_start_time as string | undefined,
      lastRefreshFinishedTime: row.last_refresh_finished_time as string | undefined,
      lastRefreshDuration: row.last_refresh_duration as string | undefined,
      lastRefreshState: row.last_refresh_state as string | undefined,
      rows: Number(row.rows ?? 0),
      text: String(row.text ?? ""),
    }));
  }

  /**
   * Get the CREATE statement for a materialized view
   */
  async showCreate(name: string): Promise<string> {
    const rows = await this.rawQuery<{ "Create Materialized View": string }>(
      `SHOW CREATE MATERIALIZED VIEW ${name}`
    );
    return rows[0]?.["Create Materialized View"] ?? "";
  }

  /**
   * Get refresh task history for a materialized view
   */
  async getRefreshTasks(
    mvName: string,
    options?: { limit?: number; state?: RefreshTaskInfo["state"] }
  ): Promise<RefreshTaskInfo[]> {
    let sql = `
      SELECT * FROM information_schema.task_runs
      WHERE task_name LIKE 'mv-${mvName}%'
    `;

    if (options?.state) {
      sql += ` AND state = '${options.state}'`;
    }

    sql += " ORDER BY create_time DESC";

    if (options?.limit) {
      sql += ` LIMIT ${options.limit}`;
    }

    const rows = await this.rawQuery<Record<string, unknown>>(sql);

    return rows.map((row) => ({
      taskRunId: String(row.task_run_id ?? row.TASK_RUN_ID ?? ""),
      taskId: String(row.task_id ?? row.TASK_ID ?? ""),
      createTime: String(row.create_time ?? row.CREATE_TIME ?? ""),
      finishTime: (row.finish_time ?? row.FINISH_TIME) as string | undefined,
      state: String(row.state ?? row.STATE ?? "PENDING") as RefreshTaskInfo["state"],
      database: String(row.database ?? row.DATABASE ?? ""),
      definition: String(row.definition ?? row.DEFINITION ?? ""),
      expireTime: (row.expire_time ?? row.EXPIRE_TIME) as string | undefined,
      errorCode: (row.error_code ?? row.ERROR_CODE) as number | undefined,
      errorMessage: (row.error_message ?? row.ERROR_MESSAGE) as string | undefined,
      progress: String(row.progress ?? row.PROGRESS ?? ""),
      extraMessage: (row.extra_message ?? row.EXTRA_MESSAGE) as string | undefined,
      properties: (row.properties ?? row.PROPERTIES) as Record<string, string> | undefined,
    }));
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private formatPartition(partition: PartitionConfig): string {
    switch (partition.type) {
      case "EXPRESSION":
        return `\nPARTITION BY (${partition.expression})`;
      case "RANGE":
        return `\nPARTITION BY RANGE(${partition.columns.join(", ")})`;
      case "LIST":
        return `\nPARTITION BY LIST(${partition.columns.join(", ")})`;
      default:
        return "";
    }
  }

  private formatDistribution(distribution: DistributionConfig): string {
    switch (distribution.type) {
      case "HASH":
        let sql = `\nDISTRIBUTED BY HASH(${distribution.columns.join(", ")})`;
        if (distribution.buckets) sql += ` BUCKETS ${distribution.buckets}`;
        return sql;
      case "RANDOM":
        let randomSql = "\nDISTRIBUTED BY RANDOM";
        if (distribution.buckets) randomSql += ` BUCKETS ${distribution.buckets}`;
        return randomSql;
      default:
        return "";
    }
  }

  private formatRefresh(refresh: RefreshStrategy): string {
    switch (refresh.type) {
      case "MANUAL":
        return "\nREFRESH MANUAL";
      case "ASYNC": {
        let sql = "\nREFRESH ASYNC";
        if (refresh.startTime) {
          sql += ` START('${refresh.startTime}')`;
        }
        if (refresh.every) {
          sql += ` EVERY (INTERVAL ${refresh.every.value} ${refresh.every.unit})`;
        }
        return sql;
      }
      default:
        return "";
    }
  }

  private formatProperties(properties: MaterializedViewProperties): string {
    const props: string[] = [];

    // Handle known properties
    const knownProps: (keyof MaterializedViewProperties)[] = [
      "replication_num",
      "partition_refresh_number",
      "partition_ttl_second",
      "partition_ttl_number",
      "auto_refresh_partitions_limit",
      "resource_group",
      "force_external_table_query_rewrite",
      "query_rewrite_consistency",
    ];

    for (const key of knownProps) {
      const value = properties[key];
      if (value !== undefined) {
        props.push(`"${key}" = "${value}"`);
      }
    }

    // Handle excluded_trigger_tables specially
    if (properties.excluded_trigger_tables?.length) {
      props.push(
        `"excluded_trigger_tables" = "${properties.excluded_trigger_tables.join(",")}"`
      );
    }

    // Handle other custom properties
    for (const [key, value] of Object.entries(properties)) {
      if (!knownProps.includes(key as keyof MaterializedViewProperties) &&
          key !== "excluded_trigger_tables" &&
          value !== undefined) {
        props.push(`"${key}" = "${value}"`);
      }
    }

    if (props.length === 0) return "";
    return `\nPROPERTIES (\n  ${props.join(",\n  ")}\n)`;
  }
}
