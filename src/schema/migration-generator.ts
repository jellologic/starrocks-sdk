/**
 * StarRocks Migration Generator
 *
 * Generate migration SQL from schema diffs.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Schema } from "./define-schema";
import type { SchemaDiff, TableChange, ColumnChange, ViewChange, MaterializedViewChange, IndexChange } from "./differ";
import type { IntrospectedSchema } from "./introspector";
import { generateCreateTableSQL, generateCreateIndexSQL, generateDropIndexSQL } from "./table";
import { generateCreateViewSQL, generateDropViewSQL, generateReplaceViewSQL } from "./view";
import { generateCreateMaterializedViewSQL, generateDropMaterializedViewSQL, generateAlterRefreshSQL } from "./materialized-view";
import { formatDefaultValue } from "./sql-utils";
import type { Migration as ExecutableMigration, MigrationStep } from "../migrations";

// ============================================================================
// Migration Types
// ============================================================================

export interface MigrationStatement {
  sql: string;
  description: string;
  type: "create" | "drop" | "alter";
  object: "table" | "view" | "materialized_view" | "column" | "index";
  objectName: string;
}

export interface GeneratedMigrationPlan {
  name: string;
  timestamp: number;
  up: MigrationStatement[];
  down: MigrationStatement[];
}

/** @deprecated Use `GeneratedMigrationPlan` instead */
export type Migration = GeneratedMigrationPlan;

export interface GeneratedMigration {
  migration: GeneratedMigrationPlan;
  fileContent: string;
}

/**
 * Convert a GeneratedMigrationPlan into an executable Migration
 * compatible with MigrationRunner.runMigration().
 */
export function toExecutableMigration(
  plan: GeneratedMigrationPlan,
  options?: { id?: string; description?: string }
): ExecutableMigration {
  const id = options?.id ?? `${plan.timestamp}_${plan.name}`;
  const description = options?.description ?? plan.name;

  const up: MigrationStep[] = plan.up.map((stmt, i) => ({
    name: `step_${i + 1}`,
    description: stmt.description,
    sql: stmt.sql,
    idempotent: stmt.sql.toUpperCase().includes("IF EXISTS") || stmt.sql.toUpperCase().includes("IF NOT EXISTS"),
  }));

  const down: MigrationStep[] = plan.down.map((stmt, i) => ({
    name: `rollback_${i + 1}`,
    description: stmt.description,
    sql: stmt.sql,
    idempotent: true,
  }));

  return { id, description, up, down };
}

// ============================================================================
// Migration Generator
// ============================================================================

/**
 * Generate migration from schema diff
 */
export function generateMigration(
  schema: Schema,
  diff: SchemaDiff,
  introspected: IntrospectedSchema,
  options: {
    name?: string;
    timestamp?: number;
  } = {}
): GeneratedMigration {
  const timestamp = options.timestamp ?? Date.now();
  const name = options.name ?? `migration_${timestamp}`;

  const up: MigrationStatement[] = [];
  const down: MigrationStatement[] = [];

  // Process tables
  generateTableMigrations(schema, diff, introspected, up, down);

  // Process views (must come after tables due to dependencies)
  generateViewMigrations(schema, diff, up, down);

  // Process materialized views (must come after tables due to dependencies)
  generateMaterializedViewMigrations(schema, diff, up, down);

  const migration: GeneratedMigrationPlan = {
    name,
    timestamp,
    up,
    down,
  };

  return {
    migration,
    fileContent: generateMigrationFileContent(migration),
  };
}

// ============================================================================
// File Persistence
// ============================================================================

/**
 * Write a generated migration to disk.
 *
 * Creates the target directory if it doesn't exist and writes
 * `migration.fileContent` to `{dir}/{migration.migration.name}.ts`.
 *
 * @param dir  - Directory to write the migration file into.
 * @param migration - The `GeneratedMigration` returned by `generateMigration()`.
 * @returns The absolute path of the written file.
 */
