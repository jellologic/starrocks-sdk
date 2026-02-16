/**
 * StarRocks Schema Differ
 *
 * Compare schema definitions to database state and detect changes.
 */

import type { Schema } from "./define-schema";
import type { IntrospectedSchema, IntrospectedTable, IntrospectedView, IntrospectedMaterializedView, IntrospectedColumn, IntrospectedIndex } from "./introspector";
import type { Table, TableWithRefs, IndexConfig } from "./table";
import type { View, ViewWithRefs } from "./view";
import type { MaterializedView, MaterializedViewWithRefs } from "./materialized-view";
import type { Columns, Column } from "./columns";

// ============================================================================
// Change Types
// ============================================================================

export interface ColumnChange {
  type: "add" | "remove" | "modify";
  columnName: string;
  oldColumn?: IntrospectedColumn;
  newColumn?: Column<any, any, any, any>;
  changes?: string[]; // Description of what changed
}

export interface IndexChange {
  type: "add" | "remove" | "modify";
  indexName: string;
  indexType: "BITMAP" | "GIN" | "VECTOR";
  oldIndex?: IntrospectedIndex;
  newIndex?: IntrospectedIndex;
  changes?: string[];
}

export interface TableChange {
  name: string;
  type: "create" | "drop" | "alter";
  columnChanges?: ColumnChange[];
  indexChanges?: IndexChange[];
  keyChange?: { old: string | null; new: string | null };
  distributionChange?: boolean;
  partitionChange?: boolean;
  propertyChanges?: string[];
}

export interface ViewChange {
  name: string;
  type: "create" | "drop" | "recreate";
  reason?: string;
}

export interface MaterializedViewChange {
  name: string;
  type: "create" | "drop" | "recreate" | "alter_refresh";
  reason?: string;
  refreshChange?: { old: string | null; new: string | null };
}

export interface SchemaDiff {
  tables: {
    added: string[];
    removed: string[];
    modified: TableChange[];
  };
  views: {
    added: string[];
    removed: string[];
    modified: ViewChange[];
  };
  materializedViews: {
    added: string[];
    removed: string[];
    modified: MaterializedViewChange[];
  };
  hasChanges: boolean;
}

// ============================================================================
// Differ
// ============================================================================

/**
 * Compare schema definition to introspected database state
 */
export function diffSchema(
  schema: Schema,
  introspected: IntrospectedSchema
): SchemaDiff {
  const diff: SchemaDiff = {
    tables: { added: [], removed: [], modified: [] },
    views: { added: [], removed: [], modified: [] },
    materializedViews: { added: [], removed: [], modified: [] },
    hasChanges: false,
  };

  // Compare tables
  diffTables(schema, introspected, diff);

  // Compare views
  diffViews(schema, introspected, diff);

  // Compare materialized views
  diffMaterializedViews(schema, introspected, diff);

  // Check if there are any changes
  diff.hasChanges =
    diff.tables.added.length > 0 ||
    diff.tables.removed.length > 0 ||
    diff.tables.modified.length > 0 ||
    diff.views.added.length > 0 ||
    diff.views.removed.length > 0 ||
    diff.views.modified.length > 0 ||
    diff.materializedViews.added.length > 0 ||
    diff.materializedViews.removed.length > 0 ||
    diff.materializedViews.modified.length > 0;

  return diff;
}

// ============================================================================
// Table Diffing
// ============================================================================

function diffTables(
  schema: Schema,
  introspected: IntrospectedSchema,
  diff: SchemaDiff
): void {
  const definedTables = new Set(schema.getTableNames());
  const existingTables = new Set(introspected.tables.map((t) => t.name));

  // Find added tables
  for (const name of definedTables) {
    if (!existingTables.has(name)) {
      diff.tables.added.push(name);
    }
  }

  // Find removed tables
  for (const name of existingTables) {
    if (!definedTables.has(name)) {
      diff.tables.removed.push(name);
    }
  }

  // Find modified tables
  for (const name of definedTables) {
    if (existingTables.has(name)) {
      const definedTable = schema.getTable(name);
      const existingTable = introspected.tables.find((t) => t.name === name);

      if (definedTable && existingTable) {
        const changes = diffTable(definedTable, existingTable);
        if (changes) {
          diff.tables.modified.push(changes);
        }
      }
    }
  }
}

