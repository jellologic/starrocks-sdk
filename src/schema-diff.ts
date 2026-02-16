/**
 * StarRocks Schema Diff Tool
 *
 * Compares a defined schema against the actual database schema
 * and reports differences for validation and migration planning.
 */

import type { StarRocksClient } from "./client";
import type { ColumnDef, KeyType, TableOptions } from "./types";

// ============================================================================
// Schema Definition Types
// ============================================================================

/** Defined table schema for comparison */
export interface TableSchema {
  name: string;
  columns: ColumnDef[];
  options: TableOptions;
}

/** Complete schema definition */
export interface SchemaDefinition {
  database: string;
  tables: TableSchema[];
}

// ============================================================================
// Introspected Schema Types
// ============================================================================

/** Column as introspected from the database */
export interface IntrospectedColumn {
  name: string;
  type: string;
  nullable: boolean;
  isKey: boolean;
  defaultValue?: string;
  aggregateType?: string;
}

/** Table as introspected from the database */
export interface IntrospectedTable {
  name: string;
  columns: IntrospectedColumn[];
  keyType: KeyType;
  keyColumns: string[];
  distributionType: "HASH" | "RANDOM";
  distributionColumns: string[];
  buckets: number;
  partitionType?: "RANGE" | "LIST" | "EXPRESSION";
  partitionColumns?: string[];
  properties: Record<string, string>;
}

/** Complete introspected schema */
export interface IntrospectedSchema {
  database: string;
  tables: IntrospectedTable[];
}

// ============================================================================
// Diff Types
// ============================================================================

export type DiffSeverity = "info" | "warning" | "error";

export interface SchemaDiff {
  type: "table_missing" | "table_extra" | "column_missing" | "column_extra" |
        "column_type_mismatch" | "column_nullable_mismatch" | "column_default_mismatch" |
        "key_type_mismatch" | "key_columns_mismatch" | "distribution_mismatch" |
        "partition_mismatch" | "property_mismatch";
  severity: DiffSeverity;
  table: string;
  column?: string;
  expected?: string;
  actual?: string;
  message: string;
  suggestedAction?: string;
}

export interface SchemaDiffResult {
  isValid: boolean;
  database: string;
  diffs: SchemaDiff[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
}

// ============================================================================
// Schema Introspector
// ============================================================================

export class SchemaIntrospector {
  constructor(private client: StarRocksClient) {}

  /**
   * Introspect the complete schema of a database
   */
  async introspect(database: string): Promise<IntrospectedSchema> {
    await this.client.useDatabase(database);

    const tableNames = await this.client.showTables();
    const tables: IntrospectedTable[] = [];

    for (const tableName of tableNames) {
      const table = await this.introspectTable(tableName);
      if (table) {
        tables.push(table);
      }
    }

    return { database, tables };
  }

  /**
   * Introspect a single table
   */
  async introspectTable(tableName: string): Promise<IntrospectedTable | null> {
    try {
      // Get CREATE TABLE statement
      const createStmt = await this.client.getTableSchema(tableName);
      if (!createStmt) return null;

      // Get column info
      const columns = await this.client.getColumns(tableName);

      // Parse the CREATE TABLE statement
      const parsed = this.parseCreateTable(createStmt);

      return {
        name: tableName,
        columns: columns.map(col => ({
          name: col.name,
          type: col.type,
          nullable: col.nullable,
          isKey: col.isKey,
          defaultValue: col.defaultValue,
          aggregateType: this.extractAggregateType(createStmt, col.name),
        })),
        keyType: parsed.keyType,
        keyColumns: parsed.keyColumns,
        distributionType: parsed.distributionType,
        distributionColumns: parsed.distributionColumns,
        buckets: parsed.buckets,
        partitionType: parsed.partitionType,
        partitionColumns: parsed.partitionColumns,
        properties: parsed.properties,
      };
    } catch {
      return null;
    }
  }