export async function writeMigrationFile(
  dir: string,
  migration: GeneratedMigration
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filename = `${migration.migration.name}.ts`;
  const filePath = join(dir, filename);
  await writeFile(filePath, migration.fileContent, "utf-8");
  return filePath;
}

// ============================================================================
// Table Migrations
// ============================================================================

function generateTableMigrations(
  schema: Schema,
  diff: SchemaDiff,
  _introspected: IntrospectedSchema,
  up: MigrationStatement[],
  down: MigrationStatement[]
): void {
  // Create new tables
  for (const tableName of diff.tables.added) {
    const table = schema.getTable(tableName);
    if (table) {
      up.push({
        sql: generateCreateTableSQL(table as any),
        description: `Create table '${tableName}'`,
        type: "create",
        object: "table",
        objectName: tableName,
      });

      // Create indexes for new tables
      if (table.config.indexes) {
        for (const idx of table.config.indexes) {
          up.push({
            sql: generateCreateIndexSQL(tableName, idx),
            description: `Create ${idx.type} index '${idx.name}' on '${tableName}'`,
            type: "create",
            object: "index",
            objectName: `${tableName}.${idx.name}`,
          });
        }
      }

      down.push({
        sql: `DROP TABLE IF EXISTS ${tableName}`,
        description: `Drop table '${tableName}'`,
        type: "drop",
        object: "table",
        objectName: tableName,
      });
    }
  }

  // Drop removed tables
  for (const tableName of diff.tables.removed) {
    up.push({
      sql: `DROP TABLE IF EXISTS ${tableName}`,
      description: `Drop table '${tableName}'`,
      type: "drop",
      object: "table",
      objectName: tableName,
    });

    // For down, we can't recreate the table without the full definition
    // Just add a comment noting it was dropped
    down.push({
      sql: `-- Cannot auto-recreate dropped table '${tableName}'. Manual intervention required.`,
      description: `Recreate table '${tableName}' (manual)`,
      type: "create",
      object: "table",
      objectName: tableName,
    });
  }

  // Alter modified tables
  for (const change of diff.tables.modified) {
    generateTableAlterStatements(schema, change, up, down);
  }
}

function generateTableAlterStatements(
  schema: Schema,
  change: TableChange,
  up: MigrationStatement[],
  down: MigrationStatement[]
): void {
  const tableName = change.name;

  // Key type or distribution changes require full table recreation
  // StarRocks cannot ALTER these properties — must rename → create → copy → drop
  if (change.keyChange || change.distributionChange) {
    generateTableRecreateStatements(schema, change, up, down);
    return;
  }

  // Column changes (only when no recreation needed)
  if (change.columnChanges) {
    for (const colChange of change.columnChanges) {
      generateColumnAlterStatements(tableName, colChange, up, down);
    }
  }

  // Index changes
  if (change.indexChanges) {
    for (const indexChange of change.indexChanges) {
      generateIndexAlterStatements(tableName, indexChange, up, down);
    }
  }

  // Property changes (can be altered in-place)
  if (change.propertyChanges && change.propertyChanges.length > 0) {
    const table = schema.getTable(tableName);
    if (table && table.config.properties) {
      // Build property SET clause from the defined properties that changed
      const changedKeys = change.propertyChanges.map((c) => c.split(":")[0]!.trim());
      const setPairs: string[] = [];
      for (const key of changedKeys) {
        const value = table.config.properties[key];
        if (value !== undefined) {
          const strValue = typeof value === "object" ? JSON.stringify(value) : String(value);
          setPairs.push(`"${key}" = "${strValue}"`);
        }
      }
      if (setPairs.length > 0) {
        const escaped = isReservedWord(tableName) ? `\`${tableName}\`` : tableName;
        up.push({
          sql: `ALTER TABLE ${escaped} SET (${setPairs.join(", ")})`,
          description: `Set properties on '${tableName}': ${change.propertyChanges.join(", ")}`,
          type: "alter",
          object: "table",
          objectName: tableName,
        });

        down.push({
          sql: `-- Property changes on '${tableName}' cannot be auto-reverted. Manual intervention required.`,
          description: `Revert properties on '${tableName}'`,
          type: "alter",
          object: "table",
          objectName: tableName,
        });
      }
    }
  }
}