function diffTable(
  defined: TableWithRefs<string, Columns> | Table<string, Columns>,
  existing: IntrospectedTable
): TableChange | null {
  const changes: TableChange = {
    name: existing.name,
    type: "alter",
    columnChanges: [],
  };

  // Compare columns
  const definedColumns = new Map(
    Object.entries(defined.columns).map(([, col]) => [col.name, col])
  );
  const existingColumns = new Map(existing.columns.map((col) => [col.name, col]));

  // Find added columns
  for (const [name, col] of definedColumns) {
    if (!existingColumns.has(name)) {
      changes.columnChanges!.push({
        type: "add",
        columnName: name,
        newColumn: col as Column<any, any, any, any>,
      });
    }
  }

  // Find removed columns
  for (const [name, col] of existingColumns) {
    if (!definedColumns.has(name)) {
      changes.columnChanges!.push({
        type: "remove",
        columnName: name,
        oldColumn: col,
      });
    }
  }

  // Find modified columns
  for (const [name, definedCol] of definedColumns) {
    const existingCol = existingColumns.get(name);
    if (existingCol) {
      const isPrimaryKey = defined.config.key?.type === "PRIMARY";
      const colChanges = diffColumn(definedCol as Column<any, any, any, any>, existingCol, isPrimaryKey);
      if (colChanges.length > 0) {
        changes.columnChanges!.push({
          type: "modify",
          columnName: name,
          oldColumn: existingCol,
          newColumn: definedCol as Column<any, any, any, any>,
          changes: colChanges,
        });
      }
    }
  }

  // Compare key type
  const definedKeyType = defined.config.key?.type || null;
  if (definedKeyType !== existing.keyType) {
    changes.keyChange = { old: existing.keyType, new: definedKeyType };
  }

  // Compare distribution (simplified - just check if changed)
  const definedDist = defined.config.distribution;
  if (definedDist) {
    if (definedDist.type !== existing.distributionType) {
      changes.distributionChange = true;
    } else if (
      definedDist.type === "HASH" &&
      existing.distributionType === "HASH" &&
      (definedDist.columns.join(",") !== existing.distributionColumns.join(",") ||
        definedDist.buckets !== existing.buckets)
    ) {
      changes.distributionChange = true;
    }
  }

  // Compare properties
  const propertyChanges = diffProperties(defined, existing);
  if (propertyChanges.length > 0) {
    changes.propertyChanges = propertyChanges;
  }

  // Compare indexes
  const indexChanges = diffIndexes(defined.config.indexes ?? [], existing.indexes ?? []);
  if (indexChanges.length > 0) {
    changes.indexChanges = indexChanges;
  }

  // Return null if no changes
  if (
    changes.columnChanges!.length === 0 &&
    !changes.keyChange &&
    !changes.distributionChange &&
    !changes.partitionChange &&
    (!changes.propertyChanges || changes.propertyChanges.length === 0) &&
    (!changes.indexChanges || changes.indexChanges.length === 0)
  ) {
    return null;
  }

  return changes;
}

function diffColumn(
  defined: Column<any, any, any, any>,
  existing: IntrospectedColumn,
  isPrimaryKey: boolean = false
): string[] {
  const changes: string[] = [];

  // Compare data type (normalize for comparison)
  const definedType = normalizeDataType(defined.dataType);
  const existingType = normalizeDataType(existing.dataType);
  if (definedType !== existingType) {
    changes.push(`type: ${existingType} -> ${definedType}`);
  }

  // Compare nullability
  const definedNullable = !defined.isNotNull;
  if (definedNullable !== existing.isNullable) {
    changes.push(`nullable: ${existing.isNullable} -> ${definedNullable}`);
  }

  // Compare default
  // Skip for PRIMARY KEY tables — StarRocks ignores DEFAULT on non-key columns
  // for PRIMARY KEY tables, so comparing them produces false positives.
  if (!isPrimaryKey) {
    const definedDefault = defined.defaultValue?.toString() ?? null;
    if (definedDefault !== existing.defaultValue) {
      changes.push(`default: ${existing.defaultValue} -> ${definedDefault}`);
    }
  }

  return changes;
}

