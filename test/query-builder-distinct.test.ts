import { describe, test, expect } from "bun:test";
import {
  bigint,
  varchar,
  starrocksTable,
  primaryKey,
  hash,
  QueryBuilder,
  eq,
} from "../src/schema/index";

const events = starrocksTable("events", {
  id: bigint("id").notNull(),
  title: varchar("title", { length: 255 }),
  status: varchar("status", { length: 50 }),
}, (t) => ({
  pk: primaryKey(t.id),
  dist: hash(t.id, { buckets: 8 }),
}));

describe("SELECT DISTINCT", () => {
  test("distinct() produces SELECT DISTINCT *", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .distinct()
      .toSQL();
    expect(sql).toContain("SELECT DISTINCT *");
  });

  test("distinct() with select produces SELECT DISTINCT cols", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .select({ title: events.title, status: events.status })
      .distinct()
      .toSQL();
    expect(sql).toContain("SELECT DISTINCT");
    expect(sql).toContain("events.title");
  });

  test("distinct is preserved through chaining", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .distinct()
      .select({ title: events.title })
      .where(eq(events.status, "active"))
      .limit(10)
      .toSQL();
    expect(sql).toContain("SELECT DISTINCT");
    expect(sql).toContain("LIMIT 10");
  });

  test("without distinct uses regular SELECT", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .selectAll()
      .toSQL();
    expect(sql).toContain("SELECT *");
    expect(sql).not.toContain("DISTINCT");
  });

  test("distinct with selectAll", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .selectAll()
      .distinct()
      .toSQL();
    expect(sql).toContain("SELECT DISTINCT *");
  });
});
