/**
 * StarRocks Query Builder
 *
 * Type-safe query builder with full SQL generation.
 */

import type { Pool } from "mysql2/promise";
import type { TableWithRefs, ColumnRef } from "./table";
import type { Columns, InferSelectType } from "./columns";
import type { BooleanExpression, Expression } from "./expressions";
import type { AggregateExpression } from "./aggregates";
import type { WindowExpression } from "./window";

// ============================================================================
// Types
// ============================================================================

/** Selected fields in a query */
export type SelectedFields = Record<
  string,
  ColumnRef<any, any, any> | AggregateExpression<any> | WindowExpression<any> | Expression<any>
>;

/** Set operation type */
export type SetOperationType = "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT";

/** CTE definition */
interface CTEDef {
  name: string;
  sql: string;
  values: unknown[];
}

/** Set operation definition */
interface SetOperationDef {
  type: SetOperationType;
  query: { sql: string; values: unknown[] };
}

/** Infer result type from selected fields */
export type InferSelectedType<T extends SelectedFields> = {
  [K in keyof T]: T[K] extends ColumnRef<infer U, any, any>
    ? U
    : T[K] extends AggregateExpression<infer U>
      ? U
      : T[K] extends Expression<infer U>
        ? U
        : unknown;
};

/** Order direction */
export type OrderDirection = "ASC" | "DESC";

/** Order by specification */
export interface OrderSpec {
  column: string;
  direction: OrderDirection;
}

/** Join type */
export type JoinType = "INNER" | "LEFT" | "RIGHT" | "FULL";

/** Join specification */
export interface JoinSpec {
  type: JoinType;
  table: string;
  on: BooleanExpression;
}

/** Subquery */
export interface Subquery<TAlias extends string, TResult> {
  readonly _type: "subquery";
  readonly alias: TAlias;
  readonly sql: string;
  readonly values: unknown[];
  readonly $inferSelect: TResult;
}

// ============================================================================
// Query Builder
// ============================================================================

export class QueryBuilder<TResult = unknown> {
  private _select: SelectedFields | "*" = "*";
  private _from?: string;
  private _fromSubquery?: { sql: string; values: unknown[]; alias: string };
  private _joins: JoinSpec[] = [];
  private _where?: BooleanExpression;
  private _groupBy: string[] = [];
  private _having?: BooleanExpression;
  private _orderBy: OrderSpec[] = [];
  private _limit?: number;
  private _offset?: number;
  private _pool?: Pool;
  private _ctes: CTEDef[] = [];
  private _setOperations: SetOperationDef[] = [];
  private _distinct: boolean = false;

  constructor(pool?: Pool) {
    this._pool = pool;
  }

  /**
   * Select specific columns or expressions
   */
  select<T extends SelectedFields>(
    fields: T
  ): QueryBuilder<InferSelectedType<T>> {
    const qb = new QueryBuilder<InferSelectedType<T>>(this._pool);
    qb._select = fields;
    qb._from = this._from;
    qb._fromSubquery = this._fromSubquery;
    qb._joins = [...this._joins];
    qb._where = this._where;
    qb._groupBy = [...this._groupBy];
    qb._having = this._having;
    qb._orderBy = [...this._orderBy];
    qb._limit = this._limit;
    qb._offset = this._offset;
    qb._ctes = [...this._ctes];
    qb._setOperations = [...this._setOperations];
    qb._distinct = this._distinct;
    return qb;
  }

  /**
   * Select all columns from the table
   */
  selectAll(): QueryBuilder<TResult> {
    const qb = new QueryBuilder<TResult>(this._pool);
    qb._select = "*";
    qb._from = this._from;
    qb._fromSubquery = this._fromSubquery;
    qb._joins = [...this._joins];
    qb._where = this._where;
    qb._groupBy = [...this._groupBy];
    qb._having = this._having;
    qb._orderBy = [...this._orderBy];
    qb._limit = this._limit;
    qb._offset = this._offset;
    qb._ctes = [...this._ctes];
    qb._setOperations = [...this._setOperations];
    qb._distinct = this._distinct;
    return qb;
  }

  /**
   * SELECT DISTINCT — remove duplicate rows from the result
   */
  distinct(): QueryBuilder<TResult> {
    const qb = this.clone();
    qb._distinct = true;
    return qb;
  }

