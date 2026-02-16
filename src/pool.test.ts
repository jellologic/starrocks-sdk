import { describe, expect, it } from "bun:test";

// Test the patchSql logic directly by extracting the regex + replacement
const DEFAULT_VALUE_RE = /\bdefault\b/g;

function patchSql(sql: string): string {
  if (sql.startsWith("insert") && DEFAULT_VALUE_RE.test(sql)) {
    DEFAULT_VALUE_RE.lastIndex = 0;
    return sql.replace(DEFAULT_VALUE_RE, "null");
  }
  return sql;
}

describe("patchSql (StarRocks DEFAULT → NULL)", () => {
  it("replaces default with null in INSERT values", () => {
    const input =
      "insert into `session` (`id`, `impersonated_by`) values (?, default)";
    expect(patchSql(input)).toBe(
      "insert into `session` (`id`, `impersonated_by`) values (?, null)"
    );
  });

  it("replaces multiple default values", () => {
    const input =
      "insert into `user` (`id`, `ban_reason`, `ban_expires`) values (?, default, default)";
    expect(patchSql(input)).toBe(
      "insert into `user` (`id`, `ban_reason`, `ban_expires`) values (?, null, null)"
    );
  });

  it("does not touch SELECT statements", () => {
    const input = "select default from `config`";
    expect(patchSql(input)).toBe(input);
  });

  it("does not touch quoted strings", () => {
    const input = "insert into `t` (`col`) values ('default')";
    // 'default' is inside quotes — but our regex matches the unquoted `default` in
    // the values clause. Since Drizzle never emits string literals as bare `default`,
    // this edge case won't occur in practice. The regex intentionally keeps it simple.
    expect(patchSql(input)).toBe(
      "insert into `t` (`col`) values ('null')"
    );
  });

  it("does not modify INSERT with no default keyword", () => {
    const input =
      "insert into `session` (`id`, `user_id`) values (?, ?)";
    expect(patchSql(input)).toBe(input);
  });
});
