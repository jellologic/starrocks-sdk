/**
 * StarRocks → Drizzle ORM Adapter
 *
 * Converts a `starrocksTable` definition into a standard Drizzle `mysqlTable`
 * so that the StarRocks DDL DSL schemas can serve as the single source of
 * truth for BOTH migration generation AND runtime ORM queries.
 *
 * Usage:
 *   import { toDrizzle } from "@jellologic/starrocks-sdk/schema"
 *   import { user as srUser } from "./schema/auth"
 *   export const user = toDrizzle(srUser)
 */

import {
  mysqlTable,
  varchar as drizzleVarchar,
  char as drizzleChar,
  text as drizzleText,
  boolean as drizzleBoolean,
  datetime as drizzleDatetime,
  date as drizzleDate,
  bigint as drizzleBigint,
  int as drizzleInt,
  smallint as drizzleSmallint,
  tinyint as drizzleTinyint,
  double as drizzleDouble,
  float as drizzleFloat,
  decimal as drizzleDecimal,
  json as drizzleJson,
} from "drizzle-orm/mysql-core";

import type { Table } from "./table";
import type { Column, Columns } from "./columns";

/**
 * Map a single StarRocks Column to a Drizzle mysql-core column builder.
 * Returns the builder (without .notNull / .default — those are applied later).
 */
function mapColumn(col: Column<any, any, any, any>): any {
  const dt = col.dataType.toUpperCase();

  // VARCHAR — if length >= 65533, treat as TEXT (StarRocks TEXT equivalent)
  if (dt.startsWith("VARCHAR")) {
    const length = col.length ?? 255;
    if (length >= 65533) return drizzleText(col.name);
    return drizzleVarchar(col.name, { length });
  }

  // CHAR
  if (dt.startsWith("CHAR")) {
    return drizzleChar(col.name, { length: col.length ?? 1 });
  }

  // STRING (StarRocks alias for VARCHAR(65533))
  if (dt === "STRING") return drizzleText(col.name);

  // BOOLEAN
  if (dt === "BOOLEAN") return drizzleBoolean(col.name);

  // DATETIME
  if (dt === "DATETIME") return drizzleDatetime(col.name);

  // DATE
  if (dt === "DATE") return drizzleDate(col.name);

  // BIGINT
  if (dt === "BIGINT") return drizzleBigint(col.name, { mode: "bigint" });

  // INT
  if (dt === "INT") return drizzleInt(col.name);

  // SMALLINT
  if (dt === "SMALLINT") return drizzleSmallint(col.name);

  // TINYINT
  if (dt === "TINYINT") return drizzleTinyint(col.name);

  // DOUBLE
  if (dt === "DOUBLE") return drizzleDouble(col.name);

  // FLOAT
  if (dt === "FLOAT") return drizzleFloat(col.name);

  // DECIMAL(p, s)
  if (dt.startsWith("DECIMAL")) {
    return drizzleDecimal(col.name, {
      precision: col.precision ?? 10,
      scale: col.scale ?? 0,
    });
  }

  // JSON
  if (dt === "JSON") return drizzleJson(col.name);

  // Fallback: treat unknown types as varchar
  return drizzleVarchar(col.name, { length: 255 });
}

/**
 * Convert a StarRocks table definition (from `starrocksTable()`) into a
 * standard Drizzle ORM `mysqlTable`. The resulting table works with
 * `drizzle()` connections, `drizzleAdapter()` (Better-Auth), and all
 * Drizzle ORM query operations (select, insert, update, delete, eq, etc.).
 *
 * @example
 * ```typescript
 * import { starrocksTable, varchar, primaryKey, hash, toDrizzle } from "@jellologic/starrocks-sdk/schema"
 *
 * const srUser = starrocksTable("user", {
 *   id: varchar("id", { length: 36 }).notNull(),
 *   name: varchar("name", { length: 255 }).notNull(),
 * }, (t) => ({
 *   pk: primaryKey(t.id),
 *   distribution: hash(t.id, { buckets: 4 }),
 * }))
 *
 * // Derive Drizzle table for ORM use
 * export const user = toDrizzle(srUser)
 * ```
 */
export function toDrizzle<TName extends string>(
  table: Table<TName, Columns>,
): any {
  const pkCols = table.config.key?.columns ?? [];
  const cols: Record<string, any> = {};

  for (const [key, col] of Object.entries(
    table.columns as Record<string, Column<any, any, any, any>>,
  )) {
    let dcol = mapColumn(col);
    if (col.isNotNull) dcol = dcol.notNull();
    if (col.defaultValue !== undefined) dcol = dcol.default(col.defaultValue);
    if (pkCols.includes(col.name)) dcol = dcol.primaryKey();
    cols[key] = dcol;
  }

  const tableName = (table as any)._tableName ?? table.name;
  return mysqlTable(tableName, cols);
}
