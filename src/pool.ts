/**
 * StarRocks-compatible mysql2 pool wrapper.
 *
 * StarRocks uses the MySQL wire protocol but doesn't support all MySQL SQL
 * syntax. This wrapper intercepts queries to patch known incompatibilities
 * so that ORMs like Drizzle work transparently.
 *
 * Current patches:
 * - Replace `default` values in INSERT statements with `null`.
 *   StarRocks rejects the DEFAULT keyword in INSERT ... VALUES.
 */

import type mysql from "mysql2/promise";

/**
 * Regex to match `, default,` or `, default)` in INSERT VALUES clauses.
 * Drizzle emits the literal keyword `default` (case-sensitive, unquoted)
 * for columns that have no provided value and no explicit `.default()`.
 *
 * Word-boundary `\b` prevents matching quoted strings like `'default'`.
 */
const DEFAULT_VALUE_RE = /\bdefault\b/g;

/**
 * Wraps a mysql2 Pool so that all queries flowing through it are
 * patched for StarRocks compatibility. The returned object is a
 * drop-in replacement — same interface, same types.
 */
export function wrapPoolForStarRocks<T extends mysql.Pool>(pool: T): T {
  const origQuery = pool.query.bind(pool);
  const origExecute = pool.execute.bind(pool);

  function patchSql(sql: string): string {
    // Only touch INSERT statements that contain the `default` keyword
    if (sql.startsWith("insert") && DEFAULT_VALUE_RE.test(sql)) {
      // Reset lastIndex since we're reusing the global regex
      DEFAULT_VALUE_RE.lastIndex = 0;
      return sql.replace(DEFAULT_VALUE_RE, "null");
    }
    return sql;
  }

  // Overwrite .query()
  pool.query = function patchedQuery(...args: any[]) {
    if (typeof args[0] === "string") {
      args[0] = patchSql(args[0]);
    } else if (args[0] && typeof args[0] === "object" && "sql" in args[0]) {
      args[0].sql = patchSql(args[0].sql);
    }
    return (origQuery as any)(...args);
  } as any;

  // Overwrite .execute()
  pool.execute = function patchedExecute(...args: any[]) {
    if (typeof args[0] === "string") {
      args[0] = patchSql(args[0]);
    } else if (args[0] && typeof args[0] === "object" && "sql" in args[0]) {
      args[0].sql = patchSql(args[0].sql);
    }
    return (origExecute as any)(...args);
  } as any;

  return pool;
}
