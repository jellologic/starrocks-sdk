/**
 * StarRocks Expression Functions
 *
 * Type-safe expression builders for WHERE clauses, joins, etc.
 */

import type { ColumnRef } from "./table";

// ============================================================================
// Expression Types
// ============================================================================

export interface Expression<T = unknown> {
  readonly _type: T;
  readonly sql: string;
  readonly values: unknown[];
}

export interface BooleanExpression extends Expression<boolean> {}

// ============================================================================
// SQL Template Tag
// ============================================================================

/**
 * Tagged template literal for raw SQL expressions
 *
 * @example
 * ```typescript
 * sql`NOW() - INTERVAL 7 DAY`
 * sql`COALESCE(${col}, 0)`
 * ```
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Expression<unknown> {
  const sqlParts: string[] = [];
  const sqlValues: unknown[] = [];

  for (let i = 0; i < strings.length; i++) {
    sqlParts.push(strings[i] ?? "");
    if (i < values.length) {
      const val = values[i];
      if (isExpression(val)) {
        sqlParts.push(val.sql);
        sqlValues.push(...val.values);
      } else if (isColumnRef(val)) {
        sqlParts.push(val.fullName);
      } else {
        sqlParts.push("?");
        sqlValues.push(val);
      }
    }
  }

  return {
    _type: undefined as unknown,
    sql: sqlParts.join(""),
    values: sqlValues,
  };
}

// ============================================================================
// Type Guards
// ============================================================================

function isExpression(val: unknown): val is Expression {
  return (
    typeof val === "object" &&
    val !== null &&
    "sql" in val &&
    "values" in val
  );
}

function isColumnRef(val: unknown): val is ColumnRef<any, any, any> {
  return (
    typeof val === "object" &&
    val !== null &&
    "fullName" in val &&
    "table" in val &&
    "column" in val
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

function toSqlValue(val: unknown): { sql: string; values: unknown[] } {
  if (isExpression(val)) {
    return { sql: val.sql, values: val.values };
  }
  if (isColumnRef(val)) {
    return { sql: val.fullName, values: [] };
  }
  return { sql: "?", values: [val] };
}

function createBinaryExpression(
  left: unknown,
  operator: string,
  right: unknown
): BooleanExpression {
  const leftSql = toSqlValue(left);
  const rightSql = toSqlValue(right);

  return {
    _type: true as boolean,
    sql: `(${leftSql.sql} ${operator} ${rightSql.sql})`,
    values: [...leftSql.values, ...rightSql.values],
  };
}

// ============================================================================
// Comparison Operators
// ============================================================================

/** Equal: column = value */
export function eq<T>(
  column: ColumnRef<T, any, any> | Expression<T>,
  value: T | ColumnRef<T, any, any> | Expression<T>
): BooleanExpression {
  return createBinaryExpression(column, "=", value);
}

/** Not equal: column != value */
export function ne<T>(
  column: ColumnRef<T, any, any> | Expression<T>,
  value: T | ColumnRef<T, any, any> | Expression<T>
): BooleanExpression {
  return createBinaryExpression(column, "!=", value);
}

/** Greater than: column > value */
export function gt<T>(
  column: ColumnRef<T, any, any> | Expression<T>,
  value: T | ColumnRef<T, any, any> | Expression<T>
): BooleanExpression {
  return createBinaryExpression(column, ">", value);
}

/** Greater than or equal: column >= value */
export function gte<T>(
  column: ColumnRef<T, any, any> | Expression<T>,
  value: T | ColumnRef<T, any, any> | Expression<T>
): BooleanExpression {
  return createBinaryExpression(column, ">=", value);
}

/** Less than: column < value */
export function lt<T>(
  column: ColumnRef<T, any, any> | Expression<T>,
  value: T | ColumnRef<T, any, any> | Expression<T>
): BooleanExpression {
  return createBinaryExpression(column, "<", value);
}

/** Less than or equal: column <= value */
export function lte<T>(
  column: ColumnRef<T, any, any> | Expression<T>,
  value: T | ColumnRef<T, any, any> | Expression<T>
): BooleanExpression {
  return createBinaryExpression(column, "<=", value);
}

