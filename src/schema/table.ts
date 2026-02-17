/**
 * StarRocks Table Definitions
 *
 * Define tables with StarRocks-specific features: key types, distribution, partitioning.
 */

import type { Column, Columns, InferSelectType, InferInsertType } from "./columns";
import {
  escapeString,
  escapeDoubleQuoted,
  validatePartitionName,
  formatDefaultValue,
  quoteIdentifier,
} from "./sql-utils";

// ============================================================================
// Key Types
// ============================================================================

export type KeyType = "PRIMARY" | "DUPLICATE" | "AGGREGATE" | "UNIQUE";

export interface KeyConfig {
  type: KeyType;
  columns: string[];
}

/** PRIMARY KEY - upsert semantics, latest value wins */
export function primaryKey<T extends Column<any, any, any, any>[]>(
  ...columns: T
): KeyConfig {
  return {
    type: "PRIMARY",
    columns: columns.map((c) => c.name),
  };
}

/** DUPLICATE KEY - append-only, allows duplicates */
export function duplicateKey<T extends Column<any, any, any, any>[]>(
  ...columns: T
): KeyConfig {
  return {
    type: "DUPLICATE",
    columns: columns.map((c) => c.name),
  };
}

/** AGGREGATE KEY - pre-aggregation on insert */
export function aggregateKey<T extends Column<any, any, any, any>[]>(
  ...columns: T
): KeyConfig {
  return {
    type: "AGGREGATE",
    columns: columns.map((c) => c.name),
  };
}

/** UNIQUE KEY - unique constraint with replace semantics */
export function uniqueKey<T extends Column<any, any, any, any>[]>(
  ...columns: T
): KeyConfig {
  return {
    type: "UNIQUE",
    columns: columns.map((c) => c.name),
  };
}

// ============================================================================
// Distribution
// ============================================================================

export type DistributionType = "HASH" | "RANDOM";

export interface HashDistributionConfig {
  type: "HASH";
  columns: string[];
  buckets: number;
}

export interface RandomDistributionConfig {
  type: "RANDOM";
  buckets: number;
}

export type DistributionConfig = HashDistributionConfig | RandomDistributionConfig;

/** HASH distribution by column(s) */
export function hash<T extends Column<any, any, any, any> | Column<any, any, any, any>[]>(
  columns: T,
  config: { buckets: number }
): HashDistributionConfig {
  const cols = Array.isArray(columns) ? columns : [columns];
  return {
    type: "HASH",
    columns: cols.map((c) => c.name),
    buckets: config.buckets,
  };
}

/** RANDOM distribution */
export function random(config: { buckets: number }): RandomDistributionConfig {
  return {
    type: "RANDOM",
    buckets: config.buckets,
  };
}

// ============================================================================
// Partitioning
// ============================================================================

export type PartitionType = "RANGE" | "LIST" | "EXPRESSION";

export interface RangePartitionConfig {
  type: "RANGE";
  column: string;
  interval?: "DAY" | "WEEK" | "MONTH" | "YEAR";
  start?: string;
  end?: string;
  partitions?: Array<{
    name: string;
    lessThan: string | "MAXVALUE";
  }>;
}

export interface ListPartitionConfig {
  type: "LIST";
  column: string;
  partitions: Record<string, string[]>;
}

export interface ExpressionPartitionConfig {
  type: "EXPRESSION";
  expression: string;
  interval?: "DAY" | "WEEK" | "MONTH" | "YEAR";
}

export type PartitionConfig =
  | RangePartitionConfig
  | ListPartitionConfig
  | ExpressionPartitionConfig;

/** RANGE partition by column with auto intervals */
export function rangePartition<T extends Column<any, any, any, any>>(
  column: T,
  config: {
    interval?: "DAY" | "WEEK" | "MONTH" | "YEAR";
    start?: string;
    end?: string;
    partitions?: Array<{ name: string; lessThan: string | "MAXVALUE" }>;
  }
): RangePartitionConfig {
  return {
    type: "RANGE",
    column: column.name,
    ...config,
  };
}

