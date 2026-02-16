/**
 * StarRocks Materialized View Definitions
 *
 * Type-safe materialized view builder with refresh strategies and SQL generation.
 */

import type { Pool } from "mysql2/promise";
import type { Columns, InferSelectType } from "./columns";
import type { ColumnRef, DistributionConfig, PartitionConfig } from "./table";
import { QueryBuilder, type SelectedFields, type InferSelectedType } from "./query-builder";
import {
  escapeString,
  escapeDoubleQuoted,
  validateIntervalUnit,
  validatePositiveInteger,
  quoteIdentifier,
} from "./sql-utils";

// ============================================================================
// Types
// ============================================================================

export type RefreshType = "ASYNC" | "MANUAL";

export interface RefreshInterval {
  value: number;
  unit: "SECOND" | "MINUTE" | "HOUR" | "DAY";
}

export interface RefreshStrategy {
  type: RefreshType;
  startTime?: string;
  every?: RefreshInterval;
}

export interface MaterializedViewProperties {
  replication_num?: number;
  storage_medium?: "HDD" | "SSD";
  query_rewrite_consistency?: "checked" | "loose" | "disable";
  force_external_table_query_rewrite?: boolean;
  partition_refresh_number?: number;
  partition_ttl_number?: number;
  excluded_trigger_tables?: string[];
  mv_rewrite_staleness_second?: number;
  [key: string]: unknown;
}

export interface MaterializedViewConfig {
  distribution?: DistributionConfig;
  partition?: PartitionConfig;
  refresh?: RefreshStrategy;
  properties?: MaterializedViewProperties;
  comment?: string;
}

// ============================================================================
// MV Status Types
// ============================================================================

export type RefreshState = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";

export interface MaterializedViewStatus {
  isActive: boolean;
  lastRefresh: Date | null;
  lastRefreshState: RefreshState | null;
  lastRefreshDuration: number | null; // milliseconds
  rows: number;
  refreshType: RefreshType;
  nextRefresh: Date | null;
}

// ============================================================================
// Materialized View Definition
// ============================================================================

export interface MaterializedView<
  TName extends string,
  TColumns extends Columns,
> {
  readonly _type: "materialized_view";
  readonly name: TName;
  readonly columns: TColumns;
  readonly config: MaterializedViewConfig;
  readonly query: { sql: string; values: unknown[] };

  /** Inferred select type */
  readonly $inferSelect: InferSelectType<TColumns>;
}

/** MV with column references for query building */
export type MaterializedViewWithRefs<TName extends string, TColumns extends Columns> = MaterializedView<
  TName,
  TColumns
> & {
  /** Get the MV name */
  getMVName(): TName;
} & {
  [K in keyof TColumns]: ColumnRef<
    TColumns[K]["_type"],
    TName,
    TColumns[K]["name"]
  >;
};

// ============================================================================
// Materialized View Builder
// ============================================================================

class MaterializedViewBuilder<TName extends string, TColumns extends Columns = {}> {
  private _name: TName;
  private _columns: TColumns = {} as TColumns;
  private _config: MaterializedViewConfig = {};

  constructor(name: TName) {
    this._name = name;
  }

  /**
   * Define the columns of the MV with their types.
   * Optional - if not specified, columns are inferred from the query.
   */
  columns<T extends Columns>(cols: T): MaterializedViewBuilder<TName, T> {
    const builder = new MaterializedViewBuilder<TName, T>(this._name);
    builder._columns = cols;
    builder._config = { ...this._config };
    return builder;
  }

  /**
   * Set the distribution strategy
   */
  distributed(config: DistributionConfig): MaterializedViewBuilder<TName, TColumns> {
    this._config.distribution = config;
    return this;
  }

  /**
   * Set the partition strategy
   */
  partitionBy(config: PartitionConfig): MaterializedViewBuilder<TName, TColumns> {
    this._config.partition = config;
    return this;
  }

