/**
 * StarRocks Window Functions
 *
 * Type-safe window function builders for analytic queries.
 */

import type { ColumnRef } from "./table";
import type { Expression } from "./expressions";
import type { AggregateExpression } from "./aggregates";
import type { OrderDirection } from "./query-builder";

// ============================================================================
// Window Expression Type
// ============================================================================

export interface WindowExpression<T> extends Expression<T> {
  readonly _isWindow: true;
}

// ============================================================================
// Window Frame
// ============================================================================

export type FrameBound =
  | { type: "UNBOUNDED_PRECEDING" }
  | { type: "PRECEDING"; offset: number }
  | { type: "CURRENT_ROW" }
  | { type: "FOLLOWING"; offset: number }
  | { type: "UNBOUNDED_FOLLOWING" };

export function unboundedPreceding(): FrameBound {
  return { type: "UNBOUNDED_PRECEDING" };
}

export function preceding(n: number): FrameBound {
  return { type: "PRECEDING", offset: n };
}

export function currentRow(): FrameBound {
  return { type: "CURRENT_ROW" };
}

export function following(n: number): FrameBound {
  return { type: "FOLLOWING", offset: n };
}

export function unboundedFollowing(): FrameBound {
  return { type: "UNBOUNDED_FOLLOWING" };
}

export interface WindowFrame {
  type: "ROWS" | "RANGE";
  start: FrameBound;
  end: FrameBound;
}

export function rows(start: FrameBound, end: FrameBound): WindowFrame {
  return { type: "ROWS", start, end };
}

export function range(start: FrameBound, end: FrameBound): WindowFrame {
  return { type: "RANGE", start, end };
}

// ============================================================================
// Window Specification
// ============================================================================

export interface WindowSpec {
  partitionBy?: string[];
  orderBy?: Array<{ column: string; direction: OrderDirection }>;
  frame?: WindowFrame;
}

/** PARTITION BY clause for window functions */
export function partitionBy(
  ...cols: Array<ColumnRef<any, any, any>>
): Partial<WindowSpec> {
  return { partitionBy: cols.map((c) => c.fullName) };
}