/**
 * Generate rename → create → INSERT SELECT → drop statements for table recreation.
 * Used when key type or distribution changes, which StarRocks cannot ALTER in-place.
 */
function generateTableRecreateStatements(
  schema: Schema,
  change: TableChange,
  up: MigrationStatement[],
  down: MigrationStatement[]
): void {
  const tableName = change.name;
  const table = schema.getTable(tableName);
  if (!table) return;

  // Need to quote reserved words like "user"
  const escaped = isReservedWord(tableName) ? `\`${tableName}\`` : tableName;
  const escapedOld = isReservedWord(tableName) ? `\`${tableName}_old\`` : `${tableName}_old`;

  // Get column list from schema definition
  const columns = Object.values(table.columns)
    .map((col: any) => col.name)
    .join(", ");

  const reasons: string[] = [];
  if (change.keyChange) reasons.push(`key type: ${change.keyChange.old} → ${change.keyChange.new}`);
  if (change.distributionChange) reasons.push("distribution changed");
  const reason = reasons.join(", ");

  // 1. Rename old table
  up.push({
    sql: `ALTER TABLE ${escaped} RENAME ${escapedOld}`,
    description: `Rename '${tableName}' → '${tableName}_old' (${reason})`,
    type: "alter",
    object: "table",
    objectName: tableName,
  });

  // 2. Create new table with correct schema
  up.push({
    sql: generateCreateTableSQL(table as any),
    description: `Create '${tableName}' with correct schema`,
    type: "create",
    object: "table",
    objectName: tableName,
  });

  // 3. Copy data (PRIMARY KEY tables deduplicate automatically)
  up.push({
    sql: `INSERT INTO ${escaped} (${columns}) SELECT ${columns} FROM ${escapedOld}`,
    description: `Copy data from '${tableName}_old' → '${tableName}'`,
    type: "alter",
    object: "table",
    objectName: tableName,
  });

  // 4. Drop old table
  up.push({
    sql: `DROP TABLE ${escapedOld}`,
    description: `Drop '${tableName}_old'`,
    type: "drop",
    object: "table",
    objectName: tableName,
  });

  // Down: not reversible — the old key type was a bug
  down.push({
    sql: `-- Table '${tableName}' was recreated (${reason}). Cannot auto-revert.`,
    description: `Revert '${tableName}' recreation (manual)`,
    type: "alter",
    object: "table",
    objectName: tableName,
  });
}

const RESERVED_WORDS = new Set([
  "user", "session", "account", "order", "group", "table", "index",
  "select", "insert", "update", "delete", "from", "where", "key",
  "column", "database", "schema", "grant", "role", "function",
]);

function isReservedWord(name: string): boolean {
  return RESERVED_WORDS.has(name.toLowerCase());
}