function diffProperties(
  defined: TableWithRefs<string, Columns> | Table<string, Columns>,
  existing: IntrospectedTable
): string[] {
  const changes: string[] = [];
  const definedProps = defined.config.properties;
  if (!definedProps) return changes;

  for (const [key, value] of Object.entries(definedProps)) {
    if (value === undefined) continue;
    const definedValue = typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
    const existingValue = existing.properties[key] ?? null;
    if (existingValue !== definedValue) {
      changes.push(`${key}: ${existingValue ?? "(unset)"} -> ${definedValue}`);
    }
  }

  return changes;
}

function normalizeDataType(type: string): string {
  // Normalize data types for comparison
  let normalized = type
    .toUpperCase()
    .replace(/\s+/g, "") // Remove whitespace
    .replace(/,\s*/g, ","); // Normalize decimal format: DECIMAL(12, 2) -> DECIMAL(12,2)

  // StarRocks stores BOOLEAN as TINYINT(1)
  if (normalized === "TINYINT(1)" || normalized === "BOOLEAN") {
    return "BOOLEAN";
  }

  // Remove display width from integer types (INT(11) -> INT, BIGINT(20) -> BIGINT)
  // StarRocks adds these automatically but they don't affect storage
  normalized = normalized
    .replace(/^BIGINT\(\d+\)$/i, "BIGINT")
    .replace(/^INT\(\d+\)$/i, "INT")
    .replace(/^SMALLINT\(\d+\)$/i, "SMALLINT")
    .replace(/^TINYINT\(\d+\)$/i, "TINYINT"); // Non-boolean tinyint

  // Normalize DATETIME precision (DATETIME vs DATETIME(0))
  normalized = normalized.replace(/^DATETIME\(0\)$/, "DATETIME");

  return normalized;
}

// ============================================================================
// Index Diffing
// ============================================================================

function indexConfigToIntrospected(idx: IndexConfig): IntrospectedIndex {
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
    type: idx.type,
    columns: idx.type === "GIN" ? idx.columns :
             idx.type === "BITMAP" ? [idx.column] :
             [idx.column],
    properties,
    comment: idx.comment ?? null,
  };
}

function diffIndexes(
  definedConfigs: IndexConfig[],
  existingIndexes: IntrospectedIndex[]
): IndexChange[] {
  const changes: IndexChange[] = [];

  const definedMap = new Map<string, IntrospectedIndex>();
  for (const cfg of definedConfigs) {
    definedMap.set(cfg.name, indexConfigToIntrospected(cfg));
  }
  const existingMap = new Map(existingIndexes.map((idx) => [idx.name, idx]));

  // Added indexes
  for (const [name, idx] of definedMap) {
    if (!existingMap.has(name)) {
      changes.push({
        type: "add",
        indexName: name,
        indexType: idx.type,
        newIndex: idx,
      });
    }
  }

  // Removed indexes
  for (const [name, idx] of existingMap) {
    if (!definedMap.has(name)) {
      changes.push({
        type: "remove",
        indexName: name,
        indexType: idx.type,
        oldIndex: idx,
      });
    }
  }

  // Modified indexes
  for (const [name, defined] of definedMap) {
    const existing = existingMap.get(name);
    if (existing) {
      const diffs: string[] = [];

      if (defined.type !== existing.type) {
        diffs.push(`type: ${existing.type} -> ${defined.type}`);
      }

      if (defined.columns.join(",") !== existing.columns.join(",")) {
        diffs.push(`columns: ${existing.columns.join(",")} -> ${defined.columns.join(",")}`);
      }

      // Compare properties (for VECTOR indexes)
      for (const [key, val] of Object.entries(defined.properties)) {
        if (existing.properties[key] !== val) {
          diffs.push(`${key}: ${existing.properties[key] ?? "(unset)"} -> ${val}`);
        }
      }

      if (diffs.length > 0) {
        changes.push({
          type: "modify",
          indexName: name,
          indexType: defined.type,
          oldIndex: existing,
          newIndex: defined,
          changes: diffs,
        });
      }
    }
  }

  return changes;
}