/** LIST partition by column with explicit values */
export function listPartition<T extends Column<any, any, any, any>>(
  column: T,
  partitions: Record<string, string[]>
): ListPartitionConfig {
  return {
    type: "LIST",
    column: column.name,
    partitions,
  };
}

/** Expression-based partition (e.g., date_trunc) */
export function expressionPartition(
  expression: string,
  config?: { interval?: "DAY" | "WEEK" | "MONTH" | "YEAR" }
): ExpressionPartitionConfig {
  return {
    type: "EXPRESSION",
    expression,
    ...config,
  };
}

// ============================================================================
// Table Properties
// ============================================================================

export interface TableProperties {
  replication_num?: number;
  storage_medium?: "HDD" | "SSD";
  storage_cooldown_time?: string;
  bloom_filter_columns?: string[];
  colocate_with?: string;
  dynamic_partition?: {
    enable?: boolean;
    time_unit?: "DAY" | "WEEK" | "MONTH" | "YEAR";
    start?: number;
    end?: number;
    prefix?: string;
    buckets?: number;
  };
  [key: string]: unknown;
}

// ============================================================================
// Index Types
// ============================================================================

/** Bitmap index for low/medium cardinality columns */
export interface BitmapIndexConfig {
  type: "BITMAP";
  name: string;
  column: string;
  comment?: string;
}

/** GIN (inverted) index for full-text search */
export interface GinIndexConfig {
  type: "GIN";
  name: string;
  columns: string[];
  comment?: string;
}

/** Vector index type */
export type VectorIndexType = "HNSW" | "IVFPQ";

/** Vector index metric */
export type VectorIndexMetric = "L2_DISTANCE" | "COSINE_SIMILARITY";

/** Vector index for approximate nearest neighbor search */
export interface VectorIndexConfig {
  type: "VECTOR";
  name: string;
  column: string;
  indexType: VectorIndexType;
  metric: VectorIndexMetric;
  dimension: number;
  params?: {
    M?: number;
    efConstruction?: number;
    nlist?: number;
    nbits?: number;
    nprobe?: number;
  };
  comment?: string;
}

/** Union of all index config types */
export type IndexConfig = BitmapIndexConfig | GinIndexConfig | VectorIndexConfig;

// ============================================================================
// Index Builders
// ============================================================================

/** Create a bitmap index definition */
export function bitmapIndex(
  name: string,
  column: Column<any, any, any, any>,
  opts?: { comment?: string }
): BitmapIndexConfig {
  return {
    type: "BITMAP",
    name,
    column: column.name,
    ...opts,
  };
}

/** Create a GIN (inverted) index definition */
export function ginIndex(
  name: string,
  columns: Column<any, any, any, any>[],
  opts?: { comment?: string }
): GinIndexConfig {
  return {
    type: "GIN",
    name,
    columns: columns.map((c) => c.name),
    ...opts,
  };
}

/** Create a vector index definition */
export function vectorIndex(
  name: string,
  column: Column<any, any, any, any>,
  config: {
    indexType: VectorIndexType;
    metric: VectorIndexMetric;
    dimension: number;
    params?: VectorIndexConfig["params"];
    comment?: string;
  }
): VectorIndexConfig {
  return {
    type: "VECTOR",
    name,
    column: column.name,
    indexType: config.indexType,
    metric: config.metric,
    dimension: config.dimension,
    params: config.params,
    comment: config.comment,
  };
}

// ============================================================================
// Index SQL Generation
// ============================================================================