  /**
   * Specify the table to select from
   */
  from<TName extends string, TColumns extends Columns>(
    table: TableWithRefs<TName, TColumns>
  ): QueryBuilder<InferSelectType<TColumns>>;
  from<TAlias extends string, TSubResult>(
    subquery: Subquery<TAlias, TSubResult>
  ): QueryBuilder<TSubResult>;
  from(source: any): QueryBuilder<any> {
    const qb = new QueryBuilder<any>(this._pool);
    qb._select = this._select;
    qb._joins = [...this._joins];
    qb._where = this._where;
    qb._groupBy = [...this._groupBy];
    qb._having = this._having;
    qb._orderBy = [...this._orderBy];
    qb._limit = this._limit;
    qb._offset = this._offset;
    qb._ctes = [...this._ctes];
    qb._setOperations = [...this._setOperations];
    qb._distinct = this._distinct;

    if (source._type === "subquery") {
      qb._fromSubquery = {
        sql: source.sql,
        values: source.values,
        alias: source.alias,
      };
    } else {
      // Use _tableName to avoid conflict with columns named "name"
      qb._from = source._tableName ?? source.name;
    }

    return qb;
  }

  /**
   * INNER JOIN
   */
  innerJoin<TName extends string, TColumns extends Columns>(
    table: TableWithRefs<TName, TColumns>,
    on: BooleanExpression
  ): QueryBuilder<TResult> {
    return this.join("INNER", table, on);
  }

  /**
   * LEFT JOIN
   */
  leftJoin<TName extends string, TColumns extends Columns>(
    table: TableWithRefs<TName, TColumns>,
    on: BooleanExpression
  ): QueryBuilder<TResult> {
    return this.join("LEFT", table, on);
  }

  /**
   * RIGHT JOIN
   */
  rightJoin<TName extends string, TColumns extends Columns>(
    table: TableWithRefs<TName, TColumns>,
    on: BooleanExpression
  ): QueryBuilder<TResult> {
    return this.join("RIGHT", table, on);
  }

  /**
   * FULL OUTER JOIN
   */
  fullJoin<TName extends string, TColumns extends Columns>(
    table: TableWithRefs<TName, TColumns>,
    on: BooleanExpression
  ): QueryBuilder<TResult> {
    return this.join("FULL", table, on);
  }

  private join<TName extends string, TColumns extends Columns>(
    type: JoinType,
    table: TableWithRefs<TName, TColumns>,
    on: BooleanExpression
  ): QueryBuilder<TResult> {
    const qb = this.clone();
    // Use _tableName to avoid conflict with columns named "name"
    const tableName = (table as any)._tableName ?? table.name;
    qb._joins.push({ type, table: tableName, on });
    return qb;
  }

  /**
   * WHERE clause
   */
  where(condition: BooleanExpression): QueryBuilder<TResult> {
    const qb = this.clone();
    qb._where = condition;
    return qb;
  }

  /**
   * GROUP BY
   */
  groupBy(
    ...columns: Array<ColumnRef<any, any, any> | Expression<unknown>>
  ): QueryBuilder<TResult> {
    const qb = this.clone();
    qb._groupBy = columns.map((c) => "fullName" in c ? c.fullName : c.sql);
    return qb;
  }

  /**
   * HAVING clause (for aggregates)
   */
  having(condition: BooleanExpression): QueryBuilder<TResult> {
    const qb = this.clone();
    qb._having = condition;
    return qb;
  }

  /**
   * ORDER BY
   */
  orderBy(
    ...specs: Array<
      | ColumnRef<any, any, any>
      | AggregateExpression<any>
      | Expression<unknown>
      | { column: ColumnRef<any, any, any> | AggregateExpression<any> | Expression<unknown>; direction: OrderDirection }
    >
  ): QueryBuilder<TResult> {
    const qb = this.clone();
    qb._orderBy = specs.map((spec) => {
      if ("direction" in spec) {
        const col = "fullName" in spec.column ? spec.column.fullName : spec.column.sql;
        return { column: col, direction: spec.direction };
      }
      const col = "fullName" in spec ? spec.fullName : spec.sql;
      return { column: col, direction: "ASC" as OrderDirection };
    });
    return qb;
  }