  /**
   * Parse CREATE TABLE statement to extract metadata
   */
  private parseCreateTable(createStmt: string): {
    keyType: KeyType;
    keyColumns: string[];
    distributionType: "HASH" | "RANDOM";
    distributionColumns: string[];
    buckets: number;
    partitionType?: "RANGE" | "LIST" | "EXPRESSION";
    partitionColumns?: string[];
    properties: Record<string, string>;
  } {
    const upper = createStmt.toUpperCase();

    // Parse key type
    let keyType: KeyType = "DUPLICATE";
    if (upper.includes("PRIMARY KEY")) keyType = "PRIMARY";
    else if (upper.includes("UNIQUE KEY")) keyType = "UNIQUE";
    else if (upper.includes("AGGREGATE KEY")) keyType = "AGGREGATE";

    // Parse key columns
    const keyMatch = createStmt.match(/(?:PRIMARY|UNIQUE|AGGREGATE|DUPLICATE)\s+KEY\s*\(([^)]+)\)/i);
    const keyColumns = keyMatch
      ? keyMatch[1]!.split(",").map(c => c.trim().replace(/`/g, ""))
      : [];

    // Parse distribution
    let distributionType: "HASH" | "RANDOM" = "HASH";
    let distributionColumns: string[] = [];
    let buckets = 0;

    if (upper.includes("DISTRIBUTED BY RANDOM")) {
      distributionType = "RANDOM";
    } else {
      const distMatch = createStmt.match(/DISTRIBUTED BY HASH\s*\(([^)]+)\)/i);
      if (distMatch) {
        distributionColumns = distMatch[1]!.split(",").map(c => c.trim().replace(/`/g, ""));
      }
    }

    const bucketsMatch = createStmt.match(/BUCKETS\s+(\d+)/i);
    if (bucketsMatch) {
      buckets = parseInt(bucketsMatch[1]!, 10);
    }

    // Parse partition
    let partitionType: "RANGE" | "LIST" | "EXPRESSION" | undefined;
    let partitionColumns: string[] | undefined;

    if (upper.includes("PARTITION BY RANGE")) {
      partitionType = "RANGE";
      const partMatch = createStmt.match(/PARTITION BY RANGE\s*\(([^)]+)\)/i);
      if (partMatch) {
        partitionColumns = partMatch[1]!.split(",").map(c => c.trim().replace(/`/g, ""));
      }
    } else if (upper.includes("PARTITION BY LIST")) {
      partitionType = "LIST";
      const partMatch = createStmt.match(/PARTITION BY LIST\s*\(([^)]+)\)/i);
      if (partMatch) {
        partitionColumns = partMatch[1]!.split(",").map(c => c.trim().replace(/`/g, ""));
      }
    }

    // Parse properties
    const properties: Record<string, string> = {};
    const propsMatch = createStmt.match(/PROPERTIES\s*\(([\s\S]*?)\)/i);
    if (propsMatch) {
      const propsStr = propsMatch[1]!;
      const propRegex = /"([^"]+)"\s*=\s*"([^"]*)"/g;
      let match;
      while ((match = propRegex.exec(propsStr)) !== null) {
        properties[match[1]!] = match[2]!;
      }
    }

    return {
      keyType,
      keyColumns,
      distributionType,
      distributionColumns,
      buckets,
      partitionType,
      partitionColumns,
      properties,
    };
  }

  /**
   * Extract aggregate type for a column from CREATE TABLE statement
   */
  private extractAggregateType(createStmt: string, columnName: string): string | undefined {
    const regex = new RegExp(
      `\`?${columnName}\`?\\s+\\w+[^,]*?\\s+(SUM|MIN|MAX|REPLACE|REPLACE_IF_NOT_NULL|HLL_UNION|BITMAP_UNION)`,
      "i"
    );
    const match = createStmt.match(regex);
    return match ? match[1]!.toUpperCase() : undefined;
  }
}

// ============================================================================
// Schema Differ
// ============================================================================

export class SchemaDiffer {
  /**
   * Compare a defined schema against an introspected schema
   */
  diff(defined: SchemaDefinition, actual: IntrospectedSchema): SchemaDiffResult {
    const diffs: SchemaDiff[] = [];

    // Check for missing tables (in definition but not in DB)
    for (const table of defined.tables) {
      const actualTable = actual.tables.find(t => t.name === table.name);
      if (!actualTable) {
        diffs.push({
          type: "table_missing",
          severity: "error",
          table: table.name,
          message: `Table '${table.name}' is defined but does not exist in database`,
          suggestedAction: `CREATE TABLE ${table.name}`,
        });
        continue;
      }

      // Compare table structure
      this.diffTable(table, actualTable, diffs);
    }

    // Check for extra tables (in DB but not in definition)
    for (const actualTable of actual.tables) {
      const definedTable = defined.tables.find(t => t.name === actualTable.name);
      if (!definedTable) {
        diffs.push({
          type: "table_extra",
          severity: "warning",
          table: actualTable.name,
          message: `Table '${actualTable.name}' exists in database but is not defined in schema`,
          suggestedAction: `Consider adding to schema or DROP TABLE ${actualTable.name}`,
        });
      }
    }

    const summary = {
      errors: diffs.filter(d => d.severity === "error").length,
      warnings: diffs.filter(d => d.severity === "warning").length,
      info: diffs.filter(d => d.severity === "info").length,
    };

    return {
      isValid: summary.errors === 0,
      database: defined.database,
      diffs,
      summary,
    };
  }

