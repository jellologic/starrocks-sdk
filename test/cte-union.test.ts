import { describe, test, expect } from "bun:test";
import {
  // Table & columns
  starrocksTable,
  bigint,
  varchar,
  double,
  int,
  datetime,
  primaryKey,
  hash,

  // Expressions
  gt,
  eq,
  sql,

  // Aggregates
  sum,
  count,

  // Query builder
  QueryBuilder,
  desc,
} from "../src/schema/index";

// Test tables
const sales = starrocksTable("sales", {
  id: bigint("id").notNull(),
  eventId: bigint("event_id").notNull(),
  amount: double("amount"),
  quantity: int("quantity"),
  date: datetime("date"),
}, (t) => ({
  key: primaryKey(t.id),
  distribution: hash(t.id, { buckets: 4 }),
}));

const events = starrocksTable("events", {
  id: bigint("id").notNull(),
  name: varchar("name", { length: 255 }),
  ticketCount: int("ticket_count"),
  category: varchar("category", { length: 100 }),
}, (t) => ({
  key: primaryKey(t.id),
  distribution: hash(t.id, { buckets: 4 }),
}));

const returns = starrocksTable("returns", {
  id: bigint("id").notNull(),
  eventId: bigint("event_id").notNull(),
  amount: double("amount"),
  date: datetime("date"),
}, (t) => ({
  key: primaryKey(t.id),
  distribution: hash(t.id, { buckets: 4 }),
}));

describe("CTEs (WITH clause)", () => {
  test("should generate single CTE", () => {
    const { sql: querySql, values } = new QueryBuilder()
      .with("recent_sales", (qb) =>
        qb.from(sales)
          .select({ eventId: sales.eventId, total: sum(sales.amount) })
          .where(gt(sales.date, "2024-01-01"))
          .groupBy(sales.eventId)
      )
      .selectAll()
      .toSQL();

    expect(querySql).toContain("WITH recent_sales AS (");
    expect(querySql).toContain("SELECT sales.event_id AS eventId, SUM(sales.amount) AS total");
    expect(querySql).toContain("WHERE (sales.date > ?)");
    expect(querySql).toContain("GROUP BY sales.event_id");
    expect(querySql).toContain("SELECT *");
    expect(values).toContain("2024-01-01");
  });

  test("should generate multiple CTEs", () => {
    const { sql: querySql, values } = new QueryBuilder()
      .with("cte1", (qb) =>
        qb.from(sales)
          .select({ eventId: sales.eventId, total: sum(sales.amount) })
          .groupBy(sales.eventId)
      )
      .with("cte2", (qb) =>
        qb.from(events)
          .select({ id: events.id, category: events.category })
          .where(gt(events.ticketCount, 1000))
      )
      .selectAll()
      .toSQL();

    expect(querySql).toContain("WITH cte1 AS (");
    expect(querySql).toContain("cte2 AS (");
    expect(values).toContain(1000);
  });

  test("should support CTE with FROM as sql template", () => {
    const { sql: querySql } = new QueryBuilder()
      .with("my_cte", (qb) =>
        qb.from(sales)
          .select({ eventId: sales.eventId })
      )
      .selectAll()
      .toSQL();

    // The CTE is defined and the main query selects all
    expect(querySql).toContain("WITH my_cte AS (");
    expect(querySql).toContain("SELECT *");
  });

  test("CTE values should come before main query values", () => {
    const { values } = new QueryBuilder()
      .with("filtered", (qb) =>
        qb.from(sales)
          .select({ amount: sales.amount })
          .where(gt(sales.amount, 100))
      )
      .selectAll()
      .toSQL();

    // CTE value (100) should be first
    expect(values[0]).toBe(100);
  });

  test("should chain with other query builder methods", () => {
    const { sql: querySql } = new QueryBuilder()
      .with("top_sales", (qb) =>
        qb.from(sales)
          .select({ eventId: sales.eventId, total: sum(sales.amount) })
          .groupBy(sales.eventId)
      )
      .selectAll()
      .limit(10)
      .offset(5)
      .toSQL();

    expect(querySql).toContain("WITH top_sales AS (");
    expect(querySql).toContain("LIMIT 10");
    expect(querySql).toContain("OFFSET 5");
  });
});