function generateColumnAlterStatements(
  tableName: string,
  change: ColumnChange,
  up: MigrationStatement[],
  down: MigrationStatement[]
): void {
  const escaped = isReservedWord(tableName) ? `\`${tableName}\`` : tableName;

  switch (change.type) {
    case "add": {
      const col = change.newColumn!;
      let colDef = `${col.name} ${col.dataType}`;
      if (col.isNotNull) colDef += " NOT NULL";
      if (col.defaultValue !== undefined) {
        colDef += ` DEFAULT ${formatDefaultValue(col.defaultValue)}`;
      }

      up.push({
        sql: `ALTER TABLE ${escaped} ADD COLUMN ${colDef}`,
        description: `Add column '${change.columnName}' to '${tableName}'`,
        type: "alter",
        object: "column",
        objectName: `${tableName}.${change.columnName}`,
      });

      down.push({
        sql: `ALTER TABLE ${escaped} DROP COLUMN ${change.columnName}`,
        description: `Drop column '${change.columnName}' from '${tableName}'`,
        type: "alter",
        object: "column",
        objectName: `${tableName}.${change.columnName}`,
      });
      break;
    }

    case "remove": {
      up.push({
        sql: `ALTER TABLE ${escaped} DROP COLUMN ${change.columnName}`,
        description: `Drop column '${change.columnName}' from '${tableName}'`,
        type: "alter",
        object: "column",
        objectName: `${tableName}.${change.columnName}`,
      });

      // For down, try to recreate the column
      const oldCol = change.oldColumn!;
      let colDef = `${oldCol.name} ${oldCol.dataType}`;
      if (!oldCol.isNullable) colDef += " NOT NULL";
      if (oldCol.defaultValue) colDef += ` DEFAULT ${oldCol.defaultValue}`;

      down.push({
        sql: `ALTER TABLE ${escaped} ADD COLUMN ${colDef}`,
        description: `Add column '${change.columnName}' to '${tableName}'`,
        type: "alter",
        object: "column",
        objectName: `${tableName}.${change.columnName}`,
      });
      break;
    }

    case "modify": {
      const col = change.newColumn!;
      let colDef = `${col.name} ${col.dataType}`;
      if (col.isNotNull) colDef += " NOT NULL";
      if (col.defaultValue !== undefined) {
        colDef += ` DEFAULT ${formatDefaultValue(col.defaultValue)}`;
      }

      up.push({
        sql: `ALTER TABLE ${escaped} MODIFY COLUMN ${colDef}`,
        description: `Modify column '${change.columnName}' in '${tableName}': ${change.changes?.join(", ")}`,
        type: "alter",
        object: "column",
        objectName: `${tableName}.${change.columnName}`,
      });

      // For down, revert to old column definition
      const oldCol = change.oldColumn!;
      let oldColDef = `${oldCol.name} ${oldCol.dataType}`;
      if (!oldCol.isNullable) oldColDef += " NOT NULL";
      if (oldCol.defaultValue) oldColDef += ` DEFAULT ${oldCol.defaultValue}`;

      down.push({
        sql: `ALTER TABLE ${escaped} MODIFY COLUMN ${oldColDef}`,
        description: `Revert column '${change.columnName}' in '${tableName}'`,
        type: "alter",
        object: "column",
        objectName: `${tableName}.${change.columnName}`,
      });
      break;
    }
  }
}

// ============================================================================
// Index Migrations
// ============================================================================