  /**
   * Compare a single table's structure
   */
  private diffTable(
    defined: TableSchema,
    actual: IntrospectedTable,
    diffs: SchemaDiff[]
  ): void {
    // Compare key type
    if (defined.options.keyType !== actual.keyType) {
      diffs.push({
        type: "key_type_mismatch",
        severity: "error",
        table: defined.name,
        expected: defined.options.keyType,
        actual: actual.keyType,
        message: `Table '${defined.name}' has key type '${actual.keyType}' but expected '${defined.options.keyType}'`,
        suggestedAction: "Key type cannot be altered. Table must be recreated.",
      });
    }

    // Compare key columns
    const expectedKeys = defined.options.keys.join(",");
    const actualKeys = actual.keyColumns.join(",");
    if (expectedKeys !== actualKeys) {
      diffs.push({
        type: "key_columns_mismatch",
        severity: "error",
        table: defined.name,
        expected: expectedKeys,
        actual: actualKeys,
        message: `Table '${defined.name}' has key columns (${actualKeys}) but expected (${expectedKeys})`,
        suggestedAction: "Key columns cannot be altered. Table must be recreated.",
      });
    }

    // Compare distribution
    this.diffDistribution(defined, actual, diffs);

    // Compare columns
    this.diffColumns(defined, actual, diffs);
  }

  /**
   * Compare distribution configuration
   */
  private diffDistribution(
    defined: TableSchema,
    actual: IntrospectedTable,
    diffs: SchemaDiff[]
  ): void {
    const expectedDist = defined.options.distribution;

    if (expectedDist.type !== actual.distributionType) {
      diffs.push({
        type: "distribution_mismatch",
        severity: "warning",
        table: defined.name,
        expected: expectedDist.type,
        actual: actual.distributionType,
        message: `Table '${defined.name}' has distribution type '${actual.distributionType}' but expected '${expectedDist.type}'`,
        suggestedAction: "Distribution cannot be altered. Table must be recreated.",
      });
    }

    if (expectedDist.type === "HASH") {
      const expectedCols = expectedDist.columns.join(",");
      const actualCols = actual.distributionColumns.join(",");
      if (expectedCols !== actualCols) {
        diffs.push({
          type: "distribution_mismatch",
          severity: "warning",
          table: defined.name,
          expected: `HASH(${expectedCols})`,
          actual: `HASH(${actualCols})`,
          message: `Table '${defined.name}' has distribution columns (${actualCols}) but expected (${expectedCols})`,
          suggestedAction: "Distribution columns cannot be altered. Table must be recreated.",
        });
      }
    }
  }

  /**
   * Compare columns between defined and actual schemas
   */
  private diffColumns(
    defined: TableSchema,
    actual: IntrospectedTable,
    diffs: SchemaDiff[]
  ): void {
    // Check for missing columns
    for (const col of defined.columns) {
      const actualCol = actual.columns.find(c => c.name === col.name);
      if (!actualCol) {
        diffs.push({
          type: "column_missing",
          severity: "error",
          table: defined.name,
          column: col.name,
          message: `Column '${col.name}' is defined but does not exist in table '${defined.name}'`,
          suggestedAction: `ALTER TABLE ${defined.name} ADD COLUMN ${col.name} ${this.formatType(col)}`,
        });
        continue;
      }

      // Compare column properties
      this.diffColumn(defined.name, col, actualCol, diffs);
    }

    // Check for extra columns
    for (const actualCol of actual.columns) {
      const definedCol = defined.columns.find(c => c.name === actualCol.name);
      if (!definedCol) {
        diffs.push({
          type: "column_extra",
          severity: "warning",
          table: defined.name,
          column: actualCol.name,
          message: `Column '${actualCol.name}' exists in table '${defined.name}' but is not defined in schema`,
          suggestedAction: `Consider adding to schema or ALTER TABLE ${defined.name} DROP COLUMN ${actualCol.name}`,
        });
      }
    }
  }

