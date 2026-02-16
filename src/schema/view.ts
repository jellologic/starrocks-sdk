/**
 * StarRocks View Definitions
 *
 * Type-safe logical view builder with SQL generation.
 */

import type { Columns, InferSelectType } from "./columns";
import type { ColumnRef } from "./table";
import { QueryBuilder, type SelectedFields, type InferSelectedType } from "./query-builder";
import { quoteIdentifier } from "./sql-utils";

// ============================================================================
// Types
// ============================================================================

export type ViewSecurity = "NONE" | "INVOKER";

export interface ViewConfig {
  security?: ViewSecurity;
  comment?: string;
}

// ============================================================================
// View Definition
// ============================================================================

export interface View<
  TName extends string,
  TColumns extends Columns,
> {
  readonly _type: "view";
  readonly name: TName;
  readonly columns: TColumns;
  readonly config: ViewConfig;
  readonly query: { sql: string; values: unknown[] };

  /** Inferred select type */
  readonly $inferSelect: InferSelectType<TColumns>;
}

/** View with column references for query building */
export type ViewWithRefs<TName extends string, TColumns extends Columns> = View<
  TName,
  TColumns
> & {
  /** Get the view name */
  getViewName(): TName;
} & {
  [K in keyof TColumns]: ColumnRef<
    TColumns[K]["_type"],
    TName,
    TColumns[K]["name"]
  >;
};

// ============================================================================
// View Builder
// ============================================================================

class ViewBuilder<TName extends string, TColumns extends Columns = {}> {
  private _name: TName;
  private _columns: TColumns = {} as TColumns;
  private _config: ViewConfig = {};

  constructor(name: TName) {
    this._name = name;
  }

  /**
   * Define the columns of the view with their types.
   * Optional - if not specified, columns are inferred from the query.
   */
  columns<T extends Columns>(cols: T): ViewBuilder<TName, T> {
    const builder = new ViewBuilder<TName, T>(this._name);
    builder._columns = cols;
    builder._config = { ...this._config };
    return builder;
  }

  /**
   * Set the security mode (NONE or INVOKER)
   */
  security(mode: ViewSecurity): ViewBuilder<TName, TColumns> {
    this._config.security = mode;
    return this;
  }

  /**
   * Add a comment to the view
   */
  comment(text: string): ViewBuilder<TName, TColumns> {
    this._config.comment = text;
    return this;
  }

  /**
   * Define the view query using a query builder function
   */
  as<T extends SelectedFields>(
    queryFn: (qb: QueryBuilder<unknown>) => QueryBuilder<InferSelectedType<T>>
  ): ViewWithRefs<TName, TColumns> {
    const qb = new QueryBuilder();
    const query = queryFn(qb);
    const { sql, values } = query.toSQL();

    return new ViewImpl(
      this._name,
      this._columns,
      this._config,
      { sql, values }
    ) as unknown as ViewWithRefs<TName, TColumns>;
  }
}

// ============================================================================
// View Implementation
// ============================================================================

class ViewImpl<TName extends string, TColumns extends Columns>
  implements View<TName, TColumns>
{
  readonly _type = "view" as const;
  readonly $inferSelect!: InferSelectType<TColumns>;
  readonly _viewName: TName;

  constructor(
    readonly name: TName,
    readonly columns: TColumns,
    readonly config: ViewConfig,
    readonly query: { sql: string; values: unknown[] }
  ) {
    this._viewName = name;
    // Create column references on the view object
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

  /** Get the view name */
  getViewName(): TName {
    return this._viewName;
  }
}

// ============================================================================
// View Factory
// ============================================================================

/**
 * Create a type-safe view definition.
 *
 * @example
 * ```typescript
 * const recentEvents = createView("recent_events")
 *   .columns({
 *     id: bigint("id"),
 *     name: varchar("name", { length: 255 }),
 *   })
 *   .security("NONE")
 *   .comment("Events from the last 7 days")
 *   .as((qb) =>
 *     qb.select({ id: events.id, name: events.name })
 *       .from(events)
 *       .where(gt(events.createdAt, sql`NOW() - INTERVAL 7 DAY`))
 *   );
 * ```
 */
export function createView<TName extends string>(
  name: TName
): ViewBuilder<TName> {
  return new ViewBuilder(name);
}

// ============================================================================
// SQL Generation
// ============================================================================

/**
 * Generate CREATE VIEW SQL from a view definition.
 * All identifiers (view names, column names) are properly quoted with backticks.
 */
export function generateCreateViewSQL<T extends View<any, any>>(
  view: T
): string {
  const lines: string[] = [];
  const viewName = (view as any)._viewName ?? view.name;

  // Column list (optional) - quote column names
  const columnNames = Object.values(view.columns).map((col: any) => quoteIdentifier(col.name));
  const columnList = columnNames.length > 0 ? ` (${columnNames.join(", ")})` : "";

  // Quote view name
  lines.push(`CREATE VIEW ${quoteIdentifier(viewName)}${columnList}`);

  // Comment
  if (view.config.comment) {
    lines.push(`COMMENT '${view.config.comment.replace(/'/g, "''")}'`);
  }

  // Security
  if (view.config.security) {
    lines.push(`SECURITY ${view.config.security}`);
  }

  // Query
  lines.push("AS");
  lines.push(view.query.sql);

  return lines.join("\n");
}

/**
 * Generate DROP VIEW SQL
 */
export function generateDropViewSQL<T extends View<any, any>>(
  view: T,
  ifExists = true
): string {
  const viewName = (view as any)._viewName ?? view.name;
  return `DROP VIEW ${ifExists ? "IF EXISTS " : ""}${quoteIdentifier(viewName)}`;
}

/**
 * Generate CREATE OR REPLACE VIEW SQL from a view definition.
 * This is atomic - the view is replaced in a single operation without a window where it doesn't exist.
 */
export function generateReplaceViewSQL<T extends View<any, any>>(
  view: T
): string {
  const lines: string[] = [];
  const viewName = (view as any)._viewName ?? view.name;

  // Column list (optional) - quote column names
  const columnNames = Object.values(view.columns).map((col: any) => quoteIdentifier(col.name));
  const columnList = columnNames.length > 0 ? ` (${columnNames.join(", ")})` : "";

  // Quote view name
  lines.push(`CREATE OR REPLACE VIEW ${quoteIdentifier(viewName)}${columnList}`);

  // Comment
  if (view.config.comment) {
    lines.push(`COMMENT '${view.config.comment.replace(/'/g, "''")}'`);
  }

  // Security
  if (view.config.security) {
    lines.push(`SECURITY ${view.config.security}`);
  }

  // Query
  lines.push("AS");
  lines.push(view.query.sql);

  return lines.join("\n");
}
