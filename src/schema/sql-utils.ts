/**
 * SQL Utility Functions for safe SQL generation
 *
 * These utilities help prevent SQL injection by properly escaping
 * values and identifiers before interpolation into SQL strings.
 */

/**
 * Escape a string value for safe SQL interpolation.
 * Handles single quotes and backslashes.
 *
 * @example
 * escapeString("test's value") // Returns: "test''s value"
 */
export function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

/**
 * Escape a string value and wrap it in single quotes for SQL.
 *
 * @example
 * quoteString("test's value") // Returns: "'test''s value'"
 */
export function quoteString(value: string): string {
  return `'${escapeString(value)}'`;
}

/**
 * Escape a double-quoted string (for identifiers or certain values).
 * Handles double quotes and backslashes.
 *
 * @example
 * escapeDoubleQuoted('test"value') // Returns: 'test""value'
 */
export function escapeDoubleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '""');
}

/**
 * Quote an SQL identifier (table name, column name, etc.) with backticks.
 * This is the safest way to handle dynamic identifiers.
 *
 * @example
 * quoteIdentifier("my-table") // Returns: "`my-table`"
 */
export function quoteIdentifier(name: string): string {
  // Escape any backticks in the name by doubling them
  return `\`${name.replace(/`/g, "``")}\``;
}

/**
 * Validate that a string is safe to use as an SQL identifier.
 * Only allows alphanumeric characters, underscores, and hyphens.
 *
 * @throws Error if the identifier contains unsafe characters
 */
export function validateIdentifier(name: string, type: string = "identifier"): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error(
      `Invalid ${type} "${name}": must start with a letter or underscore and contain only alphanumeric characters, underscores, and hyphens`
    );
  }
}

/**
 * Validate and sanitize a partition name.
 */
export function validatePartitionName(name: string): void {
  validateIdentifier(name, "partition name");
}

/**
 * Validate that a refresh interval unit is one of the allowed values.
 */
export function validateIntervalUnit(unit: string): void {
  const allowedUnits = ["SECOND", "MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"];
  if (!allowedUnits.includes(unit.toUpperCase())) {
    throw new Error(
      `Invalid interval unit "${unit}": must be one of ${allowedUnits.join(", ")}`
    );
  }
}

/**
 * Validate that a number is a positive integer.
 */
export function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: must be a positive integer, got ${value}`);
  }
}

/**
 * Safely format a default value for SQL.
 * Handles strings, numbers, booleans, and special SQL keywords.
 */
export function formatDefaultValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? '"true"' : '"false"';
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Check for special SQL expressions (like CURRENT_TIMESTAMP)
    if (/^[A-Z_]+(\(\))?$/.test(value)) {
      return value; // It's a SQL function/keyword
    }
    return quoteString(value);
  }
  throw new Error(`Unsupported default value type: ${typeof value}`);
}