  /**
   * Compare a single column's properties
   */
  private diffColumn(
    tableName: string,
    defined: ColumnDef,
    actual: IntrospectedColumn,
    diffs: SchemaDiff[]
  ): void {
    // Compare types (normalize for comparison)
    const expectedType = this.normalizeType(this.formatType(defined));
    const actualType = this.normalizeType(actual.type);

    if (!this.typesMatch(expectedType, actualType)) {
      diffs.push({
        type: "column_type_mismatch",
        severity: "error",
        table: tableName,
        column: defined.name,
        expected: expectedType,
        actual: actualType,
        message: `Column '${defined.name}' in table '${tableName}' has type '${actualType}' but expected '${expectedType}'`,
        suggestedAction: `ALTER TABLE ${tableName} MODIFY COLUMN ${defined.name} ${expectedType}`,
      });
    }

    // Compare nullable
    const expectedNullable = defined.nullable !== false;
    if (expectedNullable !== actual.nullable) {
      diffs.push({
        type: "column_nullable_mismatch",
        severity: "warning",
        table: tableName,
        column: defined.name,
        expected: expectedNullable ? "NULL" : "NOT NULL",
        actual: actual.nullable ? "NULL" : "NOT NULL",
        message: `Column '${defined.name}' in table '${tableName}' is ${actual.nullable ? "nullable" : "not nullable"} but expected ${expectedNullable ? "nullable" : "not nullable"}`,
      });
    }
  }

  /**
   * Format a data type for SQL
   */
  private formatType(col: ColumnDef): string {
    const type = col.type;
    if (typeof type === "string") {
      switch (type) {
        case "VARCHAR":
        case "CHAR":
          return `${type}(${col.length ?? 255})`;
        case "DECIMAL":
          return `${type}(${col.precision ?? 10}, ${col.scale ?? 2})`;
        default:
          return type;
      }
    }
    // Complex types
    return "COMPLEX";
  }

  /**
   * Normalize type string for comparison
   */
  private normalizeType(type: string): string {
    return type
      .toUpperCase()
      .replace(/\s+/g, "")
      .replace(/`/g, "")
      .replace(/\(\d+\)/, match => match); // Keep size specs
  }

  /**
   * Check if two types match (with some flexibility)
   */
  private typesMatch(expected: string, actual: string): boolean {
    // Direct match
    if (expected === actual) return true;

    // Handle common equivalences
    const equivalences: [RegExp, RegExp][] = [
      [/^VARCHAR\(\d+\)$/, /^VARCHAR\(\d+\)$/],
      [/^BIGINT$/, /^BIGINT\(\d+\)$/],
      [/^INT$/, /^INT\(\d+\)$/],
      [/^DOUBLE$/, /^DOUBLE$/],
      [/^DECIMAL\(\d+,\s*\d+\)$/, /^DECIMAL\(\d+,\s*\d+\)$/],
    ];

    for (const [expRegex, actRegex] of equivalences) {
      if (expRegex.test(expected) && actRegex.test(actual)) {
        // For VARCHAR, compare sizes
        if (expected.startsWith("VARCHAR") && actual.startsWith("VARCHAR")) {
          const expSize = parseInt(expected.match(/\((\d+)\)/)?.[1] ?? "0", 10);
          const actSize = parseInt(actual.match(/\((\d+)\)/)?.[1] ?? "0", 10);
          return expSize === actSize;
        }
        return true;
      }
    }

    return false;
  }
}

// ============================================================================
// Schema Validator (Convenience Class)
// ============================================================================

export class SchemaValidator {
  private introspector: SchemaIntrospector;
  private differ: SchemaDiffer;

  constructor(client: StarRocksClient) {
    this.introspector = new SchemaIntrospector(client);
    this.differ = new SchemaDiffer();
  }

  /**
   * Validate a schema definition against the database
   */
  async validate(schema: SchemaDefinition): Promise<SchemaDiffResult> {
    const actual = await this.introspector.introspect(schema.database);
    return this.differ.diff(schema, actual);
  }

  /**
   * Introspect the current database schema
   */
  async introspect(database: string): Promise<IntrospectedSchema> {
    return this.introspector.introspect(database);
  }

  /**
   * Print a human-readable diff report
   */
  formatReport(result: SchemaDiffResult): string {
    const lines: string[] = [];

    lines.push(`Schema Validation Report for '${result.database}'`);
    lines.push("=".repeat(50));
    lines.push("");

    if (result.isValid) {
      lines.push("✓ Schema is valid - no errors found");
    } else {
      lines.push("✗ Schema has errors");
    }

    lines.push("");
    lines.push(`Summary: ${result.summary.errors} errors, ${result.summary.warnings} warnings, ${result.summary.info} info`);
    lines.push("");

    if (result.diffs.length > 0) {
      lines.push("Differences:");
      lines.push("-".repeat(50));

      for (const diff of result.diffs) {
        const icon = diff.severity === "error" ? "✗" : diff.severity === "warning" ? "⚠" : "ℹ";
        lines.push(`${icon} [${diff.severity.toUpperCase()}] ${diff.message}`);
        if (diff.suggestedAction) {
          lines.push(`  → ${diff.suggestedAction}`);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }
}