  /**
   * Set the refresh strategy
   */
  refresh(strategy: RefreshStrategy): MaterializedViewBuilder<TName, TColumns> {
    this._config.refresh = strategy;
    return this;
  }

  /**
   * Set MV properties
   */
  properties(props: MaterializedViewProperties): MaterializedViewBuilder<TName, TColumns> {
    this._config.properties = { ...this._config.properties, ...props };
    return this;
  }

  /**
   * Add a comment to the MV
   */
  comment(text: string): MaterializedViewBuilder<TName, TColumns> {
    this._config.comment = text;
    return this;
  }

  /**
   * Define the MV query using a query builder function
   */
  as<T extends SelectedFields>(
    queryFn: (qb: QueryBuilder<unknown>) => QueryBuilder<InferSelectedType<T>>
  ): MaterializedViewWithRefs<TName, TColumns> {
    const qb = new QueryBuilder();
    const query = queryFn(qb);
    const { sql, values } = query.toSQL();

    return new MaterializedViewImpl(
      this._name,
      this._columns,
      this._config,
      { sql, values }
    ) as unknown as MaterializedViewWithRefs<TName, TColumns>;
  }
}

// ============================================================================
// Materialized View Implementation
// ============================================================================

class MaterializedViewImpl<TName extends string, TColumns extends Columns>
  implements MaterializedView<TName, TColumns>
{
  readonly _type = "materialized_view" as const;
  readonly $inferSelect!: InferSelectType<TColumns>;
  readonly _mvName: TName;

  constructor(
    readonly name: TName,
    readonly columns: TColumns,
    readonly config: MaterializedViewConfig,
    readonly query: { sql: string; values: unknown[] }
  ) {
    this._mvName = name;
    // Create column references on the MV object
    for (const [key, col] of Object.entries(columns)) {
      (this as any)[key] = {
        _type: undefined as any,
        table: name,
        column: col.name,
        fullName: `${name}.${col.name}`,
        dataType: col.dataType,
        isNotNull: col.isNotNull,
        name: col.name,
      };
    }
  }

  /** Get the MV name */
  getMVName(): TName {
    return this._mvName;
  }
}

// ============================================================================
// Materialized View Factory
// ============================================================================

/**
 * Create a type-safe materialized view definition.
 *
 * @example
 * ```typescript
 * const eventsByVenue = createMaterializedView("events_by_venue")
 *   .columns({
 *     venueId: bigint("venue_id"),
 *     eventCount: bigint("event_count"),
 *     totalRevenue: double("total_revenue"),
 *   })
 *   .distributed({ type: "HASH", columns: ["venue_id"], buckets: 8 })
 *   .refresh({
 *     type: "ASYNC",
 *     startTime: "2024-01-01 00:00:00",
 *     every: { value: 1, unit: "HOUR" },
 *   })
 *   .properties({
 *     replication_num: 1,
 *     query_rewrite_consistency: "loose",
 *   })
 *   .comment("Aggregated event statistics by venue")
 *   .as((qb) =>
 *     qb.select({
 *       venueId: events.venueId,
 *       eventCount: count(events.id),
 *       totalRevenue: sum(events.price),
 *     })
 *     .from(events)
 *     .groupBy(events.venueId)
 *   );
 * ```
 */
export function createMaterializedView<TName extends string>(
  name: TName
): MaterializedViewBuilder<TName> {
  return new MaterializedViewBuilder(name);
}

// ============================================================================
// SQL Generation
// ============================================================================

/**
 * Generate CREATE MATERIALIZED VIEW SQL from an MV definition.
 * All identifiers are properly quoted with backticks.
 */
