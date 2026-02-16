/**
 * StarRocks Column Type Definitions
 *
 * Drizzle-style column definitions with full type inference.
 */

// ============================================================================
// Core Types
// ============================================================================

/** Aggregate functions for AGGREGATE KEY tables */
export type AggregateFunction =
  | "SUM"
  | "MAX"
  | "MIN"
  | "REPLACE"
  | "REPLACE_IF_NOT_NULL"
  | "HLL_UNION"
  | "BITMAP_UNION";

/** Column definition with phantom type for inference */
export interface Column<
  T,
  TName extends string = string,
  TNotNull extends boolean = false,
  TDefault extends boolean = false,
> {
  readonly _type: T;
  readonly _notNull: TNotNull;
  readonly _hasDefault: TDefault;
  readonly name: TName;
  readonly dataType: string;
  readonly isNotNull: boolean;
  readonly defaultValue?: T | string;
  readonly aggregateFunc?: AggregateFunction;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;

  /** Mark column as NOT NULL */
  notNull(): Column<T, TName, true, TDefault>;

  /** Set default value (also accepts SQL keywords like "CURRENT_TIMESTAMP") */
  default(value: T | string): Column<T, TName, TNotNull, true>;

  /** Set aggregate function (for AGGREGATE KEY tables) */
  aggregate(fn: AggregateFunction): Column<T, TName, TNotNull, TDefault>;
}

/** Infer the TypeScript type from a column */
export type InferColumnType<T extends Column<any, any, any, any>> =
  T["_notNull"] extends true ? T["_type"] : T["_type"] | null;

// ============================================================================
// Column Builder
// ============================================================================

class ColumnBuilder<
  T,
  TName extends string,
  TNotNull extends boolean = false,
  TDefault extends boolean = false,
> implements Column<T, TName, TNotNull, TDefault>
{
  readonly _type!: T;
  readonly _notNull!: TNotNull;
  readonly _hasDefault!: TDefault;

  constructor(
    readonly name: TName,
    readonly dataType: string,
    readonly isNotNull: boolean = false,
    readonly defaultValue?: T | string,
    readonly aggregateFunc?: AggregateFunction,
    readonly length?: number,
    readonly precision?: number,
    readonly scale?: number
  ) {}

  notNull(): Column<T, TName, true, TDefault> {
    return new ColumnBuilder<T, TName, true, TDefault>(
      this.name,
      this.dataType,
      true,
      this.defaultValue,
      this.aggregateFunc,
      this.length,
      this.precision,
      this.scale
    );
  }

  default(value: T | string): Column<T, TName, TNotNull, true> {
    return new ColumnBuilder<T, TName, TNotNull, true>(
      this.name,
      this.dataType,
      this.isNotNull,
      value,
      this.aggregateFunc,
      this.length,
      this.precision,
      this.scale
    );
  }

  aggregate(fn: AggregateFunction): Column<T, TName, TNotNull, TDefault> {
    return new ColumnBuilder<T, TName, TNotNull, TDefault>(
      this.name,
      this.dataType,
      this.isNotNull,
      this.defaultValue,
      fn,
      this.length,
      this.precision,
      this.scale
    );
  }
}

// ============================================================================
// Numeric Types
// ============================================================================

/** BIGINT column (-2^63 to 2^63-1) */
export function bigint<TName extends string>(name: TName): Column<bigint, TName> {
  return new ColumnBuilder<bigint, TName>(name, "BIGINT");
}

/** INT column (-2^31 to 2^31-1) */
export function int<TName extends string>(name: TName): Column<number, TName> {
  return new ColumnBuilder<number, TName>(name, "INT");
}

/** SMALLINT column (-2^15 to 2^15-1) */
export function smallint<TName extends string>(name: TName): Column<number, TName> {
  return new ColumnBuilder<number, TName>(name, "SMALLINT");
}

/** TINYINT column (-128 to 127) */
export function tinyint<TName extends string>(name: TName): Column<number, TName> {
  return new ColumnBuilder<number, TName>(name, "TINYINT");
}

/** LARGEINT column (-2^127 to 2^127-1) */
export function largeint<TName extends string>(name: TName): Column<bigint, TName> {
  return new ColumnBuilder<bigint, TName>(name, "LARGEINT");
}

/** DOUBLE column (8-byte floating point) */
export function double<TName extends string>(name: TName): Column<number, TName> {
  return new ColumnBuilder<number, TName>(name, "DOUBLE");
}

/** FLOAT column (4-byte floating point) */
export function float<TName extends string>(name: TName): Column<number, TName> {
  return new ColumnBuilder<number, TName>(name, "FLOAT");
}

/** DECIMAL column with precision and scale */
export function decimal<TName extends string>(
  name: TName,
  config: { precision: number; scale: number }
): Column<string, TName> {
  if (config.precision < 1 || config.precision > 38) {
    throw new Error(`DECIMAL precision must be 1-38, got ${config.precision}`);
  }
  if (config.scale < 0 || config.scale > config.precision) {
    throw new Error(`DECIMAL scale must be 0-${config.precision}, got ${config.scale}`);
  }
  return new ColumnBuilder<string, TName>(
    name,
    `DECIMAL(${config.precision}, ${config.scale})`,
    false,
    undefined,
    undefined,
    undefined,
    config.precision,
    config.scale
  );
}

