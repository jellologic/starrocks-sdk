/**
 * ALTER TABLE DDL Builder
 *
 * Fluent builder for generating StarRocks ALTER TABLE statements.
 * Supports adding/dropping/modifying columns, managing indexes,
 * renaming tables, and updating table properties.
 *
 * @example
 * ```typescript
 * const sql = alter("users")
 *   .addColumn(varchar("email", { length: 255 }).notNull())
 *   .dropColumn("legacy_field")
 *   .modifyColumn(varchar("status", { length: 50 }))
 *   .addIndex(bitmapIndex("idx_status", "status"))
 *   .setProperties({ replication_num: "3" })
 *   .generateSQL()
 * ```
 */

import type { Column, Columns } from "./columns";
import type { Table, IndexConfig } from "./table";
import { quoteIdentifier, formatDefaultValue } from "./sql-utils";
import { generateCreateIndexSQL, generateDropIndexSQL } from "./table";

// ============================================================================
// Types
// ============================================================================

/** A single ALTER TABLE operation */
export type AlterOperation =
  | { type: "addColumn"; column: Column<any, any, any, any>; after?: string }
  | { type: "dropColumn"; columnName: string }
  | { type: "modifyColumn"; column: Column<any, any, any, any> }
  | { type: "renameColumn"; oldName: string; newName: string }
  | { type: "rename"; newTableName: string }
  | { type: "addIndex"; index: IndexConfig }
  | { type: "dropIndex"; indexName: string }
  | { type: "setProperties"; properties: Record<string, string | number | boolean> }

/** Result of generateSQL() — one or more SQL statements */
export interface AlterTablePlan {
  readonly tableName: string
  readonly statements: AlterStatement[]
}

export interface AlterStatement {
  readonly sql: string
  readonly description: string
}

// ============================================================================
// Builder
// ============================================================================

/**
 * Fluent builder for ALTER TABLE operations.
 * Each method returns a new builder instance (immutable).
 */
export class AlterTableBuilder {
  private readonly _tableName: string
  private readonly _operations: readonly AlterOperation[]

  constructor(tableName: string, operations: readonly AlterOperation[] = []) {
    this._tableName = tableName
    this._operations = operations
  }

  private with(op: AlterOperation): AlterTableBuilder {
    return new AlterTableBuilder(this._tableName, [...this._operations, op])
  }

  /**
   * Add a new column to the table.
   *
   * @param column - Column definition (e.g., `varchar("email", { length: 255 }).notNull()`)
   * @param options.after - Position the column after an existing column
   */
  addColumn(column: Column<any, any, any, any>, options?: { after?: string }): AlterTableBuilder {
    return this.with({ type: "addColumn", column, after: options?.after })
  }

  /**
   * Drop a column from the table.
   *
   * @param columnName - Name of the column to drop
   */
  dropColumn(columnName: string): AlterTableBuilder {
    return this.with({ type: "dropColumn", columnName })
  }

  /**
   * Modify an existing column (change type, nullability, or default).
   * The column name in the Column definition identifies which column to modify.
   *
   * @param column - New column definition with the same name
   */
  modifyColumn(column: Column<any, any, any, any>): AlterTableBuilder {
    return this.with({ type: "modifyColumn", column })
  }

  /**
   * Rename a column.
   *
   * @param oldName - Current column name
   * @param newName - New column name
   */
  renameColumn(oldName: string, newName: string): AlterTableBuilder {
    return this.with({ type: "renameColumn", oldName, newName })
  }

  /**
   * Rename the table.
   *
   * @param newTableName - New table name
   */
  rename(newTableName: string): AlterTableBuilder {
    return this.with({ type: "rename", newTableName })
  }

  /**
   * Add an index to the table.
   *
   * @param index - Index config (e.g., `bitmapIndex("idx_status", "status")`)
   */
  addIndex(index: IndexConfig): AlterTableBuilder {
    return this.with({ type: "addIndex", index })
  }

  /**
   * Drop an index from the table.
   *
   * @param indexName - Name of the index to drop
   */
  dropIndex(indexName: string): AlterTableBuilder {
    return this.with({ type: "dropIndex", indexName })
  }

