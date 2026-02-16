/**
 * StarRocks Scalar Function Helpers
 *
 * Type-safe wrappers for common SQL scalar functions.
 */

import type { ColumnRef } from "./table";
import type { Expression } from "./expressions";

// ============================================================================
// Internal Helpers
// ============================================================================

type ExprArg<T = unknown> = ColumnRef<T, any, any> | Expression<T> | T;

function toSqlPart(val: unknown): { sql: string; values: unknown[] } {
  if (
    typeof val === "object" &&
    val !== null &&
    "sql" in val &&
    "values" in val
  ) {
    return { sql: (val as any).sql, values: (val as any).values };
  }
  if (
    typeof val === "object" &&
    val !== null &&
    "fullName" in val &&
    "table" in val
  ) {
    return { sql: (val as any).fullName, values: [] };
  }
  return { sql: "?", values: [val] };
}

function createFn<T>(name: string, ...args: unknown[]): Expression<T> {
  const parts: string[] = [];
  const values: unknown[] = [];

  for (const arg of args) {
    const p = toSqlPart(arg);
    parts.push(p.sql);
    values.push(...p.values);
  }

  return {
    _type: undefined as unknown as T,
    sql: `${name}(${parts.join(", ")})`,
    values,
  };
}

// ============================================================================
// String Functions
// ============================================================================

/** SUBSTRING(str, pos, len) */
export function substring(
  str: ExprArg<string>,
  pos: ExprArg<number>,
  len?: ExprArg<number>
): Expression<string> {
  if (len !== undefined) {
    return createFn<string>("SUBSTRING", str, pos, len);
  }
  return createFn<string>("SUBSTRING", str, pos);
}

/** UPPER(str) */
export function upper(str: ExprArg<string>): Expression<string> {
  return createFn<string>("UPPER", str);
}

/** LOWER(str) */
export function lower(str: ExprArg<string>): Expression<string> {
  return createFn<string>("LOWER", str);
}

/** CONCAT(str1, str2, ...) */
export function concat(...args: ExprArg<string>[]): Expression<string> {
  return createFn<string>("CONCAT", ...args);
}

/** TRIM(str) */
export function trim(str: ExprArg<string>): Expression<string> {
  return createFn<string>("TRIM", str);
}

/** LENGTH(str) */
export function length(str: ExprArg<string>): Expression<number> {
  return createFn<number>("LENGTH", str);
}

/** REPLACE(str, from, to) */
export function replace(
  str: ExprArg<string>,
  from: ExprArg<string>,
  to: ExprArg<string>
): Expression<string> {
  return createFn<string>("REPLACE", str, from, to);
}

// ============================================================================
// Date Functions
// ============================================================================

/** Interval units for date arithmetic */
export type IntervalUnit = "SECOND" | "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH" | "YEAR";

/** DATE_FORMAT(date, format) */
export function dateFormat(
  date: ExprArg<Date | string>,
  format: string
): Expression<string> {
  return createFn<string>("DATE_FORMAT", date, format);
}

/** DATE_ADD(date, INTERVAL n unit) */
export function dateAdd(
  date: ExprArg<Date | string>,
  interval: number,
  unit: IntervalUnit
): Expression<Date> {
  const datePart = toSqlPart(date);
  return {
    _type: undefined as unknown as Date,
    sql: `DATE_ADD(${datePart.sql}, INTERVAL ${interval} ${unit})`,
    values: datePart.values,
  };
}

/** DATE_SUB(date, INTERVAL n unit) */
export function dateSub(
  date: ExprArg<Date | string>,
  interval: number,
  unit: IntervalUnit
): Expression<Date> {
  const datePart = toSqlPart(date);
  return {
    _type: undefined as unknown as Date,
    sql: `DATE_SUB(${datePart.sql}, INTERVAL ${interval} ${unit})`,
    values: datePart.values,
  };
}

/** DATEDIFF(date1, date2) — returns difference in days */
export function datediff(
  date1: ExprArg<Date | string>,
  date2: ExprArg<Date | string>
): Expression<number> {
  return createFn<number>("DATEDIFF", date1, date2);
}

/** NOW() — current datetime */
export function now(): Expression<Date> {
  return {
    _type: undefined as unknown as Date,
    sql: "NOW()",
    values: [],
  };
}

/** CURDATE() — current date */
export function curdate(): Expression<Date> {
  return {
    _type: undefined as unknown as Date,
    sql: "CURDATE()",
    values: [],
  };
}

// ============================================================================
// Math Functions
// ============================================================================

/** ABS(n) */
export function abs(n: ExprArg<number>): Expression<number> {
  return createFn<number>("ABS", n);
}

/** CEIL(n) */
export function ceil(n: ExprArg<number>): Expression<number> {
  return createFn<number>("CEIL", n);
}

/** FLOOR(n) */
export function floor(n: ExprArg<number>): Expression<number> {
  return createFn<number>("FLOOR", n);
}

/** ROUND(n, decimals?) */
export function round(n: ExprArg<number>, decimals?: ExprArg<number>): Expression<number> {
  if (decimals !== undefined) {
    return createFn<number>("ROUND", n, decimals);
  }
  return createFn<number>("ROUND", n);
}

// ============================================================================
// Cast Function
// ============================================================================

/** Target types for CAST */
export type CastTarget =
  | "BOOLEAN"
  | "TINYINT"
  | "SMALLINT"
  | "INT"
  | "BIGINT"
  | "LARGEINT"
  | "FLOAT"
  | "DOUBLE"
  | "DECIMAL"
  | "VARCHAR"
  | "STRING"
  | "DATE"
  | "DATETIME"
  | "JSON";

/** Map from cast target string to TypeScript type */
export type CastResult<T extends CastTarget> =
  T extends "BOOLEAN" ? boolean :
  T extends "TINYINT" | "SMALLINT" | "INT" | "BIGINT" | "LARGEINT" | "FLOAT" | "DOUBLE" | "DECIMAL" ? number :
  T extends "VARCHAR" | "STRING" ? string :
  T extends "DATE" | "DATETIME" ? Date :
  T extends "JSON" ? unknown :
  unknown;

/** CAST(expr AS type) */
export function cast<T extends CastTarget>(
  expr: ExprArg,
  target: T
): Expression<CastResult<T>> {
  const exprPart = toSqlPart(expr);
  return {
    _type: undefined as unknown as CastResult<T>,
    sql: `CAST(${exprPart.sql} AS ${target})`,
    values: exprPart.values,
  };
}