// ============================================================================
// Logical Operators
// ============================================================================

/** Logical AND */
export function and(
  ...conditions: BooleanExpression[]
): BooleanExpression {
  if (conditions.length === 0) {
    return { _type: true, sql: "TRUE", values: [] };
  }
  if (conditions.length === 1) {
    return conditions[0] as BooleanExpression;
  }

  const sql = conditions.map((c) => c.sql).join(" AND ");
  const values = conditions.flatMap((c) => c.values);

  return {
    _type: true as boolean,
    sql: `(${sql})`,
    values,
  };
}

/** Logical OR */
export function or(
  ...conditions: BooleanExpression[]
): BooleanExpression {
  if (conditions.length === 0) {
    return { _type: true, sql: "FALSE", values: [] };
  }
  if (conditions.length === 1) {
    return conditions[0] as BooleanExpression;
  }

  const sql = conditions.map((c) => c.sql).join(" OR ");
  const values = conditions.flatMap((c) => c.values);

  return {
    _type: true as boolean,
    sql: `(${sql})`,
    values,
  };
}

/** Logical NOT */
export function not(condition: BooleanExpression): BooleanExpression {
  return {
    _type: true as boolean,
    sql: `NOT (${condition.sql})`,
    values: condition.values,
  };
}

// ============================================================================
// IN / BETWEEN / LIKE
// ============================================================================

/** IN: column IN (value1, value2, ...) */
export function inArray<T>(
  column: ColumnRef<T, any, any>,
  values: T[]
): BooleanExpression {
  if (values.length === 0) {
    return { _type: true, sql: "FALSE", values: [] };
  }

  const placeholders = values.map(() => "?").join(", ");
  const colSql = toSqlValue(column);

  return {
    _type: true as boolean,
    sql: `(${colSql.sql} IN (${placeholders}))`,
    values: [...colSql.values, ...values],
  };
}

/** NOT IN: column NOT IN (value1, value2, ...) */
export function notInArray<T>(
  column: ColumnRef<T, any, any>,
  values: T[]
): BooleanExpression {
  if (values.length === 0) {
    return { _type: true, sql: "TRUE", values: [] };
  }

  const placeholders = values.map(() => "?").join(", ");
  const colSql = toSqlValue(column);

  return {
    _type: true as boolean,
    sql: `(${colSql.sql} NOT IN (${placeholders}))`,
    values: [...colSql.values, ...values],
  };
}

/** BETWEEN: column BETWEEN low AND high */
export function between<T>(
  column: ColumnRef<T, any, any>,
  low: T,
  high: T
): BooleanExpression {
  const colSql = toSqlValue(column);

  return {
    _type: true as boolean,
    sql: `(${colSql.sql} BETWEEN ? AND ?)`,
    values: [...colSql.values, low, high],
  };
}

/** LIKE: column LIKE pattern */
export function like(
  column: ColumnRef<string, any, any>,
  pattern: string
): BooleanExpression {
  const colSql = toSqlValue(column);

  return {
    _type: true as boolean,
    sql: `(${colSql.sql} LIKE ?)`,
    values: [...colSql.values, pattern],
  };
}

/** ILIKE: case-insensitive LIKE */
export function ilike(
  column: ColumnRef<string, any, any>,
  pattern: string
): BooleanExpression {
  const colSql = toSqlValue(column);

  return {
    _type: true as boolean,
    sql: `(LOWER(${colSql.sql}) LIKE LOWER(?))`,
    values: [...colSql.values, pattern],
  };
}

// ============================================================================
// NULL Checks
// ============================================================================

/** IS NULL */
export function isNull<T>(
  column: ColumnRef<T, any, any>
): BooleanExpression {
  const colSql = toSqlValue(column);

  return {
    _type: true as boolean,
    sql: `(${colSql.sql} IS NULL)`,
    values: colSql.values,
  };
}

/** IS NOT NULL */
export function isNotNull<T>(
  column: ColumnRef<T, any, any>
): BooleanExpression {
  const colSql = toSqlValue(column);

  return {
    _type: true as boolean,
    sql: `(${colSql.sql} IS NOT NULL)`,
    values: colSql.values,
  };
}