  /**
   * Set table properties (e.g., replication_num, storage_medium).
   *
   * @param properties - Key-value map of properties to set
   */
  setProperties(properties: Record<string, string | number | boolean>): AlterTableBuilder {
    return this.with({ type: "setProperties", properties })
  }

  /**
   * Generate all SQL statements for the accumulated operations.
   * Returns an array of SQL strings — one per operation.
   */
  generateSQL(): string[] {
    return this._operations.map((op) => generateAlterSQL(this._tableName, op))
  }

  /**
   * Generate a structured plan with descriptions for each operation.
   */
  toPlan(): AlterTablePlan {
    return {
      tableName: this._tableName,
      statements: this._operations.map((op) => ({
        sql: generateAlterSQL(this._tableName, op),
        description: describeOperation(this._tableName, op),
      })),
    }
  }
}

// ============================================================================
// Entry Point
// ============================================================================

/**
 * Create an ALTER TABLE builder for the given table.
 *
 * @param table - Table name (string) or Table definition object
 *
 * @example
 * ```typescript
 * // From string name
 * alter("users").addColumn(varchar("email", { length: 255 })).generateSQL()
 *
 * // From table definition
 * alter(usersTable).dropColumn("legacy_field").generateSQL()
 * ```
 */
export function alter(table: string | Table<any, any>): AlterTableBuilder {
  const tableName = typeof table === "string" ? table : table.name
  return new AlterTableBuilder(tableName)
}

// ============================================================================
// SQL Generation
// ============================================================================

function formatColumnDef(col: Column<any, any, any, any>): string {
  let def = `${quoteIdentifier(col.name)} ${col.dataType}`
  if (col.isNotNull) def += " NOT NULL"
  if (col.defaultValue !== undefined) {
    def += ` DEFAULT ${formatDefaultValue(col.defaultValue)}`
  }
  return def
}

function generateAlterSQL(tableName: string, op: AlterOperation): string {
  const escaped = quoteIdentifier(tableName)

  switch (op.type) {
    case "addColumn": {
      const colDef = formatColumnDef(op.column)
      const after = op.after ? ` AFTER ${quoteIdentifier(op.after)}` : ""
      return `ALTER TABLE ${escaped} ADD COLUMN ${colDef}${after}`
    }

    case "dropColumn":
      return `ALTER TABLE ${escaped} DROP COLUMN ${quoteIdentifier(op.columnName)}`

    case "modifyColumn": {
      const colDef = formatColumnDef(op.column)
      return `ALTER TABLE ${escaped} MODIFY COLUMN ${colDef}`
    }

    case "renameColumn":
      return `ALTER TABLE ${escaped} RENAME COLUMN ${quoteIdentifier(op.oldName)} ${quoteIdentifier(op.newName)}`

    case "rename":
      return `ALTER TABLE ${escaped} RENAME ${quoteIdentifier(op.newTableName)}`

    case "addIndex":
      return generateCreateIndexSQL(tableName, op.index)

    case "dropIndex":
      return generateDropIndexSQL(tableName, op.indexName)

    case "setProperties": {
      const pairs = Object.entries(op.properties)
        .map(([k, v]) => `"${k}" = "${v}"`)
        .join(", ")
      return `ALTER TABLE ${escaped} SET (${pairs})`
    }
  }
}

function describeOperation(tableName: string, op: AlterOperation): string {
  switch (op.type) {
    case "addColumn":
      return `Add column '${op.column.name}' to '${tableName}'`
    case "dropColumn":
      return `Drop column '${op.columnName}' from '${tableName}'`
    case "modifyColumn":
      return `Modify column '${op.column.name}' in '${tableName}'`
    case "renameColumn":
      return `Rename column '${op.oldName}' to '${op.newName}' in '${tableName}'`
    case "rename":
      return `Rename table '${tableName}' to '${op.newTableName}'`
    case "addIndex":
      return `Add ${op.index.type} index '${op.index.name}' on '${tableName}'`
    case "dropIndex":
      return `Drop index '${op.indexName}' from '${tableName}'`
    case "setProperties":
      return `Set properties on '${tableName}': ${Object.keys(op.properties).join(", ")}`
  }
}