function generateIndexAlterStatements(
  tableName: string,
  change: IndexChange,
  up: MigrationStatement[],
  down: MigrationStatement[]
): void {
  switch (change.type) {
    case "add": {
      const newIdx = change.newIndex!;
      // Reconstruct IndexConfig from IntrospectedIndex for SQL generation
      const idxConfig = introspectedToIndexConfig(newIdx);
      if (idxConfig) {
        up.push({
          sql: generateCreateIndexSQL(tableName, idxConfig),
          description: `Create ${newIdx.type} index '${change.indexName}' on '${tableName}'`,
          type: "create",
          object: "index",
          objectName: `${tableName}.${change.indexName}`,
        });

        down.push({
          sql: generateDropIndexSQL(tableName, change.indexName),
          description: `Drop index '${change.indexName}' from '${tableName}'`,
          type: "drop",
          object: "index",
          objectName: `${tableName}.${change.indexName}`,
        });
      }
      break;
    }

    case "remove": {
      up.push({
        sql: generateDropIndexSQL(tableName, change.indexName),
        description: `Drop ${change.indexType} index '${change.indexName}' from '${tableName}'`,
        type: "drop",
        object: "index",
        objectName: `${tableName}.${change.indexName}`,
      });

      down.push({
        sql: `-- Cannot auto-recreate dropped index '${change.indexName}'. Manual intervention required.`,
        description: `Recreate index '${change.indexName}' on '${tableName}'`,
        type: "create",
        object: "index",
        objectName: `${tableName}.${change.indexName}`,
      });
      break;
    }

    case "modify": {
      const newIdx = change.newIndex!;
      const idxConfig = introspectedToIndexConfig(newIdx);

      // DROP + CREATE for modifications
      up.push({
        sql: generateDropIndexSQL(tableName, change.indexName),
        description: `Drop index '${change.indexName}' from '${tableName}' for modification`,
        type: "drop",
        object: "index",
        objectName: `${tableName}.${change.indexName}`,
      });

      if (idxConfig) {
        up.push({
          sql: generateCreateIndexSQL(tableName, idxConfig),
          description: `Recreate ${newIdx.type} index '${change.indexName}' on '${tableName}': ${change.changes?.join(", ")}`,
          type: "create",
          object: "index",
          objectName: `${tableName}.${change.indexName}`,
        });
      }

      down.push({
        sql: `-- Index '${change.indexName}' on '${tableName}' was modified. Manual revert may be required.`,
        description: `Revert index '${change.indexName}' on '${tableName}'`,
        type: "alter",
        object: "index",
        objectName: `${tableName}.${change.indexName}`,
      });
      break;
    }
  }
}

import type { IndexConfig } from "./table";
import type { IntrospectedIndex } from "./introspector";

function introspectedToIndexConfig(idx: IntrospectedIndex): IndexConfig | null {
  switch (idx.type) {
    case "BITMAP":
      return {
        type: "BITMAP",
        name: idx.name,
        column: idx.columns[0] ?? "",
        comment: idx.comment ?? undefined,
      };
    case "GIN":
      return {
        type: "GIN",
        name: idx.name,
        columns: idx.columns,
        comment: idx.comment ?? undefined,
      };
    case "VECTOR": {
      const indexType = (idx.properties["index_type"] || "HNSW") as "HNSW" | "IVFPQ";
      const metric = (idx.properties["metric_type"] || "L2_DISTANCE") as "L2_DISTANCE" | "COSINE_SIMILARITY";
      const dimension = parseInt(idx.properties["dim"] || "0", 10);

      const params: Record<string, number> = {};
      if (idx.properties["M"]) params.M = parseInt(idx.properties["M"], 10);
      if (idx.properties["efconstruction"]) params.efConstruction = parseInt(idx.properties["efconstruction"], 10);
      if (idx.properties["nlist"]) params.nlist = parseInt(idx.properties["nlist"], 10);
      if (idx.properties["nbits"]) params.nbits = parseInt(idx.properties["nbits"], 10);

      return {
        type: "VECTOR",
        name: idx.name,
        column: idx.columns[0] ?? "",
        indexType,
        metric,
        dimension,
        params: Object.keys(params).length > 0 ? params : undefined,
        comment: idx.comment ?? undefined,
      };
    }
    default:
      return null;
  }
}

// ============================================================================
// View Migrations
// ============================================================================