describe("UNION / INTERSECT / EXCEPT", () => {
  describe("UNION", () => {
    test("should generate UNION (distinct)", () => {
      const q1 = new QueryBuilder()
        .from(sales)
        .select({ eventId: sales.eventId });
      const q2 = new QueryBuilder()
        .from(returns)
        .select({ eventId: returns.eventId });

      const { sql: querySql } = q1.union(q2).toSQL();

      expect(querySql).toContain("SELECT sales.event_id");
      expect(querySql).toContain("UNION");
      expect(querySql).toContain("SELECT returns.event_id");
      // Should NOT be UNION ALL
      expect(querySql).not.toContain("UNION ALL");
    });

    test("should generate UNION ALL", () => {
      const q1 = new QueryBuilder()
        .from(sales)
        .select({ eventId: sales.eventId });
      const q2 = new QueryBuilder()
        .from(returns)
        .select({ eventId: returns.eventId });

      const { sql: querySql } = q1.unionAll(q2).toSQL();

      expect(querySql).toContain("UNION ALL");
    });

    test("should combine values from both queries", () => {
      const q1 = new QueryBuilder()
        .from(sales)
        .select({ eventId: sales.eventId })
        .where(gt(sales.amount, 100));
      const q2 = new QueryBuilder()
        .from(returns)
        .select({ eventId: returns.eventId })
        .where(gt(returns.amount, 50));

      const { values } = q1.unionAll(q2).toSQL();

      expect(values).toEqual([100, 50]);
    });
  });

  describe("INTERSECT", () => {
    test("should generate INTERSECT", () => {
      const q1 = new QueryBuilder()
        .from(sales)
        .select({ eventId: sales.eventId });
      const q2 = new QueryBuilder()
        .from(returns)
        .select({ eventId: returns.eventId });

      const { sql: querySql } = q1.intersect(q2).toSQL();

      expect(querySql).toContain("INTERSECT");
    });
  });

  describe("EXCEPT", () => {
    test("should generate EXCEPT", () => {
      const q1 = new QueryBuilder()
        .from(sales)
        .select({ eventId: sales.eventId });
      const q2 = new QueryBuilder()
        .from(returns)
        .select({ eventId: returns.eventId });

      const { sql: querySql } = q1.except(q2).toSQL();

      expect(querySql).toContain("EXCEPT");
    });
  });

  describe("Chaining", () => {
    test("should chain multiple UNION ALLs", () => {
      const q1 = new QueryBuilder()
        .from(sales)
        .select({ id: sales.id });
      const q2 = new QueryBuilder()
        .from(events)
        .select({ id: events.id });
      const q3 = new QueryBuilder()
        .from(returns)
        .select({ id: returns.id });

      const { sql: querySql } = q1.unionAll(q2).unionAll(q3).toSQL();

      // Should have two UNION ALL
      const matches = querySql.match(/UNION ALL/g);
      expect(matches?.length).toBe(2);
    });

    test("should apply ORDER BY/LIMIT to combined result", () => {
      const q1 = new QueryBuilder()
        .from(sales)
        .select({ eventId: sales.eventId });
      const q2 = new QueryBuilder()
        .from(returns)
        .select({ eventId: returns.eventId });

      const { sql: querySql } = q1
        .unionAll(q2)
        .orderBy({ column: sales.eventId, direction: "DESC" })
        .limit(10)
        .toSQL();

      // ORDER BY and LIMIT should come after UNION ALL
      const unionIdx = querySql.indexOf("UNION ALL");
      const orderIdx = querySql.indexOf("ORDER BY");
      const limitIdx = querySql.indexOf("LIMIT");

      expect(orderIdx).toBeGreaterThan(unionIdx);
      expect(limitIdx).toBeGreaterThan(orderIdx);
    });
  });

  describe("Combined CTE + Set Operations", () => {
    test("should use CTEs with UNION", () => {
      const { sql: querySql, values } = new QueryBuilder()
        .with("active_events", (qb) =>
          qb.from(events)
            .select({ id: events.id, category: events.category })
            .where(gt(events.ticketCount, 500))
        )
        .from(sales)
        .select({ eventId: sales.eventId })
        .where(gt(sales.amount, 100))
        .unionAll(
          new QueryBuilder()
            .from(returns)
            .select({ eventId: returns.eventId })
            .where(gt(returns.amount, 50))
        )
        .toSQL();

      expect(querySql).toContain("WITH active_events AS (");
      expect(querySql).toContain("UNION ALL");
      // CTE values come first, then main query, then union query
      expect(values).toEqual([500, 100, 50]);
    });
  });
});