// ============================================================================
// String Types
// ============================================================================

/** VARCHAR column with max length */
export function varchar<TName extends string>(
  name: TName,
  config: { length: number }
): Column<string, TName> {
  if (config.length < 1 || config.length > 1_048_576) {
    throw new Error(`VARCHAR length must be 1-1048576, got ${config.length}`);
  }
  return new ColumnBuilder<string, TName>(
    name,
    `VARCHAR(${config.length})`,
    false,
    undefined,
    undefined,
    config.length
  );
}

/** CHAR column with fixed length */
export function char<TName extends string>(
  name: TName,
  config: { length: number }
): Column<string, TName> {
  if (config.length < 1 || config.length > 255) {
    throw new Error(`CHAR length must be 1-255, got ${config.length}`);
  }
  return new ColumnBuilder<string, TName>(
    name,
    `CHAR(${config.length})`,
    false,
    undefined,
    undefined,
    config.length
  );
}

/** STRING column (alias for VARCHAR(65533)) */
export function string<TName extends string>(name: TName): Column<string, TName> {
  return new ColumnBuilder<string, TName>(name, "STRING");
}

// ============================================================================
// Date/Time Types
// ============================================================================

/** DATE column (YYYY-MM-DD) */
export function date<TName extends string>(name: TName): Column<Date, TName> {
  return new ColumnBuilder<Date, TName>(name, "DATE");
}

/** DATETIME column (YYYY-MM-DD HH:MM:SS) */
export function datetime<TName extends string>(name: TName): Column<Date, TName> {
  return new ColumnBuilder<Date, TName>(name, "DATETIME");
}

// ============================================================================
// Boolean Type
// ============================================================================

/** BOOLEAN column */
export function boolean<TName extends string>(name: TName): Column<boolean, TName> {
  return new ColumnBuilder<boolean, TName>(name, "BOOLEAN");
}

// ============================================================================
// JSON Type
// ============================================================================

/** JSON column */
export function json<TName extends string, T = unknown>(
  name: TName
): Column<T, TName> {
  return new ColumnBuilder<T, TName>(name, "JSON");
}

// ============================================================================
// Complex Types
// ============================================================================

/** ARRAY column */
export function array<TName extends string, TElement>(
  name: TName,
  elementType: Column<TElement, any>
): Column<TElement[], TName> {
  return new ColumnBuilder<TElement[], TName>(
    name,
    `ARRAY<${elementType.dataType}>`
  );
}

/** MAP column */
export function map<TName extends string, TKey, TValue>(
  name: TName,
  keyType: Column<TKey, any>,
  valueType: Column<TValue, any>
): Column<Map<TKey, TValue>, TName> {
  return new ColumnBuilder<Map<TKey, TValue>, TName>(
    name,
    `MAP<${keyType.dataType}, ${valueType.dataType}>`
  );
}

/** STRUCT column */
export function struct<TName extends string, TFields extends Record<string, Column<any, any>>>(
  name: TName,
  fields: TFields
): Column<{ [K in keyof TFields]: InferColumnType<TFields[K]> }, TName> {
  const fieldDefs = Object.entries(fields)
    .map(([fieldName, col]) => `${fieldName} ${col.dataType}`)
    .join(", ");
  return new ColumnBuilder<{ [K in keyof TFields]: InferColumnType<TFields[K]> }, TName>(
    name,
    `STRUCT<${fieldDefs}>`
  );
}

// ============================================================================
// Special Types
// ============================================================================

/** HLL (HyperLogLog) column for approximate count distinct */
export function hll<TName extends string>(name: TName): Column<unknown, TName> {
  return new ColumnBuilder<unknown, TName>(name, "HLL");
}

/** BITMAP column for bitmap operations */
export function bitmap<TName extends string>(name: TName): Column<unknown, TName> {
  return new ColumnBuilder<unknown, TName>(name, "BITMAP");
}

// ============================================================================
// Type Inference Helpers
// ============================================================================

/** Columns record type */
export type Columns = Record<string, Column<any, any, any, any>>;

/** Infer select type from columns */
export type InferSelectType<T extends Columns> = {
  [K in keyof T]: InferColumnType<T[K]>;
};

/** Infer insert type from columns (respects NOT NULL and defaults) */
export type InferInsertType<T extends Columns> = {
  [K in keyof T as T[K]["_notNull"] extends true
    ? T[K]["_hasDefault"] extends true
      ? never
      : K
    : never]: T[K]["_type"];
} & {
  [K in keyof T as T[K]["_notNull"] extends true
    ? T[K]["_hasDefault"] extends true
      ? K
      : never
    : K]?: T[K]["_type"] | null;
};
