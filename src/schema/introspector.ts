/**
 * StarRocks Schema Introspector
 *
 * Query the database to get current schema state.
 */

import type { Pool } from "mysql2/promise";

// ============================================================================
// Introspected Types
// ============================================================================

export interface IntrospectedColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  columnKey: string | null; // 'PRI', 'DUP', 'AGG', 'UNI'
  aggregateType: string | null;
  comment: string | null;
}

export interface IntrospectedIndex {
  name: string;
  type: "BITMAP" | "GIN" | "VECTOR";
  columns: string[];
  properties: Record<string, string>;
  comment: string | null;
}

export interface IntrospectedTable {
  name: string;
  type: "table";
  columns: IntrospectedColumn[];
  keyType: "PRIMARY" | "DUPLICATE" | "AGGREGATE" | "UNIQUE" | null;
  keyColumns: string[];
  distributionType: "HASH" | "RANDOM" | null;
  distributionColumns: string[];
  buckets: number | null;
  partitionType: "RANGE" | "LIST" | "EXPRESSION" | null;
  partitionColumn: string | null;
  properties: Record<string, string>;
  indexes: IntrospectedIndex[];
  comment: string | null;
}

export interface IntrospectedView {
  name: string;
  type: "view";
  columns: IntrospectedColumn[];
  definition: string;
  security: "NONE" | "INVOKER" | null;
  comment: string | null;
}

export interface IntrospectedMaterializedView {
  name: string;
  type: "materialized_view";
  columns: IntrospectedColumn[];
  definition: string;
  distributionType: "HASH" | "RANDOM" | null;
  distributionColumns: string[];
  buckets: number | null;
  partitionType: "RANGE" | "LIST" | "EXPRESSION" | null;
  partitionExpression: string | null;
  refreshType: "ASYNC" | "MANUAL" | null;
  refreshInterval: string | null;
  isActive: boolean;
  properties: Record<string, string>;
  comment: string | null;
}

export interface IntrospectedSchema {
  database: string;
  tables: IntrospectedTable[];
  views: IntrospectedView[];
  materializedViews: IntrospectedMaterializedView[];
}

// ============================================================================
// Introspector
// ============================================================================

export interface SchemaIntrospector {
  /**
   * Introspect the entire database schema
   */
  introspect(): Promise<IntrospectedSchema>;

  /**
   * Introspect a specific table
   */
  introspectTable(name: string): Promise<IntrospectedTable | null>;

  /**
   * Introspect a specific view
   */
  introspectView(name: string): Promise<IntrospectedView | null>;

  /**
   * Introspect a specific materialized view
   */
  introspectMaterializedView(name: string): Promise<IntrospectedMaterializedView | null>;
}

/**
 * Create a schema introspector for a StarRocks database
 */
export function createSchemaIntrospector(pool: Pool, database: string): SchemaIntrospector {
  return {
    async introspect(): Promise<IntrospectedSchema> {
      const [tables, views, materializedViews] = await Promise.all([
        introspectAllTables(pool, database),
        introspectAllViews(pool, database),
        introspectAllMaterializedViews(pool, database),
      ]);

      return {
        database,
        tables,
        views,
        materializedViews,
      };
    },

    async introspectTable(name: string): Promise<IntrospectedTable | null> {
      const tables = await introspectAllTables(pool, database, name);
      return tables[0] ?? null;
    },

    async introspectView(name: string): Promise<IntrospectedView | null> {
      const views = await introspectAllViews(pool, database, name);
      return views[0] ?? null;
    },

    async introspectMaterializedView(name: string): Promise<IntrospectedMaterializedView | null> {
      const mvs = await introspectAllMaterializedViews(pool, database, name);
      return mvs[0] ?? null;
    },
  };
}

// ============================================================================
// Table Introspection
// ============================================================================

