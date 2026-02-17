/**
 * StarRocks Schema Snapshot
 *
 * Convert a Schema definition into an IntrospectedSchema purely from code,
 * without requiring a live database connection.
 */

import type { Schema } from "./define-schema";
import type {
  IntrospectedSchema,
  IntrospectedTable,
  IntrospectedView,
  IntrospectedMaterializedView,
  IntrospectedColumn,
  IntrospectedIndex,
} from "./introspector";
import type { Table, TableWithRefs, IndexConfig } from "./table";
import type { View, ViewWithRefs } from "./view";
import type { MaterializedView, MaterializedViewWithRefs } from "./materialized-view";
import type { Columns, Column } from "./columns";

/**
 * Convert a Schema object into an IntrospectedSchema by reading
 * table/view/MV definitions from code. This enables offline diffing
 * without a live database connection.
 */
export function schemaToIntrospected(
  schema: Schema,
  database: string
): IntrospectedSchema {
  const tables: IntrospectedTable[] = [];
  const views: IntrospectedView[] = [];
  const materializedViews: IntrospectedMaterializedView[] = [];

  for (const tableName of schema.getTableNames()) {
    const table = schema.getTable(tableName);
    if (table) {
      tables.push(tableToIntrospected(table));
    }
  }

  for (const viewName of schema.getViewNames()) {
    const view = schema.getView(viewName);
    if (view) {
      views.push(viewToIntrospected(view));
    }
  }

  for (const mvName of schema.getMaterializedViewNames()) {
    const mv = schema.getMaterializedView(mvName);
    if (mv) {
      materializedViews.push(materializedViewToIntrospected(mv));
    }
  }

  return {
    database,
    tables,
    views,
    materializedViews,
  };
}

function tableToIntrospected(
  table: TableWithRefs<string, Columns> | Table<string, Columns>
): IntrospectedTable {
  const tableName = (table as any)._tableName ?? table.name;
  const config = table.config;

  // Map columns
  const columns: IntrospectedColumn[] = Object.values(table.columns).map(
    (col: Column<any, any, any, any>) => {
      // Determine columnKey based on key config
      let columnKey: string | null = null;
      if (config.key) {
        const isKeyColumn = config.key.columns.includes(col.name);
        if (isKeyColumn) {
          switch (config.key.type) {
            case "PRIMARY":
              columnKey = "PRI";
              break;
            case "DUPLICATE":
              columnKey = "DUP";
              break;
            case "AGGREGATE":
              columnKey = "AGG";
              break;
            case "UNIQUE":
              columnKey = "UNI";
              break;
          }
        }
      }

      return {
        name: col.name,
        dataType: col.dataType,
        isNullable: !col.isNotNull,
        defaultValue: col.defaultValue !== undefined
          ? String(col.defaultValue)
          : null,
        columnKey,
        aggregateType: col.aggregateFunc ?? null,
        comment: null,
      };
    }
  );

  // Map key
  const keyType = config.key?.type ?? null;
  const keyColumns = config.key?.columns ?? [];

  // Map distribution
  let distributionType: IntrospectedTable["distributionType"] = null;
  let distributionColumns: string[] = [];
  let buckets: number | null = null;

  if (config.distribution) {
    distributionType = config.distribution.type;
    buckets = config.distribution.buckets ?? null;
    if (config.distribution.type === "HASH") {
      distributionColumns = config.distribution.columns;
    }
  }

  // Map partition
  let partitionType: IntrospectedTable["partitionType"] = null;
  let partitionColumn: string | null = null;

  if (config.partition) {
    partitionType = config.partition.type;
    if (config.partition.type === "RANGE" || config.partition.type === "LIST") {
      partitionColumn = config.partition.column;
    }
  }

  // Map properties (convert all values to strings)
  const properties: Record<string, string> = {};
  if (config.properties) {
    for (const [key, value] of Object.entries(config.properties)) {
      if (value !== undefined) {
        if (typeof value === "object") {
          properties[key] = JSON.stringify(value);
        } else {
          properties[key] = String(value);
        }
      }
    }
  }

  // Map indexes
  const indexes: IntrospectedIndex[] = indexConfigsToIntrospected(config.indexes);

  return {
    name: tableName,
    type: "table",
    columns,
    keyType,
    keyColumns,
    distributionType,
    distributionColumns,
    buckets,
    partitionType,
    partitionColumn,
    properties,
    indexes,
    comment: null,
  };
}