/** Generate CREATE INDEX SQL for an index config */
export function generateCreateIndexSQL(tableName: string, index: IndexConfig): string {
  const quotedTable = quoteIdentifier(tableName);

  switch (index.type) {
    case "BITMAP": {
      let sql = `CREATE INDEX ${quoteIdentifier(index.name)} ON ${quotedTable} (${quoteIdentifier(index.column)}) USING BITMAP`;
      if (index.comment) {
        sql += ` COMMENT '${escapeString(index.comment)}'`;
      }
      return sql;
    }
    case "GIN": {
      const cols = index.columns.map(quoteIdentifier).join(", ");
      let sql = `CREATE INDEX ${quoteIdentifier(index.name)} ON ${quotedTable} (${cols}) USING GIN`;
      if (index.comment) {
        sql += ` COMMENT '${escapeString(index.comment)}'`;
      }
      return sql;
    }
    case "VECTOR": {
      const props: string[] = [
        `"index_type" = "${index.indexType}"`,
        `"dim" = "${index.dimension}"`,
        `"metric_type" = "${index.metric}"`,
      ];

      if (index.params) {
        if (index.indexType === "HNSW") {
          if (index.params.M !== undefined) props.push(`"M" = "${index.params.M}"`);
          if (index.params.efConstruction !== undefined) props.push(`"efconstruction" = "${index.params.efConstruction}"`);
        } else if (index.indexType === "IVFPQ") {
          if (index.params.nlist !== undefined) props.push(`"nlist" = "${index.params.nlist}"`);
          if (index.params.nbits !== undefined) props.push(`"nbits" = "${index.params.nbits}"`);
        }
      }

      let sql = `CREATE INDEX ${quoteIdentifier(index.name)} ON ${quotedTable} (${quoteIdentifier(index.column)}) USING VECTOR (${props.join(", ")})`;
      if (index.comment) {
        sql += ` COMMENT '${escapeString(index.comment)}'`;
      }
      return sql;
    }
  }
}

/** Generate DROP INDEX SQL */
export function generateDropIndexSQL(tableName: string, indexName: string): string {
  return `DROP INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(tableName)}`;
}

// ============================================================================
// Table Config
// ============================================================================

export interface TableConfig {
  key?: KeyConfig;
  distribution?: DistributionConfig;
  partition?: PartitionConfig;
  properties?: TableProperties;
  indexes?: IndexConfig[];
}

// ============================================================================
// Table Definition
// ============================================================================

export interface Table<
  TName extends string,
  TColumns extends Columns,
> {
  readonly _type: "table";
  readonly name: TName;
  readonly columns: TColumns;
  readonly config: TableConfig;

  /** Inferred select type */
  readonly $inferSelect: InferSelectType<TColumns>;
  /** Inferred insert type */
  readonly $inferInsert: InferInsertType<TColumns>;
}

/** Create a reference to a column for use in queries */
export interface ColumnRef<T, TTableName extends string, TColName extends string> {
  readonly _type: T;
  readonly table: TTableName;
  readonly column: TColName;
  readonly fullName: string;
}

/** Property names on Table that must not be shadowed by column refs */
type TableBuiltinKeys = '_type' | 'columns' | 'config' | '$inferSelect' | '$inferInsert';

/** Table with column references for query building */
export type TableWithRefs<TName extends string, TColumns extends Columns> = Table<
  TName,
  TColumns
> & {
  /** Get the table name (use this instead of .name if there's a 'name' column) */
  getTableName(): TName;
} & {
  [K in keyof TColumns as K extends TableBuiltinKeys ? `$${K & string}` : K]: ColumnRef<
    TColumns[K]["_type"],
    TName,
    TColumns[K]["name"]
  >;
};

// ============================================================================
// Table Builder
// ============================================================================

class TableBuilder<TName extends string, TColumns extends Columns>
  implements Table<TName, TColumns>
{
  readonly _type = "table" as const;
  readonly $inferSelect!: InferSelectType<TColumns>;
  readonly $inferInsert!: InferInsertType<TColumns>;
  readonly _tableName: TName;

  constructor(
    readonly name: TName,
    readonly columns: TColumns,
    readonly config: TableConfig
  ) {
    this._tableName = name;
    // Create column references on the table object
    const BUILTIN_KEYS = new Set(["_type", "columns", "config", "$inferSelect", "$inferInsert"]);
    for (const [key, col] of Object.entries(columns)) {
      const ref = {
        _type: undefined as any,
        table: name,
        column: col.name,
        fullName: `${name}.${col.name}`,
        dataType: col.dataType,
        isNotNull: col.isNotNull,
        name: col.name,
      };
      if (BUILTIN_KEYS.has(key)) {
        // Conflicting name — only create $-prefixed alias to avoid shadowing table metadata
        (this as any)[`$${key}`] = ref;
      } else {
        (this as any)[key] = ref;
      }
    }
  }

  /** Get the table name (use this instead of .name if there's a 'name' column) */
  getTableName(): TName {
    return this._tableName;
  }
}