// ============================================================================
// View Diffing
// ============================================================================

function diffViews(
  schema: Schema,
  introspected: IntrospectedSchema,
  diff: SchemaDiff
): void {
  const definedViews = new Set(schema.getViewNames());
  const existingViews = new Set(introspected.views.map((v) => v.name));

  // Find added views
  for (const name of definedViews) {
    if (!existingViews.has(name)) {
      diff.views.added.push(name);
    }
  }

  // Find removed views
  for (const name of existingViews) {
    if (!definedViews.has(name)) {
      diff.views.removed.push(name);
    }
  }

  // Find modified views (views need to be recreated if definition changes)
  for (const name of definedViews) {
    if (existingViews.has(name)) {
      const definedView = schema.getView(name);
      const existingView = introspected.views.find((v) => v.name === name);

      if (definedView && existingView) {
        const change = diffView(definedView, existingView);
        if (change) {
          diff.views.modified.push(change);
        }
      }
    }
  }
}

function diffView(
  defined: ViewWithRefs<string, Columns> | View<string, Columns>,
  existing: IntrospectedView
): ViewChange | null {
  // For views, we check if the query definition has changed
  // Since we can't easily compare, we compare column structure
  const definedColumns = Object.values(defined.columns).map((c) => c.name).sort();
  const existingColumns = existing.columns.map((c) => c.name).sort();

  if (definedColumns.join(",") !== existingColumns.join(",")) {
    return {
      name: existing.name,
      type: "recreate",
      reason: "Column structure changed",
    };
  }

  // Check security mode
  if (defined.config.security !== existing.security && defined.config.security) {
    return {
      name: existing.name,
      type: "recreate",
      reason: "Security mode changed",
    };
  }

  return null;
}

// ============================================================================
// Materialized View Diffing
// ============================================================================

function diffMaterializedViews(
  schema: Schema,
  introspected: IntrospectedSchema,
  diff: SchemaDiff
): void {
  const definedMVs = new Set(schema.getMaterializedViewNames());
  const existingMVs = new Set(introspected.materializedViews.map((mv) => mv.name));

  // Find added MVs
  for (const name of definedMVs) {
    if (!existingMVs.has(name)) {
      diff.materializedViews.added.push(name);
    }
  }

  // Find removed MVs
  for (const name of existingMVs) {
    if (!definedMVs.has(name)) {
      diff.materializedViews.removed.push(name);
    }
  }

  // Find modified MVs
  for (const name of definedMVs) {
    if (existingMVs.has(name)) {
      const definedMV = schema.getMaterializedView(name);
      const existingMV = introspected.materializedViews.find((mv) => mv.name === name);

      if (definedMV && existingMV) {
        const change = diffMaterializedView(definedMV, existingMV);
        if (change) {
          diff.materializedViews.modified.push(change);
        }
      }
    }
  }
}