function indexConfigsToIntrospected(configs?: IndexConfig[]): IntrospectedIndex[] {
  if (!configs || configs.length === 0) return [];

  return configs.map((idx): IntrospectedIndex => {
    const properties: Record<string, string> = {};

    if (idx.type === "VECTOR") {
      properties["index_type"] = idx.indexType;
      properties["dim"] = String(idx.dimension);
      properties["metric_type"] = idx.metric;
      if (idx.params) {
        if (idx.params.M !== undefined) properties["M"] = String(idx.params.M);
        if (idx.params.efConstruction !== undefined) properties["efconstruction"] = String(idx.params.efConstruction);
        if (idx.params.nlist !== undefined) properties["nlist"] = String(idx.params.nlist);
        if (idx.params.nbits !== undefined) properties["nbits"] = String(idx.params.nbits);
      }
    }

    return {
      name: idx.name,
      type: idx.type === "GIN" ? "GIN" : idx.type,
      columns: idx.type === "GIN" ? idx.columns :
               idx.type === "BITMAP" ? [idx.column] :
               [idx.column],
      properties,
      comment: idx.comment ?? null,
    };
  });
}

function viewToIntrospected(
  view: ViewWithRefs<string, Columns> | View<string, Columns>
): IntrospectedView {
  const viewName = (view as any)._viewName ?? view.name;

  // Map columns
  const columns: IntrospectedColumn[] = Object.values(view.columns).map(
    (col: Column<any, any, any, any>) => ({
      name: col.name,
      dataType: col.dataType,
      isNullable: !col.isNotNull,
      defaultValue: col.defaultValue !== undefined
        ? String(col.defaultValue)
        : null,
      columnKey: null,
      aggregateType: null,
      comment: null,
    })
  );

  return {
    name: viewName,
    type: "view",
    columns,
    definition: view.query.sql,
    security: view.config.security ?? null,
    comment: view.config.comment ?? null,
  };
}

function materializedViewToIntrospected(
  mv: MaterializedViewWithRefs<string, Columns> | MaterializedView<string, Columns>
): IntrospectedMaterializedView {
  const mvName = (mv as any)._mvName ?? mv.name;

  // Map columns
  const columns: IntrospectedColumn[] = Object.values(mv.columns).map(
    (col: Column<any, any, any, any>) => ({
      name: col.name,
      dataType: col.dataType,
      isNullable: !col.isNotNull,
      defaultValue: col.defaultValue !== undefined
        ? String(col.defaultValue)
        : null,
      columnKey: null,
      aggregateType: null,
      comment: null,
    })
  );

  // Map distribution
  let distributionType: IntrospectedMaterializedView["distributionType"] = null;
  let distributionColumns: string[] = [];
  let buckets: number | null = null;

  if (mv.config.distribution) {
    distributionType = mv.config.distribution.type;
    buckets = mv.config.distribution.buckets ?? null;
    if (mv.config.distribution.type === "HASH") {
      distributionColumns = mv.config.distribution.columns;
    }
  }

  // Map partition
  let partitionType: IntrospectedMaterializedView["partitionType"] = null;
  let partitionExpression: string | null = null;

  if (mv.config.partition) {
    partitionType = mv.config.partition.type;
    if (mv.config.partition.type === "EXPRESSION") {
      partitionExpression = mv.config.partition.expression;
    } else if (mv.config.partition.type === "RANGE" || mv.config.partition.type === "LIST") {
      partitionExpression = mv.config.partition.column;
    }
  }

  // Map properties
  const properties: Record<string, string> = {};
  if (mv.config.properties) {
    for (const [key, value] of Object.entries(mv.config.properties)) {
      if (value !== undefined) {
        if (typeof value === "object") {
          properties[key] = JSON.stringify(value);
        } else {
          properties[key] = String(value);
        }
      }
    }
  }

  return {
    name: mvName,
    type: "materialized_view",
    columns,
    definition: mv.query.sql,
    distributionType,
    distributionColumns,
    buckets,
    partitionType,
    partitionExpression,
    refreshType: mv.config.refresh?.type ?? null,
    refreshInterval: mv.config.refresh?.every
      ? `${mv.config.refresh.every.value} ${mv.config.refresh.every.unit}`
      : null,
    isActive: true,
    properties,
    comment: mv.config.comment ?? null,
  };
}

/**
 * Create an empty IntrospectedSchema (for first migration when no snapshot exists)
 */
export function emptyIntrospectedSchema(database: string): IntrospectedSchema {
  return {
    database,
    tables: [],
    views: [],
    materializedViews: [],
  };
}