async function introspectAllTables(
  pool: Pool,
  database: string,
  tableName?: string
): Promise<IntrospectedTable[]> {
  // Get table list
  let tableQuery = `
    SELECT
      TABLE_NAME,
      TABLE_COMMENT
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ?
      AND TABLE_TYPE = 'BASE TABLE'
  `;
  const tableParams: unknown[] = [database];

  if (tableName) {
    tableQuery += " AND TABLE_NAME = ?";
    tableParams.push(tableName);
  }

  const [tableRows] = await pool.query<any[]>(tableQuery, tableParams);

  const tables: IntrospectedTable[] = [];

  for (const tableRow of tableRows) {
    const name = tableRow.TABLE_NAME;

    // Get columns - use COLUMN_TYPE for full type with length/precision
    const [columnRows] = await pool.query<any[]>(`
      SELECT
        COLUMN_NAME,
        COLUMN_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        COLUMN_KEY,
        COLUMN_COMMENT
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [database, name]);

    const columns: IntrospectedColumn[] = columnRows.map((col) => ({
      name: col.COLUMN_NAME,
      dataType: col.COLUMN_TYPE, // Use COLUMN_TYPE for full type info (e.g., varchar(36), decimal(12,2))
      isNullable: col.IS_NULLABLE === "YES",
      defaultValue: col.COLUMN_DEFAULT,
      columnKey: col.COLUMN_KEY || null,
      aggregateType: null, // Would need to parse from column comment or extra
      comment: col.COLUMN_COMMENT || null,
    }));

    // Get table details using SHOW CREATE TABLE
    let keyType: IntrospectedTable["keyType"] = null;
    let keyColumns: string[] = [];
    let distributionType: IntrospectedTable["distributionType"] = null;
    let distributionColumns: string[] = [];
    let buckets: number | null = null;
    let partitionType: IntrospectedTable["partitionType"] = null;
    let partitionColumn: string | null = null;
    const properties: Record<string, string> = {};
    let createSql = "";

    try {
      const [createTableRows] = await pool.query<any[]>(`SHOW CREATE TABLE \`${database}\`.\`${name}\``);
      if (createTableRows.length > 0) {
        createSql = createTableRows[0]["Create Table"] || "";

        // Parse key type
        if (createSql.includes("PRIMARY KEY")) {
          keyType = "PRIMARY";
          keyColumns = parseKeyColumns(createSql, "PRIMARY KEY");
        } else if (createSql.includes("DUPLICATE KEY")) {
          keyType = "DUPLICATE";
          keyColumns = parseKeyColumns(createSql, "DUPLICATE KEY");
        } else if (createSql.includes("AGGREGATE KEY")) {
          keyType = "AGGREGATE";
          keyColumns = parseKeyColumns(createSql, "AGGREGATE KEY");
        } else if (createSql.includes("UNIQUE KEY")) {
          keyType = "UNIQUE";
          keyColumns = parseKeyColumns(createSql, "UNIQUE KEY");
        }

        // Parse distribution
        const hashMatch = createSql.match(/DISTRIBUTED BY HASH\s*\(([^)]+)\)\s*BUCKETS\s*(\d+)/i);
        if (hashMatch && hashMatch[1] && hashMatch[2]) {
          distributionType = "HASH";
          distributionColumns = hashMatch[1].split(",").map((c: string) => c.trim().replace(/`/g, ""));
          buckets = parseInt(hashMatch[2], 10);
        } else {
          const randomMatch = createSql.match(/DISTRIBUTED BY RANDOM\s*BUCKETS\s*(\d+)/i);
          if (randomMatch && randomMatch[1]) {
            distributionType = "RANDOM";
            buckets = parseInt(randomMatch[1], 10);
          }
        }

        // Parse partition
        const rangeMatch = createSql.match(/PARTITION BY RANGE\s*\(([^)]+)\)/i);
        if (rangeMatch) {
          partitionType = "RANGE";
          partitionColumn = rangeMatch[1]!.trim().replace(/`/g, "");
        } else {
          const listMatch = createSql.match(/PARTITION BY LIST\s*\(([^)]+)\)/i);
          if (listMatch) {
            partitionType = "LIST";
            partitionColumn = listMatch[1]!.trim().replace(/`/g, "");
          }
        }

        // Parse properties
        const propsMatch = createSql.match(/PROPERTIES\s*\(([\s\S]*?)\)/i);
        if (propsMatch) {
          const propsStr = propsMatch[1]!;
          const propMatches = propsStr.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g);
          for (const m of propMatches) {
            properties[m[1]!] = m[2]!;
          }
        }
      }
    } catch {
      // Ignore errors from SHOW CREATE TABLE
    }

    // Parse indexes from SHOW INDEX + fallback to SHOW CREATE TABLE for VECTOR params
    const indexes = await introspectTableIndexes(pool, database, name, createSql);

    tables.push({
      name,
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
      comment: tableRow.TABLE_COMMENT || null,
    });
  }

  return tables;
}

function parseKeyColumns(sql: string, keyType: string): string[] {
  const regex = new RegExp(`${keyType}\\s*\\(([^)]+)\\)`, "i");
  const match = sql.match(regex);
  if (match && match[1]) {
    return match[1].split(",").map((c: string) => c.trim().replace(/`/g, ""));
  }
  return [];
}

