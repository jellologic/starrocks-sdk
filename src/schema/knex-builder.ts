/**
 * Knex-Style Query Builder for StarRocks
 *
 * Provides a fluent, Knex-like API with strict TypeScript type safety.
 */

import type { Pool, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import type { TableConfig } from "./table";
import type { Columns, Column, InferSelectType, InferInsertType } from "./columns";

// ============================================================================
// Utility Types
// ============================================================================

/** Any table that has columns - more flexible than TableWithRefs */
type AnyTable = {
  readonly _type: "table";
  readonly name: string;
  readonly columns: Record<string, Column<any, any, any, any>>;
  readonly config: TableConfig;
  readonly _tableName?: string;
  getTableName?(): string;
};

/** Extract column keys (JavaScript property names) from a table's columns */
type ColumnKeys<T extends Record<string, Column<any, any, any, any>>> = keyof T & string;

/** Extract column type by JavaScript property key */
type ColumnTypeByKey<T extends Record<string, Column<any, any, any, any>>, K extends keyof T> =
  T[K] extends Column<infer Type, any, any, any> ? Type : never;

/** Comparison operators */
type ComparisonOperator = "=" | "!=" | "<>" | ">" | ">=" | "<" | "<=" | "like" | "ilike" | "not like";

/** Order direction */
type OrderDirection = "asc" | "desc" | "ASC" | "DESC";

/** Make properties optional for updates */
type PartialRecord<T> = { [K in keyof T]?: T[K] };

// ============================================================================
// Where Clause Types
// ============================================================================

interface WhereClause {
  type: "basic" | "in" | "notIn" | "between" | "null" | "notNull" | "raw" | "nested";
  boolean: "and" | "or";
  column?: string;
  operator?: string;
  value?: unknown;
  values?: unknown[];
  sql?: string;
  nested?: WhereClause[];
}

// ============================================================================
// Query Builder
// ============================================================================

export class KnexBuilder<
  TTable extends AnyTable,
  TResult = InferSelectType<TTable["columns"]>,
> {
  private _table: TTable;
  private _pool: Pool;
  private _selectColumns: string[] | "*" = "*";
  private _selectAliases: Map<string, string> = new Map();
  private _distinct: boolean = false;
  private _whereClauses: WhereClause[] = [];
  private _joins: Array<{
    type: "inner" | "left" | "right" | "full";
    table: string;
    tableRef: AnyTable;
    column1: string;
    operator: string;
    column2: string;
  }> = [];
  private _groupByColumns: string[] = [];
  private _havingClauses: WhereClause[] = [];
  private _orderBySpecs: Array<{ column: string; direction: OrderDirection }> = [];
  private _limitValue?: number;
  private _offsetValue?: number;

  constructor(table: TTable, pool: Pool) {
    this._table = table;
    this._pool = pool;
  }

  // ==========================================================================
  // SELECT Methods
  // ==========================================================================

  /**
   * Select specific columns
   * @example
   * .select('id', 'name')
   * .select(['id', 'name'])
   */
  select<K extends ColumnKeys<TTable["columns"]>>(
    ...columns: K[] | [K[]]
  ): KnexBuilder<TTable, Pick<InferSelectType<TTable["columns"]>, KeyOfColumnName<TTable["columns"], K>>> {
    const cols = Array.isArray(columns[0]) ? columns[0] : columns;
    this._selectColumns = cols as string[];
    return this as any;
  }

  /**
   * Select with alias
   * @example
   * .selectAs({ eventName: 'name', eventId: 'id' })
   */
  selectAs<TAlias extends Record<string, ColumnKeys<TTable["columns"]>>>(
    aliases: TAlias
  ): KnexBuilder<TTable, { [K in keyof TAlias]: ColumnTypeByKey<TTable["columns"], TAlias[K] & string> }> {
    this._selectColumns = Object.values(aliases) as string[];
    for (const [alias, col] of Object.entries(aliases)) {
      this._selectAliases.set(col as string, alias);
    }
    return this as any;
  }

  /**
   * Select all columns
   */
  selectAll(): KnexBuilder<TTable, InferSelectType<TTable["columns"]>> {
    this._selectColumns = "*";
    return this as any;
  }

  /**
   * Select distinct
   */
  distinct(): this {
    this._distinct = true;
    return this;
  }

  // ==========================================================================
  // WHERE Methods
  // ==========================================================================

  /**
   * Add a where clause
   * @example
   * .where('id', 1)
   * .where('price', '>', 100)
   * .where({ status: 'active', type: 'event' })
   */
  where<K extends ColumnKeys<TTable["columns"]>>(
    column: K,
    value: ColumnTypeByKey<TTable["columns"], K>
  ): this;
  where<K extends ColumnKeys<TTable["columns"]>>(
    column: K,
    operator: ComparisonOperator,
    value: ColumnTypeByKey<TTable["columns"], K>
  ): this;
  where(conditions: Partial<InferSelectType<TTable["columns"]>>): this;
  where(
    columnOrConditions: string | Record<string, unknown>,
    operatorOrValue?: unknown,
    value?: unknown
  ): this {
    if (typeof columnOrConditions === "object") {
      // Object syntax: .where({ col1: val1, col2: val2 })
      for (const [col, val] of Object.entries(columnOrConditions)) {
        this._whereClauses.push({
          type: "basic",
          boolean: "and",
          column: this.resolveColumnName(col),
          operator: "=",
          value: val,
        });
      }
    } else if (value !== undefined) {
      // Three args: .where('col', '>', value)
      this._whereClauses.push({
        type: "basic",
        boolean: "and",
        column: this.resolveColumnName(columnOrConditions),
        operator: operatorOrValue as string,
        value,
      });
    } else {
      // Two args: .where('col', value)
      this._whereClauses.push({
        type: "basic",
        boolean: "and",
        column: this.resolveColumnName(columnOrConditions),
        operator: "=",
        value: operatorOrValue,
      });
    }
    return this;
  }

  /**
   * Add an OR where clause
   */
  orWhere<K extends ColumnKeys<TTable["columns"]>>(
    column: K,
    value: ColumnTypeByKey<TTable["columns"], K>
  ): this;
  orWhere<K extends ColumnKeys<TTable["columns"]>>(
    column: K,
    operator: ComparisonOperator,
    value: ColumnTypeByKey<TTable["columns"], K>
  ): this;
  orWhere(conditions: Partial<InferSelectType<TTable["columns"]>>): this;
  orWhere(
    columnOrConditions: string | Record<string, unknown>,
    operatorOrValue?: unknown,
    value?: unknown
  ): this {
    if (typeof columnOrConditions === "object") {
      for (const [col, val] of Object.entries(columnOrConditions)) {
        this._whereClauses.push({
          type: "basic",
          boolean: "or",
          column: this.resolveColumnName(col),
          operator: "=",
          value: val,
        });
      }
    } else if (value !== undefined) {
      this._whereClauses.push({
        type: "basic",
        boolean: "or",
        column: this.resolveColumnName(columnOrConditions),
        operator: operatorOrValue as string,
        value,
      });
    } else {
      this._whereClauses.push({
        type: "basic",
        boolean: "or",
        column: this.resolveColumnName(columnOrConditions),
        operator: "=",
        value: operatorOrValue,
      });
    }
    return this;
  }

  /**
   * Where column is in array of values
   */
  whereIn<K extends ColumnKeys<TTable["columns"]>>(
    column: K,
    values: Array<ColumnTypeByKey<TTable["columns"], K>>
  ): this {
    this._whereClauses.push({
      type: "in",
      boolean: "and",
      column: this.resolveColumnName(column),
      values,
    });
    return this;
  }

  /**
   * Where column is not in array of values
   */
  whereNotIn<K extends ColumnKeys<TTable["columns"]>>(
    column: K,
    values: Array<ColumnTypeByKey<TTable["columns"], K>>
  ): this {
    this._whereClauses.push({
      type: "notIn",
      boolean: "and",
      column: this.resolveColumnName(column),
      values,
    });
    return this;
  }

  /**
   * Where column is between two values
   */
  whereBetween<K extends ColumnKeys<TTable["columns"]>>(
    column: K,
    range: [ColumnTypeByKey<TTable["columns"], K>, ColumnTypeByKey<TTable["columns"], K>]
  ): this {
    this._whereClauses.push({
      type: "between",
      boolean: "and",
      column: this.resolveColumnName(column),
      values: range,
    });
    return this;
  }

  /**
   * Where column is null
   */
  whereNull<K extends ColumnKeys<TTable["columns"]>>(column: K): this {
    this._whereClauses.push({
      type: "null",
      boolean: "and",
      column: this.resolveColumnName(column),
    });
    return this;
  }

  /**
   * Where column is not null
   */
  whereNotNull<K extends ColumnKeys<TTable["columns"]>>(column: K): this {
    this._whereClauses.push({
      type: "notNull",
      boolean: "and",
      column: this.resolveColumnName(column),
    });
    return this;
  }

  /**
   * Where with raw SQL
   */
  whereRaw(sql: string, bindings?: unknown[]): this {
    this._whereClauses.push({
      type: "raw",
      boolean: "and",
      sql,
      values: bindings,
    });
    return this;
  }

  /**
   * Or where with raw SQL
   */
  orWhereRaw(sql: string, bindings?: unknown[]): this {
    this._whereClauses.push({
      type: "raw",
      boolean: "or",
      sql,
      values: bindings,
    });
    return this;
  }

  // ==========================================================================
  // JOIN Methods
  // ==========================================================================

  /**
   * Inner join
   */
  join<T2 extends AnyTable>(
    table: T2,
    column1: ColumnKeys<TTable["columns"]> | ColumnKeys<T2["columns"]>,
    operator: "=" | "!=" | "<" | ">" | "<=" | ">=",
    column2: ColumnKeys<TTable["columns"]> | ColumnKeys<T2["columns"]>
  ): this;
  join<T2 extends AnyTable>(
    table: T2,
    column1: ColumnKeys<TTable["columns"]> | ColumnKeys<T2["columns"]>,
    column2: ColumnKeys<TTable["columns"]> | ColumnKeys<T2["columns"]>
  ): this;
  join<T2 extends AnyTable>(
    table: T2,
    column1: string,
    operatorOrColumn2: string,
    column2?: string
  ): this {
    const tableName = (table as any)._tableName ?? table.name;
    if (column2 !== undefined) {
      this._joins.push({
        type: "inner",
        table: tableName,
        tableRef: table,
        column1: this.resolveJoinColumn(column1, this._table),
        operator: operatorOrColumn2,
        column2: this.resolveJoinColumn(column2, table),
      });
    } else {
      this._joins.push({
        type: "inner",
        table: tableName,
        tableRef: table,
        column1: this.resolveJoinColumn(column1, this._table),
        operator: "=",
        column2: this.resolveJoinColumn(operatorOrColumn2, table),
      });
    }
    return this;
  }

  /**
   * Left join
   */
  leftJoin<T2 extends AnyTable>(
    table: T2,
    column1: string,
    operatorOrColumn2: string,
    column2?: string
  ): this {
    const tableName = (table as any)._tableName ?? table.name;
    if (column2 !== undefined) {
      this._joins.push({
        type: "left",
        table: tableName,
        tableRef: table,
        column1: this.resolveJoinColumn(column1, this._table),
        operator: operatorOrColumn2,
        column2: this.resolveJoinColumn(column2, table),
      });
    } else {
      this._joins.push({
        type: "left",
        table: tableName,
        tableRef: table,
        column1: this.resolveJoinColumn(column1, this._table),
        operator: "=",
        column2: this.resolveJoinColumn(operatorOrColumn2, table),
      });
    }
    return this;
  }

  /**
   * Right join
   */
  rightJoin<T2 extends AnyTable>(
    table: T2,
    column1: string,
    operatorOrColumn2: string,
    column2?: string
  ): this {
    const tableName = (table as any)._tableName ?? table.name;
    if (column2 !== undefined) {
      this._joins.push({
        type: "right",
        table: tableName,
        tableRef: table,
        column1: this.resolveJoinColumn(column1, this._table),
        operator: operatorOrColumn2,
        column2: this.resolveJoinColumn(column2, table),
      });
    } else {
      this._joins.push({
        type: "right",
        table: tableName,
        tableRef: table,
        column1: this.resolveJoinColumn(column1, this._table),
        operator: "=",
        column2: this.resolveJoinColumn(operatorOrColumn2, table),
      });
    }
    return this;
  }

  // ==========================================================================
  // GROUP BY & HAVING
  // ==========================================================================

  /**
   * Group by columns
   */
  groupBy<K extends ColumnKeys<TTable["columns"]>>(...columns: K[]): this {
    this._groupByColumns = columns.map((c) => this.resolveColumnName(c));
    return this;
  }

  /**
   * Having clause (for aggregates)
   */
  havingRaw(sql: string, bindings?: unknown[]): this {
    this._havingClauses.push({
      type: "raw",
      boolean: "and",
      sql,
      values: bindings,
    });
    return this;
  }

  // ==========================================================================
  // ORDER BY
  // ==========================================================================

  /**
   * Order by column
   * @example
   * .orderBy('created_at')
   * .orderBy('created_at', 'desc')
   * .orderBy([{ column: 'created_at', order: 'desc' }])
   */
  orderBy<K extends ColumnKeys<TTable["columns"]>>(
    column: K,
    direction?: OrderDirection
  ): this;
  orderBy(
    specs: Array<{ column: ColumnKeys<TTable["columns"]>; order?: OrderDirection }>
  ): this;
  orderBy(
    columnOrSpecs: string | Array<{ column: string; order?: OrderDirection }>,
    direction?: OrderDirection
  ): this {
    if (Array.isArray(columnOrSpecs)) {
      for (const spec of columnOrSpecs) {
        this._orderBySpecs.push({
          column: this.resolveColumnName(spec.column),
          direction: spec.order ?? "asc",
        });
      }
    } else {
      this._orderBySpecs.push({
        column: this.resolveColumnName(columnOrSpecs),
        direction: direction ?? "asc",
      });
    }
    return this;
  }

  /**
   * Order by descending (shorthand)
   */
  orderByDesc<K extends ColumnKeys<TTable["columns"]>>(column: K): this {
    return this.orderBy(column, "desc");
  }

  // ==========================================================================
  // LIMIT & OFFSET
  // ==========================================================================

  /**
   * Limit results
   */
  limit(n: number): this {
    this._limitValue = n;
    return this;
  }

  /**
   * Offset results
   */
  offset(n: number): this {
    this._offsetValue = n;
    return this;
  }

  // ==========================================================================
  // Execution Methods
  // ==========================================================================

  /**
   * Execute query and return all results
   */
  async execute(): Promise<TResult[]> {
    const { sql, values } = this.toSQL();
    const [rows] = await this._pool.query<RowDataPacket[]>(sql, values);
    return rows as TResult[];
  }

  /**
   * Alias for execute()
   */
  async then<TFulfilled = TResult[], TRejected = never>(
    onfulfilled?: ((value: TResult[]) => TFulfilled | PromiseLike<TFulfilled>) | null,
    onrejected?: ((reason: any) => TRejected | PromiseLike<TRejected>) | null
  ): Promise<TFulfilled | TRejected> {
    return this.execute().then(onfulfilled, onrejected);
  }

  /**
   * Get first result or null
   */
  async first(): Promise<TResult | null> {
    this._limitValue = 1;
    const results = await this.execute();
    return results[0] ?? null;
  }

  /**
   * Get first result or throw
   */
  async firstOrFail(): Promise<TResult> {
    const result = await this.first();
    if (result === null) {
      const tableName = (this._table as any)._tableName ?? this._table.name;
      throw new Error(`No results found in table '${tableName}'`);
    }
    return result;
  }

  /**
   * Get single column values as array
   */
  async pluck<K extends ColumnKeys<TTable["columns"]>>(
    column: K
  ): Promise<Array<ColumnTypeByKey<TTable["columns"], K>>> {
    this._selectColumns = [column];
    const results = await this.execute();
    return results.map((r: any) => r[column]);
  }

  /**
   * Count rows
   */
  async count(column: ColumnKeys<TTable["columns"]> | "*" = "*"): Promise<number> {
    const colName = column === "*" ? "*" : this.resolveColumnName(column);
    const { sql, values } = this.buildCountSQL(colName);
    const [rows] = await this._pool.query<RowDataPacket[]>(sql, values);
    return Number((rows[0] as any)?.count ?? 0);
  }

  /**
   * Check if any rows exist
   */
  async exists(): Promise<boolean> {
    const count = await this.count();
    return count > 0;
  }

  // ==========================================================================
  // INSERT Methods
  // ==========================================================================

  /**
   * Insert a single row
   */
  async insert(data: InferInsertType<TTable["columns"]>): Promise<ResultSetHeader> {
    const jsKeys = Object.keys(data);
    const dbColumns = jsKeys.map((k) => this.resolveColumnName(k));
    const values = Object.values(data);
    const placeholders = dbColumns.map(() => "?").join(", ");
    const tableName = (this._table as any)._tableName ?? this._table.name;

    const sql = `INSERT INTO ${tableName} (${dbColumns.join(", ")}) VALUES (${placeholders})`;
    const [result] = await this._pool.query<ResultSetHeader>(sql, values);
    return result;
  }

  /**
   * Insert multiple rows
   */
  async insertMany(data: Array<InferInsertType<TTable["columns"]>>): Promise<ResultSetHeader> {
    if (data.length === 0) {
      const tableName = (this._table as any)._tableName ?? this._table.name;
      throw new Error(`Cannot insert empty array into table '${tableName}'`);
    }

    const jsKeys = Object.keys(data[0] as Record<string, unknown>);
    const dbColumns = jsKeys.map((k) => this.resolveColumnName(k));
    const tableName = (this._table as any)._tableName ?? this._table.name;
    const placeholders = dbColumns.map(() => "?").join(", ");
    const allPlaceholders = data.map(() => `(${placeholders})`).join(", ");
    const allValues = data.flatMap((row) => jsKeys.map((col) => (row as any)[col]));

    const sql = `INSERT INTO ${tableName} (${dbColumns.join(", ")}) VALUES ${allPlaceholders}`;
    const [result] = await this._pool.query<ResultSetHeader>(sql, allValues);
    return result;
  }

  // ==========================================================================
  // UPDATE Methods
  // ==========================================================================

  /**
   * Update rows matching where clauses
   */
  async update(data: PartialRecord<InferSelectType<TTable["columns"]>>): Promise<ResultSetHeader> {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      const tableName = (this._table as any)._tableName ?? this._table.name;
      throw new Error(`No data to update in table '${tableName}'`);
    }

    const tableName = (this._table as any)._tableName ?? this._table.name;
    const setClauses = entries.map(([col]) => `${this.resolveColumnName(col)} = ?`).join(", ");
    const setValues = entries.map(([, v]) => v);

    const { whereSQL, whereValues } = this.buildWhereSQL();
    const whereClause = whereSQL ? ` ${whereSQL}` : "";
    const sql = `UPDATE ${tableName} SET ${setClauses}${whereClause}`;
    const [result] = await this._pool.query<ResultSetHeader>(sql, [...setValues, ...whereValues]);
    return result;
  }

  /**
   * Increment a column value
   */
  async increment<K extends ColumnKeys<TTable["columns"]>>(
    column: K,
    amount: number = 1
  ): Promise<ResultSetHeader> {
    const tableName = (this._table as any)._tableName ?? this._table.name;
    const colName = this.resolveColumnName(column);
    const { whereSQL, whereValues } = this.buildWhereSQL();
    const whereClause = whereSQL ? ` ${whereSQL}` : "";
    const sql = `UPDATE ${tableName} SET ${colName} = ${colName} + ?${whereClause}`;
    const [result] = await this._pool.query<ResultSetHeader>(sql, [amount, ...whereValues]);
    return result;
  }

  /**
   * Decrement a column value
   */
  async decrement<K extends ColumnKeys<TTable["columns"]>>(
    column: K,
    amount: number = 1
  ): Promise<ResultSetHeader> {
    return this.increment(column, -amount);
  }

  // ==========================================================================
  // DELETE Methods
  // ==========================================================================

  /**
   * Delete rows matching where clauses
   */
  async delete(): Promise<ResultSetHeader> {
    const tableName = (this._table as any)._tableName ?? this._table.name;
    const { whereSQL, whereValues } = this.buildWhereSQL();

    if (this._whereClauses.length === 0) {
      throw new Error(`Cannot delete from table '${tableName}' without where clause. Use truncate() for full table delete.`);
    }

    const whereClause = whereSQL ? ` ${whereSQL}` : "";
    const sql = `DELETE FROM ${tableName}${whereClause}`;
    const [result] = await this._pool.query<ResultSetHeader>(sql, whereValues);
    return result;
  }

  /**
   * Truncate the entire table
   */
  async truncate(): Promise<void> {
    const tableName = (this._table as any)._tableName ?? this._table.name;
    await this._pool.query(`TRUNCATE TABLE ${tableName}`);
  }

  // ==========================================================================
  // SQL Generation
  // ==========================================================================

  /**
   * Generate SQL and parameter values
   */
  toSQL(): { sql: string; values: unknown[] } {
    const parts: string[] = [];
    const values: unknown[] = [];
    const tableName = (this._table as any)._tableName ?? this._table.name;

    // SELECT
    const selectKeyword = this._distinct ? "SELECT DISTINCT" : "SELECT";
    if (this._selectColumns === "*") {
      parts.push(`${selectKeyword} *`);
    } else {
      const selectCols = this._selectColumns.map((col) => {
        const resolvedCol = this.resolveColumnName(col);
        const alias = this._selectAliases.get(col);
        return alias ? `${resolvedCol} AS ${alias}` : resolvedCol;
      });
      parts.push(`${selectKeyword} ${selectCols.join(", ")}`);
    }

    // FROM
    parts.push(`FROM ${tableName}`);

    // JOINs
    for (const join of this._joins) {
      const joinType = join.type.toUpperCase();
      parts.push(`${joinType} JOIN ${join.table} ON ${join.column1} ${join.operator} ${join.column2}`);
    }

    // WHERE
    const { whereSQL, whereValues } = this.buildWhereSQL();
    if (whereSQL) {
      parts.push(whereSQL.trim());
      values.push(...whereValues);
    }

    // GROUP BY
    if (this._groupByColumns.length > 0) {
      parts.push(`GROUP BY ${this._groupByColumns.join(", ")}`);
    }

    // HAVING
    if (this._havingClauses.length > 0) {
      const { sql: havingSQL, values: havingValues } = this.buildHavingSQL();
      parts.push(havingSQL);
      values.push(...havingValues);
    }

    // ORDER BY
    if (this._orderBySpecs.length > 0) {
      const orderParts = this._orderBySpecs.map(
        (o) => `${o.column} ${o.direction.toUpperCase()}`
      );
      parts.push(`ORDER BY ${orderParts.join(", ")}`);
    }

    // LIMIT
    if (this._limitValue !== undefined) {
      parts.push(`LIMIT ${this._limitValue}`);
    }

    // OFFSET
    if (this._offsetValue !== undefined) {
      parts.push(`OFFSET ${this._offsetValue}`);
    }

    return { sql: parts.join("\n"), values };
  }

  /**
   * Get the SQL string (for debugging)
   */
  toString(): string {
    return this.toSQL().sql;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private resolveColumnName(column: string): string {
    return this.resolveColumnFromTable(column, this._table);
  }

  private resolveColumnFromTable(column: string, table: AnyTable): string {
    // Check if column exists in table (as JS key) and get the actual DB column name
    const col = table.columns[column];
    if (col && typeof col === "object" && "name" in col) {
      return col.name;
    }
    // Check if it's already a DB column name
    for (const [, c] of Object.entries(table.columns)) {
      if ((c as any).name === column) {
        return column;
      }
    }
    return column;
  }

  private resolveJoinColumn(column: string, table: AnyTable): string {
    // If column already has table prefix, return as-is
    if (column.includes(".")) {
      return column;
    }
    const tableName = (table as any)._tableName ?? table.name;
    const resolvedCol = this.resolveColumnFromTable(column, table);
    return `${tableName}.${resolvedCol}`;
  }

  private buildWhereSQL(): { whereSQL: string; whereValues: unknown[] } {
    if (this._whereClauses.length === 0) {
      return { whereSQL: "", whereValues: [] };
    }

    const parts: string[] = [];
    const values: unknown[] = [];

    for (let i = 0; i < this._whereClauses.length; i++) {
      const clause = this._whereClauses[i] as WhereClause;
      const boolean = i === 0 ? "WHERE" : clause.boolean.toUpperCase();

      switch (clause.type) {
        case "basic":
          parts.push(`${boolean} ${clause.column} ${clause.operator} ?`);
          values.push(clause.value);
          break;
        case "in":
          const inPlaceholders = (clause.values ?? []).map(() => "?").join(", ");
          parts.push(`${boolean} ${clause.column} IN (${inPlaceholders})`);
          values.push(...(clause.values ?? []));
          break;
        case "notIn":
          const notInPlaceholders = (clause.values ?? []).map(() => "?").join(", ");
          parts.push(`${boolean} ${clause.column} NOT IN (${notInPlaceholders})`);
          values.push(...(clause.values ?? []));
          break;
        case "between":
          parts.push(`${boolean} ${clause.column} BETWEEN ? AND ?`);
          values.push(...(clause.values ?? []));
          break;
        case "null":
          parts.push(`${boolean} ${clause.column} IS NULL`);
          break;
        case "notNull":
          parts.push(`${boolean} ${clause.column} IS NOT NULL`);
          break;
        case "raw":
          parts.push(`${boolean} ${clause.sql}`);
          if (clause.values) values.push(...clause.values);
          break;
      }
    }

    return { whereSQL: parts.join(" "), whereValues: values };
  }

  private buildHavingSQL(): { sql: string; values: unknown[] } {
    const parts: string[] = [];
    const values: unknown[] = [];

    for (let i = 0; i < this._havingClauses.length; i++) {
      const clause = this._havingClauses[i] as WhereClause;
      const boolean = i === 0 ? "HAVING" : clause.boolean.toUpperCase();

      if (clause.type === "raw") {
        parts.push(`${boolean} ${clause.sql}`);
        if (clause.values) values.push(...clause.values);
      }
    }

    return { sql: parts.join(" "), values };
  }

  private buildCountSQL(column: string): { sql: string; values: unknown[] } {
    const tableName = (this._table as any)._tableName ?? this._table.name;
    const parts: string[] = [];
    const values: unknown[] = [];

    parts.push(`SELECT COUNT(${column}) AS count`);
    parts.push(`FROM ${tableName}`);

    // JOINs
    for (const join of this._joins) {
      const joinType = join.type.toUpperCase();
      parts.push(`${joinType} JOIN ${join.table} ON ${join.column1} ${join.operator} ${join.column2}`);
    }

    // WHERE
    const { whereSQL, whereValues } = this.buildWhereSQL();
    if (whereSQL) {
      parts.push(whereSQL.trim());
      values.push(...whereValues);
    }

    // GROUP BY
    if (this._groupByColumns.length > 0) {
      parts.push(`GROUP BY ${this._groupByColumns.join(", ")}`);
    }

    return { sql: parts.join("\n"), values };
  }
}

// Helper type to get the key name from column name
type KeyOfColumnName<T extends Columns, N extends string> = {
  [K in keyof T]: T[K] extends Column<any, N, any, any> ? K : never;
}[keyof T];

// ==========================================================================
// Database Interface
// ==========================================================================

export interface KnexDatabase {
  /**
   * Start a query on a table
   * @example
   * db(events).select('id', 'name').where('id', 1)
   */
  <T extends AnyTable>(
    table: T
  ): KnexBuilder<T, InferSelectType<T["columns"]>>;

  /**
   * Execute raw SQL
   */
  raw<T = unknown>(sql: string, bindings?: unknown[]): Promise<T[]>;

  /**
   * Execute a statement (no return value)
   */
  execute(sql: string, bindings?: unknown[]): Promise<void>;

  /**
   * Get the underlying pool
   */
  pool: Pool;
}

/**
 * Create a Knex-style database interface
 *
 * @example
 * ```typescript
 * const db = createKnexDatabase(pool);
 *
 * // Select
 * const events = await db(eventsTable)
 *   .select('id', 'name')
 *   .where('status', 'active')
 *   .orderBy('created_at', 'desc')
 *   .limit(10);
 *
 * // Insert
 * await db(eventsTable).insert({ name: 'Concert', price: 50 });
 *
 * // Update
 * await db(eventsTable).where('id', 1).update({ price: 75 });
 *
 * // Delete
 * await db(eventsTable).where('id', 1).delete();
 * ```
 */
export function createKnexDatabase(pool: Pool): KnexDatabase {
  const db = function <T extends AnyTable>(
    table: T
  ): KnexBuilder<T, InferSelectType<T["columns"]>> {
    return new KnexBuilder(table, pool);
  };

  db.raw = async <T = unknown>(sql: string, bindings?: unknown[]): Promise<T[]> => {
    const [rows] = await pool.query<RowDataPacket[]>(sql, bindings);
    return rows as T[];
  };

  db.execute = async (sql: string, bindings?: unknown[]): Promise<void> => {
    await pool.query(sql, bindings);
  };

  db.pool = pool;

  return db as KnexDatabase;
}