  /**
   * LIMIT
   */
  limit(n: number): QueryBuilder<TResult> {
    const qb = this.clone();
    qb._limit = n;
    return qb;
  }

  /**
   * OFFSET
   */
  offset(n: number): QueryBuilder<TResult> {
    const qb = this.clone();
    qb._offset = n;
    return qb;
  }

  // ==========================================================================
  // CTEs (WITH clause)
  // ==========================================================================

  /**
   * Add a CTE (Common Table Expression) via WITH clause
   *
   * @example
   * ```typescript
   * new QueryBuilder()
   *   .with("recent_sales", (qb) =>
   *     qb.from(sales).select({ total: sum(sales.amount) }).where(gt(sales.date, someDate))
   *   )
   *   .selectAll()
   *   .from(sql`recent_sales`)
   * ```
   */
  with(name: string, builder: (qb: QueryBuilder) => QueryBuilder<any>): QueryBuilder<TResult> {
    const qb = this.clone();
    const cteBuilder = builder(new QueryBuilder(this._pool));
    const { sql, values } = cteBuilder.toSQL();
    qb._ctes = [...this._ctes, { name, sql, values }];
    return qb;
  }

  // ==========================================================================
  // Set Operations (UNION / INTERSECT / EXCEPT)
  // ==========================================================================

  /** UNION (distinct) */
  union(other: QueryBuilder<any>): QueryBuilder<TResult> {
    const qb = this.clone();
    qb._setOperations = [...this._setOperations, { type: "UNION", query: other.toSQL() }];
    return qb;
  }

  /** UNION ALL */
  unionAll(other: QueryBuilder<any>): QueryBuilder<TResult> {
    const qb = this.clone();
    qb._setOperations = [...this._setOperations, { type: "UNION ALL", query: other.toSQL() }];
    return qb;
  }

  /** INTERSECT */
  intersect(other: QueryBuilder<any>): QueryBuilder<TResult> {
    const qb = this.clone();
    qb._setOperations = [...this._setOperations, { type: "INTERSECT", query: other.toSQL() }];
    return qb;
  }

  /** EXCEPT */
  except(other: QueryBuilder<any>): QueryBuilder<TResult> {
    const qb = this.clone();
    qb._setOperations = [...this._setOperations, { type: "EXCEPT", query: other.toSQL() }];
    return qb;
  }

  /**
   * Convert to subquery with alias
   */
  as<TAlias extends string>(alias: TAlias): Subquery<TAlias, TResult> {
    const { sql, values } = this.toSQL();
    return {
      _type: "subquery",
      alias,
      sql: `(${sql}) AS ${alias}`,
      values,
      $inferSelect: undefined as unknown as TResult,
    };
  }

