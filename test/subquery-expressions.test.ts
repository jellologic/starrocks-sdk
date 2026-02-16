import { describe, test, expect } from "bun:test";
import {
  bigint,
  varchar,
  starrocksTable,
  primaryKey,
  hash,
  QueryBuilder,
  exists,
  notExists,
  inSubquery,
  notInSubquery,
  eq,
  gt,
} from "../src/schema/index";

const events = starrocksTable("events", {
  id: bigint("id").notNull(),
  title: varchar("title", { length: 255 }),
  venueId: bigint("venue_id"),
}, (t) => ({
  pk: primaryKey(t.id),
  dist: hash(t.id, { buckets: 8 }),
}));

const venues = starrocksTable("venues", {
  id: bigint("id").notNull(),
  venueName: varchar("venue_name", { length: 255 }),
  capacity: bigint("capacity"),
}, (t) => ({
  pk: primaryKey(t.id),
  dist: hash(t.id, { buckets: 4 }),
}));

describe("EXISTS", () => {
  test("exists produces EXISTS (subquery)", () => {
    const subquery = new QueryBuilder()
      .from(events)
      .select({ id: events.id })
      .where(eq(events.venueId, venues.id));

    const expr = exists(subquery);
    expect(expr.sql).toContain("EXISTS (");
    expect(expr.sql).toContain("SELECT");
  });

  test("notExists produces NOT EXISTS (subquery)", () => {
    const subquery = new QueryBuilder()
      .from(events)
      .select({ id: events.id });

    const expr = notExists(subquery);
    expect(expr.sql).toContain("NOT EXISTS (");
  });

  test("exists in WHERE clause", () => {
    const subquery = new QueryBuilder()
      .from(events)
      .select({ id: events.id })
      .where(eq(events.venueId, venues.id));

    const { sql } = new QueryBuilder()
      .from(venues)
      .selectAll()
      .where(exists(subquery))
      .toSQL();

    expect(sql).toContain("WHERE EXISTS (");
    expect(sql).toContain("SELECT");
  });
});

describe("IN Subquery", () => {
  test("inSubquery produces col IN (subquery)", () => {
    const subquery = new QueryBuilder()
      .from(events)
      .select({ venueId: events.venueId });

    const expr = inSubquery(venues.id, subquery);
    expect(expr.sql).toContain("IN (");
    expect(expr.sql).toContain("venues.id");
  });

  test("notInSubquery produces col NOT IN (subquery)", () => {
    const subquery = new QueryBuilder()
      .from(events)
      .select({ venueId: events.venueId });

    const expr = notInSubquery(venues.id, subquery);
    expect(expr.sql).toContain("NOT IN (");
  });

  test("inSubquery in WHERE clause", () => {
    const subquery = new QueryBuilder()
      .from(events)
      .select({ venueId: events.venueId })
      .where(gt(events.id, 100));

    const { sql, values } = new QueryBuilder()
      .from(venues)
      .selectAll()
      .where(inSubquery(venues.id, subquery))
      .toSQL();

    expect(sql).toContain("WHERE (venues.id IN (");
    expect(values).toContain(100);
  });
});