/**
 * Define a StarRocks table with type-safe columns and configuration.
 *
 * @example
 * ```typescript
 * const events = starrocksTable("events", {
 *   id: bigint("id").notNull(),
 *   name: varchar("name", { length: 255 }),
 *   createdAt: datetime("created_at"),
 * }, (table) => ({
 *   pk: primaryKey(table.id),
 *   distribution: hash(table.id, { buckets: 8 }),
 * }));
 * ```
 */
export function starrocksTable<
  TName extends string,
  TColumns extends Columns,
>(
  name: TName,
  columns: TColumns,
  config?: (
    table: { [K in keyof TColumns]: TColumns[K] }
  ) => TableConfig
): TableWithRefs<TName, TColumns> {
  const raw = config ? config(columns) : {};
  const tableConfig = normalizeTableConfig(raw as Record<string, unknown>);
  return new TableBuilder(name, columns, tableConfig) as TableWithRefs<
    TName,
    TColumns
  >;
}

const KEY_TYPES: ReadonlySet<string> = new Set(["PRIMARY", "DUPLICATE", "AGGREGATE", "UNIQUE"]);
const DIST_TYPES: ReadonlySet<string> = new Set(["HASH", "RANDOM"]);
const PART_TYPES: ReadonlySet<string> = new Set(["RANGE", "LIST", "EXPRESSION"]);
const INDEX_TYPES: ReadonlySet<string> = new Set(["BITMAP", "GIN", "VECTOR"]);

/**
 * Normalize a config callback result into the canonical TableConfig shape.
 * The callback can use any property names (e.g. `pk: primaryKey(...)`)
 * — this function finds KeyConfig, DistributionConfig, PartitionConfig,
 * and TableProperties by inspecting the value shapes.
 */
function normalizeTableConfig(raw: Record<string, unknown>): TableConfig {
  const result: TableConfig = {};

  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;

    // Check for KeyConfig: { type: "PRIMARY"|..., columns: [...] }
    if (
      "type" in v &&
      "columns" in v &&
      KEY_TYPES.has((v as { type: string }).type)
    ) {
      result.key = v as KeyConfig;
      continue;
    }

    // Check for DistributionConfig: { type: "HASH"|"RANDOM", buckets: n }
    if (
      "type" in v &&
      "buckets" in v &&
      DIST_TYPES.has((v as { type: string }).type)
    ) {
      result.distribution = v as DistributionConfig;
      continue;
    }

    // Check for PartitionConfig: { type: "RANGE"|"LIST"|"EXPRESSION" }
    if (
      "type" in v &&
      PART_TYPES.has((v as { type: string }).type)
    ) {
      result.partition = v as PartitionConfig;
      continue;
    }

    // Check for IndexConfig: { type: "BITMAP"|"GIN"|"VECTOR", name: string }
    if (
      "type" in v &&
      "name" in v &&
      INDEX_TYPES.has((v as { type: string }).type)
    ) {
      if (!result.indexes) result.indexes = [];
      result.indexes.push(v as IndexConfig);
      continue;
    }

    // Check for IndexConfig array
    if (Array.isArray(v) && v.length > 0 && v.every((item) =>
      typeof item === "object" && item !== null && "type" in item && "name" in item &&
      INDEX_TYPES.has((item as { type: string }).type)
    )) {
      result.indexes = [...(result.indexes ?? []), ...(v as IndexConfig[])];
      continue;
    }

    // Named properties pass through as-is (e.g. `properties: { replication_num: 1 }`)
    if (k === "properties") {
      result.properties = v as TableProperties;
    }
  }

  return result;
}