function diffMaterializedView(
  defined: MaterializedViewWithRefs<string, Columns> | MaterializedView<string, Columns>,
  existing: IntrospectedMaterializedView
): MaterializedViewChange | null {
  // Check if refresh strategy changed (can be altered)
  const definedRefresh = defined.config.refresh?.type || null;
  if (definedRefresh !== existing.refreshType) {
    return {
      name: existing.name,
      type: "alter_refresh",
      refreshChange: { old: existing.refreshType, new: definedRefresh },
    };
  }

  // Check if column structure changed (requires recreate)
  const definedColumns = Object.values(defined.columns).map((c) => c.name).sort();
  const existingColumns = existing.columns.map((c) => c.name).sort();

  if (definedColumns.join(",") !== existingColumns.join(",")) {
    return {
      name: existing.name,
      type: "recreate",
      reason: "Column structure changed",
    };
  }

  // Check distribution change (requires recreate)
  const definedDist = defined.config.distribution;
  if (definedDist) {
    if (
      definedDist.type !== existing.distributionType ||
      (definedDist.type === "HASH" &&
        definedDist.columns.join(",") !== existing.distributionColumns.join(","))
    ) {
      return {
        name: existing.name,
        type: "recreate",
        reason: "Distribution changed",
      };
    }
  }

  return null;
}

// ============================================================================
// Diff Summary
// ============================================================================

/**
 * Generate a human-readable summary of schema changes
 */
export function summarizeDiff(diff: SchemaDiff): string {
  const lines: string[] = [];

  // Tables
  if (diff.tables.added.length > 0) {
    lines.push(`Tables to create: ${diff.tables.added.join(", ")}`);
  }
  if (diff.tables.removed.length > 0) {
    lines.push(`Tables to drop: ${diff.tables.removed.join(", ")}`);
  }
  for (const change of diff.tables.modified) {
    const details: string[] = [];
    if (change.columnChanges) {
      const added = change.columnChanges.filter((c) => c.type === "add").map((c) => c.columnName);
      const removed = change.columnChanges.filter((c) => c.type === "remove").map((c) => c.columnName);
      const modified = change.columnChanges.filter((c) => c.type === "modify").map((c) => c.columnName);
      if (added.length > 0) details.push(`add columns: ${added.join(", ")}`);
      if (removed.length > 0) details.push(`remove columns: ${removed.join(", ")}`);
      if (modified.length > 0) details.push(`modify columns: ${modified.join(", ")}`);
    }
    if (change.keyChange) details.push(`key type: ${change.keyChange.old} -> ${change.keyChange.new}`);
    if (change.distributionChange) details.push("distribution changed");
    if (change.propertyChanges && change.propertyChanges.length > 0) {
      details.push(`properties: ${change.propertyChanges.join(", ")}`);
    }
    if (change.indexChanges) {
      const addedIdx = change.indexChanges.filter((c) => c.type === "add").map((c) => c.indexName);
      const removedIdx = change.indexChanges.filter((c) => c.type === "remove").map((c) => c.indexName);
      const modifiedIdx = change.indexChanges.filter((c) => c.type === "modify").map((c) => c.indexName);
      if (addedIdx.length > 0) details.push(`add indexes: ${addedIdx.join(", ")}`);
      if (removedIdx.length > 0) details.push(`remove indexes: ${removedIdx.join(", ")}`);
      if (modifiedIdx.length > 0) details.push(`modify indexes: ${modifiedIdx.join(", ")}`);
    }
    lines.push(`Table '${change.name}': ${details.join("; ")}`);
  }

  // Views
  if (diff.views.added.length > 0) {
    lines.push(`Views to create: ${diff.views.added.join(", ")}`);
  }
  if (diff.views.removed.length > 0) {
    lines.push(`Views to drop: ${diff.views.removed.join(", ")}`);
  }
  for (const change of diff.views.modified) {
    lines.push(`View '${change.name}': ${change.type} (${change.reason})`);
  }

  // Materialized Views
  if (diff.materializedViews.added.length > 0) {
    lines.push(`Materialized views to create: ${diff.materializedViews.added.join(", ")}`);
  }
  if (diff.materializedViews.removed.length > 0) {
    lines.push(`Materialized views to drop: ${diff.materializedViews.removed.join(", ")}`);
  }
  for (const change of diff.materializedViews.modified) {
    if (change.type === "alter_refresh") {
      lines.push(`MV '${change.name}': refresh ${change.refreshChange?.old} -> ${change.refreshChange?.new}`);
    } else {
      lines.push(`MV '${change.name}': ${change.type} (${change.reason})`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "No changes detected";
}
