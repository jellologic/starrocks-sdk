/**
 * StarRocks Aggregate Functions
 *
 * Type-safe aggregate function builders for GROUP BY queries.
 */

import type { ColumnRef } from "./table";
import type { Expression } from "./expressions";
import type { WindowExpression, WindowSpec, WindowFrame } from "./window";
import { aggregateOver } from "./window";
import { escapeString } from "./sql-utils";

// ============================================================================
// Aggregate Expression
// ============================================================================

export interface AggregateExpression<T> extends Expression<T> {
  readonly _isAggregate: true;
  readonly alias?: string;
  as(alias: string): AggregateExpression<T>;
  over(...specs: Array<Partial<WindowSpec> | WindowFrame>): WindowExpression<T>;
}

function createAggregate<T>(
  fn: string,
  column: ColumnRef<any, any, any> | Expression<any> | "*",
  resultType?: T
): AggregateExpression<T> {
  let colSql: string;
  let values: unknown[] = [];

  if (column === "*") {
    colSql = "*";
  } else if ("fullName" in column) {
    colSql = column.fullName;
  } else {
    colSql = (column as Expression<any>).sql;
    values = (column as Expression<any>).values;
  }

  const expr: AggregateExpression<T> = {
    _type: resultType as T,
    _isAggregate: true,
    sql: `${fn}(${colSql})`,
    values,
    alias: undefined,
    as(alias: string): AggregateExpression<T> {
      return {
        ...this,
        alias,
        sql: `${fn}(${colSql}) AS ${alias}`,
      };
    },
    over(...specs: Array<Partial<WindowSpec> | WindowFrame>): WindowExpression<T> {
      return aggregateOver(this, ...specs);
    },
  };

  return expr;
}

// ============================================================================
// Count Functions
// ============================================================================

/** COUNT(*) or COUNT(column) */
export function count(): AggregateExpression<number>;
export function count<T>(column: ColumnRef<T, any, any>): AggregateExpression<number>;
export function count<T>(column?: ColumnRef<T, any, any>): AggregateExpression<number> {
  return createAggregate("COUNT", column ?? "*", 0 as number);
}

/** COUNT(DISTINCT column) */
export function countDistinct<T>(
  column: ColumnRef<T, any, any>
): AggregateExpression<number> {
  const colSql = column.fullName;

  return {
    _type: 0 as number,
    _isAggregate: true,
    sql: `COUNT(DISTINCT ${colSql})`,
    values: [],
    alias: undefined,
    as(alias: string) {
      return {
        ...this,
        alias,
        sql: `COUNT(DISTINCT ${colSql}) AS ${alias}`,
      };
    },
    over(...specs: Array<Partial<WindowSpec> | WindowFrame>): WindowExpression<number> {
      return aggregateOver(this, ...specs);
    },
  };
}

// ============================================================================
// Sum / Avg
// ============================================================================

/** SUM(column) */
export function sum<T extends number | bigint>(
  column: ColumnRef<T, any, any>
): AggregateExpression<T> {
  return createAggregate("SUM", column);
}

/** AVG(column) */
export function avg<T extends number>(
  column: ColumnRef<T, any, any>
): AggregateExpression<number> {
  return createAggregate("AVG", column, 0 as number);
}

// ============================================================================
// Min / Max
// ============================================================================

/** MIN(column) */
export function min<T>(column: ColumnRef<T, any, any>): AggregateExpression<T> {
  return createAggregate("MIN", column);
}

/** MAX(column) */
export function max<T>(column: ColumnRef<T, any, any>): AggregateExpression<T> {
  return createAggregate("MAX", column);
}

// ============================================================================
// Statistical Functions
// ============================================================================

/** STDDEV(column) - Standard deviation */
export function stddev<T extends number>(
  column: ColumnRef<T, any, any>
): AggregateExpression<number> {
  return createAggregate("STDDEV", column, 0 as number);
}

/** VARIANCE(column) */
export function variance<T extends number>(
  column: ColumnRef<T, any, any>
): AggregateExpression<number> {
  return createAggregate("VARIANCE", column, 0 as number);
}

// ============================================================================
// StarRocks Specific
// ============================================================================

/** APPROX_COUNT_DISTINCT(column) - HyperLogLog approximate count */
export function approxCountDistinct<T>(
  column: ColumnRef<T, any, any>
): AggregateExpression<number> {
  return createAggregate("APPROX_COUNT_DISTINCT", column, 0 as number);
}

/** HLL_UNION_AGG(column) - HyperLogLog union */
export function hllUnionAgg(
  column: ColumnRef<unknown, any, any>
): AggregateExpression<unknown> {
  return createAggregate("HLL_UNION_AGG", column);
}

/** BITMAP_UNION(column) - Bitmap union */
export function bitmapUnion(
  column: ColumnRef<unknown, any, any>
): AggregateExpression<unknown> {
  return createAggregate("BITMAP_UNION", column);
}

/** BITMAP_COUNT(BITMAP_UNION(column)) - Count distinct using bitmap */
export function bitmapCount(
  column: ColumnRef<unknown, any, any>
): AggregateExpression<number> {
  const colSql = column.fullName;

  return {
    _type: 0 as number,
    _isAggregate: true,
    sql: `BITMAP_COUNT(BITMAP_UNION(${colSql}))`,
    values: [],
    alias: undefined,
    as(alias: string) {
      return {
        ...this,
        alias,
        sql: `BITMAP_COUNT(BITMAP_UNION(${colSql})) AS ${alias}`,
      };
    },
    over(...specs: Array<Partial<WindowSpec> | WindowFrame>): WindowExpression<number> {
      return aggregateOver(this, ...specs);
    },
  };
}

/** GROUP_CONCAT(column, separator) */
export function groupConcat(
  column: ColumnRef<string, any, any>,
  separator: string = ","
): AggregateExpression<string> {
  const colSql = column.fullName;
  const escapedSep = escapeString(separator);

  return {
    _type: "" as string,
    _isAggregate: true,
    sql: `GROUP_CONCAT(${colSql}, '${escapedSep}')`,
    values: [],
    alias: undefined,
    as(alias: string) {
      return {
        ...this,
        alias,
        sql: `GROUP_CONCAT(${colSql}, '${escapedSep}') AS ${alias}`,
      };
    },
    over(...specs: Array<Partial<WindowSpec> | WindowFrame>): WindowExpression<string> {
      return aggregateOver(this, ...specs);
    },
  };
}

/** ARRAY_AGG(column) - Collect values into array */
export function arrayAgg<T>(
  column: ColumnRef<T, any, any>
): AggregateExpression<T[]> {
  return createAggregate("ARRAY_AGG", column);
}