export function generateCreateMaterializedViewSQL<T extends MaterializedView<any, any>>(
  mv: T
): string {
  const lines: string[] = [];
  const mvName = (mv as any)._mvName ?? mv.name;

  // Quote MV name
  lines.push(`CREATE MATERIALIZED VIEW ${quoteIdentifier(mvName)}`);

  // Comment
  if (mv.config.comment) {
    lines.push(`COMMENT '${mv.config.comment.replace(/'/g, "''")}'`);
  }

  // Distribution - quote column names
  if (mv.config.distribution) {
    const d = mv.config.distribution;
    if (d.type === "HASH") {
      const distCols = d.columns.map(quoteIdentifier).join(", ");
      lines.push(`DISTRIBUTED BY HASH(${distCols}) BUCKETS ${d.buckets}`);
    } else {
      lines.push(`DISTRIBUTED BY RANDOM BUCKETS ${d.buckets}`);
    }
  }

  // Partition - quote column names
  if (mv.config.partition) {
    const p = mv.config.partition;
    if (p.type === "RANGE") {
      if (p.interval) {
        lines.push(`PARTITION BY date_trunc('${p.interval.toLowerCase()}', ${quoteIdentifier(p.column)})`);
      } else if (p.partitions) {
        const partDefs = p.partitions
          .map(
            (part) =>
              `PARTITION ${part.name} VALUES LESS THAN (${part.lessThan === "MAXVALUE" ? "MAXVALUE" : `"${part.lessThan}"`})`
          )
          .join(",\n  ");
        lines.push(`PARTITION BY RANGE (${quoteIdentifier(p.column)}) (\n  ${partDefs}\n)`);
      }
    } else if (p.type === "EXPRESSION") {
      lines.push(`PARTITION BY (${p.expression})`);
    }
  }

  // Refresh
  if (mv.config.refresh) {
    const r = mv.config.refresh;
    if (r.type === "MANUAL") {
      lines.push("REFRESH MANUAL");
    } else {
      let refreshClause = "REFRESH ASYNC";
      if (r.startTime) {
        refreshClause += ` START('${escapeString(r.startTime)}')`;
      }
      if (r.every) {
        validatePositiveInteger(r.every.value, "refresh interval value");
        validateIntervalUnit(r.every.unit);
        refreshClause += ` EVERY(INTERVAL ${r.every.value} ${r.every.unit})`;
      }
      lines.push(refreshClause);
    }
  }

  // Properties
  if (mv.config.properties) {
    const props = Object.entries(mv.config.properties)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        const escapedKey = escapeDoubleQuoted(String(k));
        if (typeof v === "boolean") {
          return `"${escapedKey}" = "${v}"`;
        }
        if (Array.isArray(v)) {
          const escapedValues = v.map((item) => escapeDoubleQuoted(String(item))).join(",");
          return `"${escapedKey}" = "${escapedValues}"`;
        }
        return `"${escapedKey}" = "${escapeDoubleQuoted(String(v))}"`;
      })
      .join(", ");
    if (props) {
      lines.push(`PROPERTIES (${props})`);
    }
  }

  // Query
  lines.push("AS");
  lines.push(mv.query.sql);

  return lines.join("\n");
}

/**
 * Generate DROP MATERIALIZED VIEW SQL
 */
export function generateDropMaterializedViewSQL<T extends MaterializedView<any, any>>(
  mv: T,
  ifExists = true
): string {
  const mvName = (mv as any)._mvName ?? mv.name;
  return `DROP MATERIALIZED VIEW ${ifExists ? "IF EXISTS " : ""}${quoteIdentifier(mvName)}`;
}

/**
 * Generate ALTER MATERIALIZED VIEW SQL for refresh changes
 */
export function generateAlterRefreshSQL<T extends MaterializedView<any, any>>(
  mv: T,
  refresh: RefreshStrategy
): string {
  const mvName = quoteIdentifier((mv as any)._mvName ?? mv.name);

  if (refresh.type === "MANUAL") {
    return `ALTER MATERIALIZED VIEW ${mvName} REFRESH MANUAL`;
  }

  let sql = `ALTER MATERIALIZED VIEW ${mvName} REFRESH ASYNC`;
  if (refresh.startTime) {
    sql += ` START('${refresh.startTime}')`;
  }
  if (refresh.every) {
    sql += ` EVERY(INTERVAL ${refresh.every.value} ${refresh.every.unit})`;
  }
  return sql;
}

