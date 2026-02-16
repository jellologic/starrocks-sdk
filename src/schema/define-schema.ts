/**
 * StarRocks Schema Definition
 *
 * Collect tables, views, and materialized views into a unified schema.
 */

import type { Table, TableWithRefs } from "./table";
import type { View, ViewWithRefs } from "./view";
import type { MaterializedView, MaterializedViewWithRefs } from "./materialized-view";
import type { Columns } from "./columns";

// ============================================================================
// Types
// ============================================================================

export interface SchemaDefinition {
  tables: Record<string, TableWithRefs<string, Columns> | Table<string, Columns>>;
  views: Record<string, ViewWithRefs<string, Columns> | View<string, Columns>>;
  materializedViews: Record<string, MaterializedViewWithRefs<string, Columns> | MaterializedView<string, Columns>>;
}

export interface Schema {
  readonly _type: "schema";
  readonly tables: SchemaDefinition["tables"];
  readonly views: SchemaDefinition["views"];
  readonly materializedViews: SchemaDefinition["materializedViews"];

  /** Get all table names */
  getTableNames(): string[];

  /** Get all view names */
  getViewNames(): string[];

  /** Get all materialized view names */
  getMaterializedViewNames(): string[];

  /** Get a table by name */
  getTable(name: string): TableWithRefs<string, Columns> | Table<string, Columns> | undefined;

  /** Get a view by name */
  getView(name: string): ViewWithRefs<string, Columns> | View<string, Columns> | undefined;

  /** Get a materialized view by name */
  getMaterializedView(name: string): MaterializedViewWithRefs<string, Columns> | MaterializedView<string, Columns> | undefined;
}

// ============================================================================
// Schema Implementation
// ============================================================================

class SchemaImpl implements Schema {
  readonly _type = "schema" as const;

  constructor(
    readonly tables: SchemaDefinition["tables"],
    readonly views: SchemaDefinition["views"],
    readonly materializedViews: SchemaDefinition["materializedViews"]
  ) {}

  getTableNames(): string[] {
    return Object.values(this.tables).map((t) => this.getObjectName(t));
  }

  getViewNames(): string[] {
    return Object.values(this.views).map((v) => this.getObjectName(v));
  }

  getMaterializedViewNames(): string[] {
    return Object.values(this.materializedViews).map((mv) => this.getObjectName(mv));
  }

  getTable(name: string): TableWithRefs<string, Columns> | Table<string, Columns> | undefined {
    return Object.values(this.tables).find((t) => this.getObjectName(t) === name);
  }

  getView(name: string): ViewWithRefs<string, Columns> | View<string, Columns> | undefined {
    return Object.values(this.views).find((v) => this.getObjectName(v) === name);
  }

  getMaterializedView(name: string): MaterializedViewWithRefs<string, Columns> | MaterializedView<string, Columns> | undefined {
    return Object.values(this.materializedViews).find((mv) => this.getObjectName(mv) === name);
  }

  private getObjectName(obj: any): string {
    return obj._tableName ?? obj._viewName ?? obj._mvName ?? obj.name;
  }
}

// ============================================================================
// Schema Factory
// ============================================================================

/**
 * Define a schema containing tables, views, and materialized views.
 *
 * @example
 * ```typescript
 * import { events, venues, eventLogs } from "./tables";
 * import { recentEvents } from "./views";
 * import { eventsByVenue } from "./materialized-views";
 *
 * export const schema = defineSchema({
 *   tables: { events, venues, eventLogs },
 *   views: { recentEvents },
 *   materializedViews: { eventsByVenue },
 * });
 * ```
 */
export function defineSchema(definition: Partial<SchemaDefinition>): Schema {
  return new SchemaImpl(
    definition.tables ?? {},
    definition.views ?? {},
    definition.materializedViews ?? {}
  );
}