function generateViewMigrations(
  schema: Schema,
  diff: SchemaDiff,
  up: MigrationStatement[],
  down: MigrationStatement[]
): void {
  // Create new views
  for (const viewName of diff.views.added) {
    const view = schema.getView(viewName);
    if (view) {
      up.push({
        sql: generateCreateViewSQL(view as any),
        description: `Create view '${viewName}'`,
        type: "create",
        object: "view",
        objectName: viewName,
      });

      down.push({
        sql: generateDropViewSQL(view as any),
        description: `Drop view '${viewName}'`,
        type: "drop",
        object: "view",
        objectName: viewName,
      });
    }
  }

  // Drop removed views
  for (const viewName of diff.views.removed) {
    up.push({
      sql: `DROP VIEW IF EXISTS ${viewName}`,
      description: `Drop view '${viewName}'`,
      type: "drop",
      object: "view",
      objectName: viewName,
    });

    down.push({
      sql: `-- Cannot auto-recreate dropped view '${viewName}'. Manual intervention required.`,
      description: `Recreate view '${viewName}' (manual)`,
      type: "create",
      object: "view",
      objectName: viewName,
    });
  }

  // Recreate modified views
  for (const change of diff.views.modified) {
    generateViewRecreateStatements(schema, change, up, down);
  }
}

function generateViewRecreateStatements(
  schema: Schema,
  change: ViewChange,
  up: MigrationStatement[],
  down: MigrationStatement[]
): void {
  const view = schema.getView(change.name);
  if (!view) return;

  // Use CREATE OR REPLACE VIEW for atomic replacement (no window where view doesn't exist)
  up.push({
    sql: generateReplaceViewSQL(view as any),
    description: `Replace view '${change.name}' (${change.reason})`,
    type: "alter",
    object: "view",
    objectName: change.name,
  });

  // For down, we can't easily recreate the old version
  down.push({
    sql: `-- View '${change.name}' was replaced. Manual intervention may be required.`,
    description: `Revert view '${change.name}' replacement`,
    type: "alter",
    object: "view",
    objectName: change.name,
  });
}

// ============================================================================
// Materialized View Migrations
// ============================================================================

function generateMaterializedViewMigrations(
  schema: Schema,
  diff: SchemaDiff,
  up: MigrationStatement[],
  down: MigrationStatement[]
): void {
  // Create new MVs
  for (const mvName of diff.materializedViews.added) {
    const mv = schema.getMaterializedView(mvName);
    if (mv) {
      up.push({
        sql: generateCreateMaterializedViewSQL(mv as any),
        description: `Create materialized view '${mvName}'`,
        type: "create",
        object: "materialized_view",
        objectName: mvName,
      });

      down.push({
        sql: generateDropMaterializedViewSQL(mv as any),
        description: `Drop materialized view '${mvName}'`,
        type: "drop",
        object: "materialized_view",
        objectName: mvName,
      });
    }
  }

  // Drop removed MVs
  for (const mvName of diff.materializedViews.removed) {
    up.push({
      sql: `DROP MATERIALIZED VIEW IF EXISTS ${mvName}`,
      description: `Drop materialized view '${mvName}'`,
      type: "drop",
      object: "materialized_view",
      objectName: mvName,
    });

    down.push({
      sql: `-- Cannot auto-recreate dropped MV '${mvName}'. Manual intervention required.`,
      description: `Recreate materialized view '${mvName}' (manual)`,
      type: "create",
      object: "materialized_view",
      objectName: mvName,
    });
  }

  // Handle modified MVs
  for (const change of diff.materializedViews.modified) {
    generateMaterializedViewChangeStatements(schema, change, up, down);
  }
}