// ============================================================================
// MV Operations
// ============================================================================

export interface MVOperations {
  /**
   * Trigger a refresh of the materialized view
   */
  refresh(options?: {
    sync?: boolean;
    partitions?: string[];
    force?: boolean;
  }): Promise<void>;

  /**
   * Cancel an ongoing refresh
   */
  cancelRefresh(): Promise<void>;

  /**
   * Set the active state of the MV
   */
  setActive(active: boolean): Promise<void>;

  /**
   * Update the refresh strategy
   */
  setRefresh(strategy: RefreshStrategy): Promise<void>;

  /**
   * Get the current status of the MV
   */
  status(): Promise<MaterializedViewStatus>;
}

/**
 * Create MV operations interface for a materialized view
 */
export function createMVOperations(
  pool: Pool,
  mv: MaterializedView<string, any>
): MVOperations {
  const mvName = (mv as any)._mvName ?? mv.name;

  return {
    async refresh(options = {}) {
      let sql = `REFRESH MATERIALIZED VIEW ${mvName}`;

      if (options.partitions && options.partitions.length > 0) {
        sql += ` PARTITION (${options.partitions.join(", ")})`;
      }

      if (options.force) {
        sql += " FORCE";
      }

      if (options.sync) {
        sql += " WITH SYNC MODE";
      }

      await pool.query(sql);
    },

    async cancelRefresh() {
      await pool.query(`CANCEL REFRESH MATERIALIZED VIEW ${mvName}`);
    },

    async setActive(active: boolean) {
      const state = active ? "ACTIVE" : "INACTIVE";
      await pool.query(`ALTER MATERIALIZED VIEW ${mvName} ${state}`);
    },

    async setRefresh(strategy: RefreshStrategy) {
      const sql = generateAlterRefreshSQL(mv, strategy);
      await pool.query(sql);
    },

    async status(): Promise<MaterializedViewStatus> {
      // Query materialized view metadata
      const [rows] = await pool.query<any[]>(`
        SELECT
          mv.is_active,
          mv.refresh_type,
          task.last_refresh_start_time,
          task.last_refresh_finished_time,
          task.last_refresh_state,
          (SELECT COUNT(*) FROM ${mvName}) as row_count
        FROM information_schema.materialized_views mv
        LEFT JOIN information_schema.task_runs task
          ON task.task_name = CONCAT('mv-', mv.MATERIALIZED_VIEW_ID)
        WHERE mv.TABLE_NAME = ?
        ORDER BY task.last_refresh_start_time DESC
        LIMIT 1
      `, [mvName]);

      if (rows.length === 0) {
        throw new Error(`Materialized view '${mvName}' not found`);
      }

      const row = rows[0];
      const lastRefreshStart = row.last_refresh_start_time
        ? new Date(row.last_refresh_start_time)
        : null;
      const lastRefreshEnd = row.last_refresh_finished_time
        ? new Date(row.last_refresh_finished_time)
        : null;

      return {
        isActive: row.is_active === "true" || row.is_active === 1,
        lastRefresh: lastRefreshEnd,
        lastRefreshState: row.last_refresh_state as RefreshState | null,
        lastRefreshDuration:
          lastRefreshStart && lastRefreshEnd
            ? lastRefreshEnd.getTime() - lastRefreshStart.getTime()
            : null,
        rows: row.row_count ?? 0,
        refreshType: row.refresh_type as RefreshType,
        nextRefresh: null, // Would need to parse refresh schedule
      };
    },
  };
}

// ============================================================================
// Query Interface Extension
// ============================================================================

/**
 * Create a database interface with MV operations
 */
export function createMVQueryInterface(pool: Pool) {
  return {
    /**
     * Get MV operations for a materialized view
     */
    mv<TColumns extends Columns>(
      mvDef: MaterializedView<string, TColumns>
    ): MVOperations {
      return createMVOperations(pool, mvDef);
    },
  };
}