// ============================================================================
// Index Introspection
// ============================================================================

async function introspectTableIndexes(
  pool: Pool,
  database: string,
  tableName: string,
  createSql: string
): Promise<IntrospectedIndex[]> {
  const indexes: IntrospectedIndex[] = [];

  try {
    const [indexRows] = await pool.query<any[]>(`SHOW INDEX FROM \`${database}\`.\`${tableName}\``);

    // Group by index name (multi-column indexes have multiple rows)
    const indexMap = new Map<string, { columns: string[]; type: string; comment: string | null }>();

    for (const row of indexRows) {
      const indexName = row.Key_name || row.INDEX_NAME;
      const columnName = row.Column_name || row.COLUMN_NAME;
      const indexType = row.Index_type || row.INDEX_TYPE || "";
      const comment = row.Comment || row.COMMENT || null;

      // Skip the primary/key index entries
      if (!indexName || indexName === "PRIMARY" || !indexType) continue;

      const normalizedType = indexType.toUpperCase();
      // Only track BITMAP, GIN, and VECTOR indexes
      if (normalizedType !== "BITMAP" && normalizedType !== "GIN" && normalizedType !== "VECTOR") continue;

      if (!indexMap.has(indexName)) {
        indexMap.set(indexName, { columns: [], type: normalizedType, comment });
      }
      indexMap.get(indexName)!.columns.push(columnName);
    }

    for (const [indexName, info] of indexMap) {
      const properties: Record<string, string> = {};

      // For VECTOR indexes, parse properties from CREATE TABLE SQL
      if (info.type === "VECTOR" && createSql) {
        const vectorRegex = new RegExp(
          `INDEX\\s+\`?${indexName}\`?\\s+.*?USING\\s+VECTOR\\s*\\(([^)]+)\\)`,
          "i"
        );
        const match = createSql.match(vectorRegex);
        if (match?.[1]) {
          const propMatches = match[1].matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g);
          for (const m of propMatches) {
            if (m[1] !== undefined && m[2] !== undefined) {
              properties[m[1]] = m[2];
            }
          }
        }
      }

      indexes.push({
        name: indexName,
        type: info.type as IntrospectedIndex["type"],
        columns: info.columns,
        properties,
        comment: info.comment,
      });
    }
  } catch {
    // Ignore errors from SHOW INDEX
  }

  return indexes;
}

// ============================================================================
// View Introspection
// ============================================================================