  /**
   * Generate SQL and parameter values
   */
  toSQL(): { sql: string; values: unknown[] } {
    const parts: string[] = [];
    const values: unknown[] = [];

    // CTEs (WITH clause)
    if (this._ctes.length > 0) {
      const cteParts = this._ctes.map((cte) => `${cte.name} AS (\n${cte.sql}\n)`);
      parts.push(`WITH ${cteParts.join(",\n")}`);
      for (const cte of this._ctes) {
        values.push(...cte.values);
      }
    }

    // SELECT
    const selectKeyword = this._distinct ? "SELECT DISTINCT" : "SELECT";

    if (this._select === "*") {
      parts.push(`${selectKeyword} *`);
    } else {
      const selectParts: string[] = [];
      for (const [alias, field] of Object.entries(this._select)) {
        if ("fullName" in field) {
          // Column reference
          if (field.fullName.endsWith(`.${alias}`)) {
            selectParts.push(field.fullName);
          } else {
            selectParts.push(`${field.fullName} AS ${alias}`);
          }
        } else if ("_isAggregate" in field && field.alias) {
          // Aggregate with alias
          selectParts.push(field.sql);
          values.push(...field.values);
        } else if ("sql" in field) {
          // Expression (includes WindowExpression)
          selectParts.push(`${field.sql} AS ${alias}`);
          values.push(...field.values);
        }
      }
      parts.push(`${selectKeyword} ${selectParts.join(", ")}`);
    }

    // FROM
    if (this._fromSubquery) {
      parts.push(`FROM ${this._fromSubquery.sql}`);
      values.push(...this._fromSubquery.values);
    } else if (this._from) {
      parts.push(`FROM ${this._from}`);
    }

    // JOINs
    for (const join of this._joins) {
      parts.push(`${join.type} JOIN ${join.table} ON ${join.on.sql}`);
      values.push(...join.on.values);
    }

    // WHERE
    if (this._where) {
      parts.push(`WHERE ${this._where.sql}`);
      values.push(...this._where.values);
    }

    // GROUP BY
    if (this._groupBy.length > 0) {
      parts.push(`GROUP BY ${this._groupBy.join(", ")}`);
    }

    // HAVING
    if (this._having) {
      parts.push(`HAVING ${this._having.sql}`);
      values.push(...this._having.values);
    }

    // Set operations: append UNION/INTERSECT/EXCEPT before ORDER BY/LIMIT/OFFSET
    if (this._setOperations.length > 0) {
      for (const op of this._setOperations) {
        parts.push(op.type);
        parts.push(op.query.sql);
        values.push(...op.query.values);
      }
    }

    // ORDER BY (applies to combined result when set operations are present)
    if (this._orderBy.length > 0) {
      const orderParts = this._orderBy.map(
        (o) => `${o.column} ${o.direction}`
      );
      parts.push(`ORDER BY ${orderParts.join(", ")}`);
    }

    // LIMIT
    if (this._limit !== undefined) {
      parts.push(`LIMIT ${this._limit}`);
    }

    // OFFSET
    if (this._offset !== undefined) {
      parts.push(`OFFSET ${this._offset}`);
    }

    return {
      sql: parts.join("\n"),
      values,
    };
  }

  /**
   * Execute the query and return results
   */
  async execute(): Promise<TResult[]> {
    if (!this._pool) {
      throw new Error("No database connection. Use db.select() instead of new QueryBuilder()");
    }

    const { sql, values } = this.toSQL();
    const [rows] = await this._pool.query(sql, values);
    return rows as TResult[];
  }

  private clone(): QueryBuilder<TResult> {
    const qb = new QueryBuilder<TResult>(this._pool);
    qb._select = this._select;
    qb._from = this._from;
    qb._fromSubquery = this._fromSubquery;
    qb._joins = [...this._joins];
    qb._where = this._where;
    qb._groupBy = [...this._groupBy];
    qb._having = this._having;
    qb._orderBy = [...this._orderBy];
    qb._limit = this._limit;
    qb._offset = this._offset;
    qb._ctes = [...this._ctes];
    qb._setOperations = [...this._setOperations];
    qb._distinct = this._distinct;
    return qb;
  }
}

// ============================================================================
// Order By Helpers
// ============================================================================

/** Ascending order */
export function asc<T>(
  column: ColumnRef<T, any, any> | AggregateExpression<T> | Expression<T>
): { column: ColumnRef<T, any, any> | AggregateExpression<T> | Expression<T>; direction: OrderDirection } {
  return { column, direction: "ASC" };
}

/** Descending order */
export function desc<T>(
  column: ColumnRef<T, any, any> | AggregateExpression<T> | Expression<T>
): { column: ColumnRef<T, any, any> | AggregateExpression<T> | Expression<T>; direction: OrderDirection } {
  return { column, direction: "DESC" };
}

// ============================================================================
// Database Connection Wrapper
// ============================================================================

/**
 * Create a database query interface
 */
export function createQueryInterface(pool: Pool) {
  return {
    /**
     * Start a SELECT query
     */
    select<T extends SelectedFields>(fields: T): QueryBuilder<InferSelectedType<T>> {
      return new QueryBuilder(pool).select(fields);
    },

    /**
     * Select all columns (use with .from())
     */
    selectAll(): QueryBuilder<unknown> {
      return new QueryBuilder(pool).selectAll();
    },

    /**
     * Execute raw SQL
     */
    async raw<T = unknown>(sql: string, values?: unknown[]): Promise<T[]> {
      const [rows] = await pool.query(sql, values);
      return rows as T[];
    },

    /**
     * Execute a statement (INSERT, UPDATE, DELETE)
     */
    async execute(sql: string, values?: unknown[]): Promise<void> {
      await pool.query(sql, values);
    },
  };
}
