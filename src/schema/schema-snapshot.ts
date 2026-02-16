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
  IntrospectedColumn,
} from "./introspector";
import type { Table, TableWithRefs } from "./table";
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

  for (const tableName of schema.getTableNames()) {
    const table = schema.getTable(tableName);
    if (table) {
      tables.push(tableToIntrospected(table));
    }
  }

  // Views and MVs could be added here in the future
  return {
    database,
    tables,
    views: [],
    materializedViews: [],
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
    buckets = config.distribution.buckets;
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
    comment: null,
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