function generateMaterializedViewChangeStatements(
  schema: Schema,
  change: MaterializedViewChange,
  up: MigrationStatement[],
  down: MigrationStatement[]
): void {
  const mv = schema.getMaterializedView(change.name);
  if (!mv) return;

  if (change.type === "alter_refresh") {
    // Refresh strategy can be altered without recreation
    if (mv.config.refresh) {
      up.push({
        sql: generateAlterRefreshSQL(mv as any, mv.config.refresh),
        description: `Alter refresh for MV '${change.name}'`,
        type: "alter",
        object: "materialized_view",
        objectName: change.name,
      });

      // For down, we'd need the old refresh config
      down.push({
        sql: `-- Refresh strategy for MV '${change.name}' was changed. Manual revert may be required.`,
        description: `Revert refresh for MV '${change.name}'`,
        type: "alter",
        object: "materialized_view",
        objectName: change.name,
      });
    }
  } else if (change.type === "recreate") {
    // Full recreation required
    up.push({
      sql: `DROP MATERIALIZED VIEW IF EXISTS ${change.name}`,
      description: `Drop MV '${change.name}' for recreation`,
      type: "drop",
      object: "materialized_view",
      objectName: change.name,
    });

    up.push({
      sql: generateCreateMaterializedViewSQL(mv as any),
      description: `Recreate MV '${change.name}' (${change.reason})`,
      type: "create",
      object: "materialized_view",
      objectName: change.name,
    });

    down.push({
      sql: `-- MV '${change.name}' was recreated. Manual intervention may be required.`,
      description: `Revert MV '${change.name}' recreation`,
      type: "alter",
      object: "materialized_view",
      objectName: change.name,
    });
  }
}

// ============================================================================
// File Generation
// ============================================================================

/**
 * Generate TypeScript migration file content
 */
function generateMigrationFileContent(migration: GeneratedMigrationPlan): string {
  const upSteps = migration.up
    .map((stmt, i) => {
      const idempotent = stmt.sql.toUpperCase().includes("IF EXISTS") || stmt.sql.toUpperCase().includes("IF NOT EXISTS");
      return `    {
      name: "step_${i + 1}",
      description: "${escapeDoubleQuotes(stmt.description)}",
      sql: \`${escapeBackticks(stmt.sql)}\`,
      idempotent: ${idempotent},
    }`;
    })
    .join(",\n");

  const downSteps = migration.down
    .map((stmt, i) => {
      const idempotent = stmt.sql.toUpperCase().includes("IF EXISTS") || stmt.sql.toUpperCase().includes("IF NOT EXISTS");
      return `    {
      name: "rollback_${i + 1}",
      description: "${escapeDoubleQuotes(stmt.description)}",
      sql: \`${escapeBackticks(stmt.sql)}\`,
      idempotent: ${idempotent},
    }`;
    })
    .join(",\n");

  return `/**
 * Migration: ${migration.name}
 * Generated: ${new Date(migration.timestamp).toISOString()}
 */

import type { Migration } from "@jellologic/starrocks-sdk";

const migration: Migration = {
  id: "${migration.name}",
  description: "${escapeDoubleQuotes(migration.name)}",
  up: [
${upSteps || "    // No changes"}
  ],
  down: [
${downSteps || "    // No changes"}
  ],
};

export default migration;
`;
}

function escapeBackticks(sql: string): string {
  return sql.replace(/`/g, "\\`").replace(/\${/g, "\\${");
}

function escapeDoubleQuotes(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ============================================================================
// SQL-only Generation
// ============================================================================

/**
 * Generate SQL statements only (no file wrapper)
 */
export function generateMigrationSQL(
  schema: Schema,
  diff: SchemaDiff,
  introspected: IntrospectedSchema
): { up: string; down: string } {
  const { migration } = generateMigration(schema, diff, introspected);

  const upSQL = migration.up
    .map((stmt) => `-- ${stmt.description}\n${stmt.sql};`)
    .join("\n\n");

  const downSQL = migration.down
    .map((stmt) => `-- ${stmt.description}\n${stmt.sql};`)
    .join("\n\n");

  return { up: upSQL, down: downSQL };
}

/**
 * Generate dry-run output showing what would be executed
 */
export function generateDryRunOutput(
  schema: Schema,
  diff: SchemaDiff,
  introspected: IntrospectedSchema
): string {
  const { migration } = generateMigration(schema, diff, introspected);

  const lines: string[] = [
    "=== DRY RUN ===",
    "",
    "The following statements would be executed:",
    "",
  ];

  for (const stmt of migration.up) {
    lines.push(`-- ${stmt.description}`);
    lines.push(stmt.sql);
    lines.push("");
  }

  return lines.join("\n");
}