// ============================================================================
// CASE/WHEN Expressions
// ============================================================================

/** A when clause for use in CASE expressions */
export interface WhenClause<T> {
  readonly _whenType: "searched" | "simple";
  readonly condition: unknown;
  readonly result: T | ColumnRef<T, any, any> | Expression<T>;
}

/** Create a WHEN clause for searched CASE (condition → result) or simple CASE (value → result) */
export function when<T>(conditionOrValue: BooleanExpression | unknown, result: T | ColumnRef<T, any, any> | Expression<T>): WhenClause<T> {
  const isBoolean = isExpression(conditionOrValue) && !isColumnRef(conditionOrValue);
  return {
    _whenType: isBoolean ? "searched" : "simple",
    condition: conditionOrValue,
    result,
  };
}

/** Builder returned by caseWhen/caseExpr, usable as Expression<T> with optional .else() */
export interface CaseBuilder<T> extends Expression<T> {
  else<TElse>(value: TElse | ColumnRef<TElse, any, any> | Expression<TElse>): Expression<T | TElse>;
}

/**
 * Searched CASE expression: CASE WHEN cond THEN result ... END
 *
 * @example
 * ```typescript
 * caseWhen(when(gt(col, 100), "high"), when(gt(col, 50), "medium")).else("low")
 * ```
 */
export function caseWhen<T>(...whens: WhenClause<T>[]): CaseBuilder<T> {
  const sqlParts: string[] = ["CASE"];
  const values: unknown[] = [];

  for (const w of whens) {
    const condSql = toSqlValue(w.condition);
    const resultSql = toSqlValue(w.result);
    sqlParts.push(`WHEN ${condSql.sql} THEN ${resultSql.sql}`);
    values.push(...condSql.values, ...resultSql.values);
  }

  sqlParts.push("END");
  const baseSql = sqlParts.join(" ");

  return {
    _type: undefined as unknown as T,
    sql: baseSql,
    values,
    else<TElse>(value: TElse | ColumnRef<TElse, any, any> | Expression<TElse>): Expression<T | TElse> {
      const elseSql = toSqlValue(value);
      // Replace trailing END with ELSE ... END
      const withoutEnd = baseSql.slice(0, -3);
      return {
        _type: undefined as unknown as T | TElse,
        sql: `${withoutEnd}ELSE ${elseSql.sql} END`,
        values: [...values, ...elseSql.values],
      };
    },
  };
}

/**
 * Simple CASE expression: CASE expr WHEN value THEN result ... END
 *
 * @example
 * ```typescript
 * caseExpr(table.status, when("active", 1), when("inactive", 0)).else(-1)
 * ```
 */
export function caseExpr<T>(
  expr: ColumnRef<any, any, any> | Expression<any>,
  ...whens: WhenClause<T>[]
): CaseBuilder<T> {
  const exprSql = toSqlValue(expr);
  const sqlParts: string[] = [`CASE ${exprSql.sql}`];
  const values: unknown[] = [...exprSql.values];

  for (const w of whens) {
    const condSql = toSqlValue(w.condition);
    const resultSql = toSqlValue(w.result);
    sqlParts.push(`WHEN ${condSql.sql} THEN ${resultSql.sql}`);
    values.push(...condSql.values, ...resultSql.values);
  }

  sqlParts.push("END");
  const baseSql = sqlParts.join(" ");

  return {
    _type: undefined as unknown as T,
    sql: baseSql,
    values,
    else<TElse>(value: TElse | ColumnRef<TElse, any, any> | Expression<TElse>): Expression<T | TElse> {
      const elseSql = toSqlValue(value);
      const withoutEnd = baseSql.slice(0, -3);
      return {
        _type: undefined as unknown as T | TElse,
        sql: `${withoutEnd}ELSE ${elseSql.sql} END`,
        values: [...values, ...elseSql.values],
      };
    },
  };
}

// ============================================================================
// Conditional Functions
// ============================================================================

/**
 * IF(condition, trueValue, falseValue)
 *
 * @example
 * ```typescript
 * ifExpr(gt(col, 0), "positive", "non-positive")
 * ```
 */