/** ORDER BY clause for window functions */
export function windowOrderBy(
  ...specs: Array<
    | ColumnRef<any, any, any>
    | { column: ColumnRef<any, any, any> | AggregateExpression<any>; direction: OrderDirection }
  >
): Partial<WindowSpec> {
  return {
    orderBy: specs.map((spec) => {
      if ("direction" in spec) {
        const col =
          "fullName" in spec.column ? spec.column.fullName : spec.column.sql;
        return { column: col, direction: spec.direction };
      }
      return { column: spec.fullName, direction: "ASC" as OrderDirection };
    }),
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

function frameBoundToSQL(bound: FrameBound): string {
  switch (bound.type) {
    case "UNBOUNDED_PRECEDING":
      return "UNBOUNDED PRECEDING";
    case "PRECEDING":
      return `${bound.offset} PRECEDING`;
    case "CURRENT_ROW":
      return "CURRENT ROW";
    case "FOLLOWING":
      return `${bound.offset} FOLLOWING`;
    case "UNBOUNDED_FOLLOWING":
      return "UNBOUNDED FOLLOWING";
  }
}

function buildOverClause(
  ...specs: Array<Partial<WindowSpec> | WindowFrame>
): string {
  const merged: WindowSpec = {};

  for (const spec of specs) {
    if ("type" in spec && (spec.type === "ROWS" || spec.type === "RANGE")) {
      // It's a WindowFrame
      merged.frame = spec as WindowFrame;
    } else {
      const ws = spec as Partial<WindowSpec>;
      if (ws.partitionBy) merged.partitionBy = ws.partitionBy;
      if (ws.orderBy) merged.orderBy = ws.orderBy;
      if (ws.frame) merged.frame = ws.frame;
    }
  }

  const parts: string[] = [];

  if (merged.partitionBy && merged.partitionBy.length > 0) {
    parts.push(`PARTITION BY ${merged.partitionBy.join(", ")}`);
  }

  if (merged.orderBy && merged.orderBy.length > 0) {
    const orderParts = merged.orderBy.map(
      (o) => `${o.column} ${o.direction}`
    );
    parts.push(`ORDER BY ${orderParts.join(", ")}`);
  }

  if (merged.frame) {
    const startSql = frameBoundToSQL(merged.frame.start);
    const endSql = frameBoundToSQL(merged.frame.end);
    parts.push(
      `${merged.frame.type} BETWEEN ${startSql} AND ${endSql}`
    );
  }

  return `OVER(${parts.join(" ")})`;
}

// ============================================================================
// Window Function Builder
// ============================================================================

export interface WindowFunctionBuilder<T> {
  over(
    ...specs: Array<Partial<WindowSpec> | WindowFrame>
  ): WindowExpression<T>;
}

function createWindowFunction<T>(
  fnSql: string,
  fnValues: unknown[] = []
): WindowFunctionBuilder<T> {
  return {
    over(
      ...specs: Array<Partial<WindowSpec> | WindowFrame>
    ): WindowExpression<T> {
      const overSql = buildOverClause(...specs);
      return {
        _type: undefined as unknown as T,
        _isWindow: true,
        sql: `${fnSql} ${overSql}`,
        values: fnValues,
      };
    },
  };
}

// ============================================================================
// Ranking Functions
// ============================================================================

/** ROW_NUMBER() — sequential row number within partition */
export function rowNumber(): WindowFunctionBuilder<number> {
  return createWindowFunction<number>("ROW_NUMBER()");
}

/** RANK() — rank with gaps for ties */
export function rank(): WindowFunctionBuilder<number> {
  return createWindowFunction<number>("RANK()");
}

/** DENSE_RANK() — rank without gaps for ties */
export function denseRank(): WindowFunctionBuilder<number> {
  return createWindowFunction<number>("DENSE_RANK()");
}

/** NTILE(n) — divide rows into n buckets */
export function ntile(buckets: number): WindowFunctionBuilder<number> {
  return createWindowFunction<number>(`NTILE(${buckets})`);
}

// ============================================================================
// Value Functions
// ============================================================================

function toColSql(
  col: ColumnRef<any, any, any> | Expression<any>
): { sql: string; values: unknown[] } {
  if ("fullName" in col) {
    return { sql: col.fullName, values: [] };
  }
  return { sql: col.sql, values: col.values };
}

/** LAG(col, offset, default) — access a previous row's value */
export function lag<T>(
  col: ColumnRef<T, any, any> | Expression<T>,
  offset?: number,
  defaultValue?: T
): WindowFunctionBuilder<T | null> {
  const c = toColSql(col);
  const args = [c.sql];
  const values = [...c.values];

  if (offset !== undefined) {
    args.push(String(offset));
  }
  if (defaultValue !== undefined) {
    args.push("?");
    values.push(defaultValue);
  }

  return createWindowFunction<T | null>(`LAG(${args.join(", ")})`, values);
}

/** LEAD(col, offset, default) — access a subsequent row's value */
export function lead<T>(
  col: ColumnRef<T, any, any> | Expression<T>,
  offset?: number,
  defaultValue?: T
): WindowFunctionBuilder<T | null> {
  const c = toColSql(col);
  const args = [c.sql];
  const values = [...c.values];

  if (offset !== undefined) {
    args.push(String(offset));
  }
  if (defaultValue !== undefined) {
    args.push("?");
    values.push(defaultValue);
  }

  return createWindowFunction<T | null>(`LEAD(${args.join(", ")})`, values);
}

/** FIRST_VALUE(col) — first value in the window frame */
export function firstValue<T>(
  col: ColumnRef<T, any, any> | Expression<T>
): WindowFunctionBuilder<T | null> {
  const c = toColSql(col);
  return createWindowFunction<T | null>(`FIRST_VALUE(${c.sql})`, c.values);
}

/** LAST_VALUE(col) — last value in the window frame */
export function lastValue<T>(
  col: ColumnRef<T, any, any> | Expression<T>
): WindowFunctionBuilder<T | null> {
  const c = toColSql(col);
  return createWindowFunction<T | null>(`LAST_VALUE(${c.sql})`, c.values);
}

// ============================================================================
// Aggregate-as-Window Helper
// ============================================================================

/**
 * Wraps an existing aggregate expression with OVER() to create a window expression.
 * Used internally by AggregateExpression.over().
 */
export function aggregateOver<T>(
  agg: AggregateExpression<T>,
  ...specs: Array<Partial<WindowSpec> | WindowFrame>
): WindowExpression<T> {
  const overSql = buildOverClause(...specs);
  // Use the raw aggregate SQL (without any alias)
  const baseSql = agg.alias ? agg.sql.replace(` AS ${agg.alias}`, "") : agg.sql;
  return {
    _type: undefined as unknown as T,
    _isWindow: true,
    sql: `${baseSql} ${overSql}`,
    values: [...agg.values],
  };
}