// ============================================================================
// SQL Generation
// ============================================================================

/**
 * Generate CREATE TABLE SQL from a table definition.
 * All identifiers (table names, column names) are properly quoted with backticks
 * to safely handle reserved words and special characters.
 */
export function generateCreateTableSQL<T extends Table<any, any>>(
  table: T
): string {
  const lines: string[] = [];
  const tableName = (table as any)._tableName ?? table.name;

  // Column definitions - quote all column names
  const columnDefs = (Object.values(table.columns) as Column<any, any, any, any>[]).map((col) => {
    let def = `  ${quoteIdentifier(col.name)} ${col.dataType}`;
    if (col.aggregateFunc) {
      def += ` ${col.aggregateFunc}`;
    }
    if (col.isNotNull) {
      def += " NOT NULL";
    }
    if (col.defaultValue !== undefined) {
      def += ` DEFAULT ${formatDefaultValue(col.defaultValue)}`;
    }
    return def;
  });

  // Quote table name
  lines.push(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (`);
  lines.push(columnDefs.join(",\n"));
  lines.push(")");

  // Key type - REQUIRED for all StarRocks tables
  if (!table.config.key) {
    throw new Error(
      `Table "${tableName}" has no key type defined. ` +
      `StarRocks requires a key type (PRIMARY, DUPLICATE, AGGREGATE, or UNIQUE). ` +
      `Add e.g. key: primaryKey(t.id) to the table config.`
    );
  }
  const keyType = table.config.key.type;
  const keyCols = table.config.key.columns.map(quoteIdentifier).join(", ");
  lines.push(`${keyType} KEY (${keyCols})`);

  // Partition - quote column names
  if (table.config.partition) {
    const p = table.config.partition;
    if (p.type === "RANGE") {
      if (p.interval) {
        lines.push(
          `PARTITION BY RANGE (${quoteIdentifier(p.column)}) ()`
        );
      } else if (p.partitions) {
        const partDefs = p.partitions
          .map((part) => {
            validatePartitionName(part.name);
            const lessThanVal =
              part.lessThan === "MAXVALUE"
                ? "MAXVALUE"
                : `"${escapeDoubleQuoted(String(part.lessThan))}"`;
            return `PARTITION ${part.name} VALUES LESS THAN (${lessThanVal})`;
          })
          .join(",\n  ");
        lines.push(`PARTITION BY RANGE (${quoteIdentifier(p.column)}) (\n  ${partDefs}\n)`);
      }
    } else if (p.type === "LIST") {
      const partDefs = Object.entries(p.partitions)
        .map(([name, values]) => {
          validatePartitionName(name);
          const escapedValues = (values as string[])
            .map((v) => `"${escapeDoubleQuoted(String(v))}"`)
            .join(", ");
          return `PARTITION ${name} VALUES IN (${escapedValues})`;
        })
        .join(",\n  ");
      lines.push(`PARTITION BY LIST (${quoteIdentifier(p.column)}) (\n  ${partDefs}\n)`);
    } else if (p.type === "EXPRESSION") {
      // Expression partitions are raw SQL - developer is responsible for safety
      // This is intentional as expressions can be complex SQL fragments
      lines.push(`PARTITION BY (${p.expression})`);
    }
  }

  // Distribution - quote column names
  if (table.config.distribution) {
    const d = table.config.distribution;
    if (d.type === "HASH") {
      const distCols = d.columns.map(quoteIdentifier).join(", ");
      lines.push(`DISTRIBUTED BY HASH(${distCols}) BUCKETS ${d.buckets}`);
    } else {
      lines.push(`DISTRIBUTED BY RANDOM BUCKETS ${d.buckets}`);
    }
  }

  // Properties
  if (table.config.properties) {
    const props = Object.entries(table.config.properties)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        if (typeof v === "object") {
          return `"${k}" = "${JSON.stringify(v)}"`;
        }
        return `"${k}" = "${v}"`;
      })
      .join(", ");
    if (props) {
      lines.push(`PROPERTIES (${props})`);
    }
  }

  return lines.join("\n");
}