async function introspectAllViews(
  pool: Pool,
  database: string,
  viewName?: string
): Promise<IntrospectedView[]> {
  let viewQuery = `
    SELECT
      TABLE_NAME,
      VIEW_DEFINITION
    FROM information_schema.VIEWS
    WHERE TABLE_SCHEMA = ?
  `;
  const viewParams: unknown[] = [database];

  if (viewName) {
    viewQuery += " AND TABLE_NAME = ?";
    viewParams.push(viewName);
  }

  const [viewRows] = await pool.query<any[]>(viewQuery, viewParams);

  const views: IntrospectedView[] = [];

  for (const viewRow of viewRows) {
    const name = viewRow.TABLE_NAME;

    // Get columns - use COLUMN_TYPE for full type with length/precision
    const [columnRows] = await pool.query<any[]>(`
      SELECT
        COLUMN_NAME,
        COLUMN_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        COLUMN_COMMENT
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [database, name]);

    const columns: IntrospectedColumn[] = columnRows.map((col) => ({
      name: col.COLUMN_NAME,
      dataType: col.COLUMN_TYPE, // Use COLUMN_TYPE for full type info
      isNullable: col.IS_NULLABLE === "YES",
      defaultValue: col.COLUMN_DEFAULT,
      columnKey: null,
      aggregateType: null,
      comment: col.COLUMN_COMMENT || null,
    }));

    views.push({
      name,
      type: "view",
      columns,
      definition: viewRow.VIEW_DEFINITION || "",
      security: null, // StarRocks doesn't expose this in info schema
      comment: null,
    });
  }

  return views;
}

// ============================================================================
// Materialized View Introspection
// ============================================================================

async function introspectAllMaterializedViews(
  pool: Pool,
  database: string,
  mvName?: string
): Promise<IntrospectedMaterializedView[]> {
  // StarRocks stores MVs in information_schema.materialized_views
  let mvQuery = `
    SELECT
      TABLE_NAME,
      TEXT as MV_DEFINITION,
      is_active,
      refresh_type
    FROM information_schema.materialized_views
    WHERE TABLE_SCHEMA = ?
  `;
  const mvParams: unknown[] = [database];

  if (mvName) {
    mvQuery += " AND TABLE_NAME = ?";
    mvParams.push(mvName);
  }

  let mvRows: any[] = [];
  try {
    const [rows] = await pool.query<any[]>(mvQuery, mvParams);
    mvRows = rows;
  } catch {
    // If materialized_views table doesn't exist or query fails, return empty
    return [];
  }

  const materializedViews: IntrospectedMaterializedView[] = [];

  for (const mvRow of mvRows) {
    const name = mvRow.TABLE_NAME;

    // Get columns - use COLUMN_TYPE for full type with length/precision
    const [columnRows] = await pool.query<any[]>(`
      SELECT
        COLUMN_NAME,
        COLUMN_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        COLUMN_COMMENT
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [database, name]);

    const columns: IntrospectedColumn[] = columnRows.map((col) => ({
      name: col.COLUMN_NAME,
      dataType: col.COLUMN_TYPE, // Use COLUMN_TYPE for full type info
      isNullable: col.IS_NULLABLE === "YES",
      defaultValue: col.COLUMN_DEFAULT,
      columnKey: null,
      aggregateType: null,
      comment: col.COLUMN_COMMENT || null,
    }));

    // Parse MV details from definition
    const definition = mvRow.MV_DEFINITION || "";
    let distributionType: IntrospectedMaterializedView["distributionType"] = null;
    let distributionColumns: string[] = [];
    let buckets: number | null = null;
    let partitionType: IntrospectedMaterializedView["partitionType"] = null;
    let partitionExpression: string | null = null;
    const properties: Record<string, string> = {};

    // Parse distribution
    const hashMatch = definition.match(/DISTRIBUTED BY HASH\s*\(([^)]+)\)\s*BUCKETS\s*(\d+)/i);
    if (hashMatch && hashMatch[1] && hashMatch[2]) {
      distributionType = "HASH";
      distributionColumns = hashMatch[1].split(",").map((c: string) => c.trim().replace(/`/g, ""));
      buckets = parseInt(hashMatch[2], 10);
    } else {
      const randomMatch = definition.match(/DISTRIBUTED BY RANDOM\s*BUCKETS\s*(\d+)/i);
      if (randomMatch && randomMatch[1]) {
        distributionType = "RANDOM";
        buckets = parseInt(randomMatch[1], 10);
      }
    }

    // Parse partition
    const partitionMatch = definition.match(/PARTITION BY\s*\(([^)]+)\)/i);
    if (partitionMatch) {
      partitionType = "EXPRESSION";
      partitionExpression = partitionMatch[1].trim();
    }

    // Parse properties
    const propsMatch = definition.match(/PROPERTIES\s*\(([\s\S]*?)\)/i);
    if (propsMatch) {
      const propsStr = propsMatch[1];
      const propMatches = propsStr.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g);
      for (const m of propMatches) {
        properties[m[1]] = m[2];
      }
    }

    materializedViews.push({
      name,
      type: "materialized_view",
      columns,
      definition,
      distributionType,
      distributionColumns,
      buckets,
      partitionType,
      partitionExpression,
      refreshType: (mvRow.refresh_type?.toUpperCase() as "ASYNC" | "MANUAL") || null,
      refreshInterval: null, // Would need to parse from definition
      isActive: mvRow.is_active === "true" || mvRow.is_active === 1,
      properties,
      comment: null,
    });
  }

  return materializedViews;
}