export function ifExpr<T>(
  condition: BooleanExpression,
  trueValue: T | ColumnRef<T, any, any> | Expression<T>,
  falseValue: T | ColumnRef<T, any, any> | Expression<T>
): Expression<T> {
  const condSql = toSqlValue(condition);
  const trueSql = toSqlValue(trueValue);
  const falseSql = toSqlValue(falseValue);

  return {
    _type: undefined as unknown as T,
    sql: `IF(${condSql.sql}, ${trueSql.sql}, ${falseSql.sql})`,
    values: [...condSql.values, ...trueSql.values, ...falseSql.values],
  };
}

/**
 * COALESCE(val1, val2, ...)
 *
 * @example
 * ```typescript
 * coalesce(col1, col2, 0)
 * ```
 */
export function coalesce<T>(
  ...args: Array<T | ColumnRef<T, any, any> | Expression<T>>
): Expression<T> {
  const parts: string[] = [];
  const values: unknown[] = [];

  for (const arg of args) {
    const s = toSqlValue(arg);
    parts.push(s.sql);
    values.push(...s.values);
  }

  return {
    _type: undefined as unknown as T,
    sql: `COALESCE(${parts.join(", ")})`,
    values,
  };
}

/**
 * IFNULL(expr, fallback) — returns fallback if expr is NULL
 *
 * @example
 * ```typescript
 * ifNull(col, 0)
 * ```
 */
export function ifNull<T>(
  expr: ColumnRef<T, any, any> | Expression<T>,
  fallback: T | ColumnRef<T, any, any> | Expression<T>
): Expression<T> {
  const exprSql = toSqlValue(expr);
  const fallbackSql = toSqlValue(fallback);

  return {
    _type: undefined as unknown as T,
    sql: `IFNULL(${exprSql.sql}, ${fallbackSql.sql})`,
    values: [...exprSql.values, ...fallbackSql.values],
  };
}

/**
 * NULLIF(expr1, expr2) — returns NULL if expr1 = expr2
 *
 * @example
 * ```typescript
 * nullIf(col, 0)
 * ```
 */
export function nullIf<T>(
  expr: ColumnRef<T, any, any> | Expression<T>,
  value: T | ColumnRef<T, any, any> | Expression<T>
): Expression<T> {
  const exprSql = toSqlValue(expr);
  const valueSql = toSqlValue(value);

  return {
    _type: undefined as unknown as T,
    sql: `NULLIF(${exprSql.sql}, ${valueSql.sql})`,
    values: [...exprSql.values, ...valueSql.values],
  };
}

// ============================================================================
// Subquery Expressions
// ============================================================================

/** Interface for objects that can produce SQL (avoids circular import with QueryBuilder) */
export interface SqlBuildable {
  toSQL(): { sql: string; values: unknown[] };
}

/** EXISTS (subquery) */
export function exists(subquery: SqlBuildable): BooleanExpression {
  const { sql: subSql, values } = subquery.toSQL();
  return {
    _type: true as boolean,
    sql: `EXISTS (${subSql})`,
    values,
  };
}

/** NOT EXISTS (subquery) */
export function notExists(subquery: SqlBuildable): BooleanExpression {
  const { sql: subSql, values } = subquery.toSQL();
  return {
    _type: true as boolean,
    sql: `NOT EXISTS (${subSql})`,
    values,
  };
}

/** column IN (subquery) */
export function inSubquery<T>(
  column: ColumnRef<T, any, any> | Expression<T>,
  subquery: SqlBuildable
): BooleanExpression {
  const colSql = toSqlValue(column);
  const { sql: subSql, values: subValues } = subquery.toSQL();
  return {
    _type: true as boolean,
    sql: `(${colSql.sql} IN (${subSql}))`,
    values: [...colSql.values, ...subValues],
  };
}

/** column NOT IN (subquery) */
export function notInSubquery<T>(
  column: ColumnRef<T, any, any> | Expression<T>,
  subquery: SqlBuildable
): BooleanExpression {
  const colSql = toSqlValue(column);
  const { sql: subSql, values: subValues } = subquery.toSQL();
  return {
    _type: true as boolean,
    sql: `(${colSql.sql} NOT IN (${subSql}))`,
    values: [...colSql.values, ...subValues],
  };
}
