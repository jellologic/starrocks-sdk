import { describe, test, expect } from "bun:test";
import {
  bigint,
  varchar,
  double,
  starrocksTable,
  primaryKey,
  hash,
  QueryBuilder,
  eq,
  gt,
  count,
  sum,
  avg,
  sql,
  asc,
  desc,
} from "../src/schema/index";

const events = starrocksTable("events", {
  id: bigint("id").notNull(),
  title: varchar("title", { length: 255 }),
  price: double("price"),
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

describe("FROM subquery", () => {
  test("from() with subquery produces FROM (SELECT ...) AS alias", () => {
    const sub = new QueryBuilder()
      .from(events)
      .select({ venueId: events.venueId, total: sum(events.price) })
      .groupBy(events.venueId)
      .as("venue_totals");

    const { sql } = new QueryBuilder()
      .from(sub)
      .selectAll()
      .toSQL();

    expect(sql).toContain("FROM (");
    expect(sql).toContain("AS venue_totals");
    expect(sql).toContain("SELECT *");
  });

  test("subquery values are propagated", () => {
    const sub = new QueryBuilder()
      .from(events)
      .select({ id: events.id })
      .where(gt(events.price, 100))
      .as("expensive");

    const { sql, values } = new QueryBuilder()
      .from(sub)
      .selectAll()
      .toSQL();

    expect(sql).toContain("FROM (");
    expect(values).toContain(100);
  });
});

describe("execute() without pool", () => {
  test("throws error when no database connection", async () => {
    const qb = new QueryBuilder()
      .from(events)
      .selectAll();

    let error: Error | null = null;
    try {
      await qb.execute();
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error!.message).toContain("No database connection");
  });
});

describe("HAVING clause", () => {
  test("having with count produces HAVING clause", () => {
    const { sql, values } = new QueryBuilder()
      .from(events)
      .select({
        venueId: events.venueId,
        eventCount: count(events.id),
      })
      .groupBy(events.venueId)
      .having(gt(count(), 5))
      .toSQL();

    expect(sql).toContain("GROUP BY events.venue_id");
    expect(sql).toContain("HAVING (COUNT(*) > ?)");
    expect(values).toContain(5);
  });

  test("having with sum produces HAVING clause", () => {
    const { sql, values } = new QueryBuilder()
      .from(events)
      .select({
        venueId: events.venueId,
        totalPrice: sum(events.price),
      })
      .groupBy(events.venueId)
      .having(gt(sum(events.price), 1000))
      .toSQL();

    expect(sql).toContain("HAVING (SUM(events.price) > ?)");
    expect(values).toContain(1000);
  });
});

describe("ORDER BY with aggregates", () => {
  test("orderBy with AggregateExpression", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .select({
        venueId: events.venueId,
        eventCount: count(events.id),
      })
      .groupBy(events.venueId)
      .orderBy(count(events.id))
      .toSQL();

    expect(sql).toContain("ORDER BY COUNT(events.id) ASC");
  });

  test("orderBy with aggregate in direction spec", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .select({
        venueId: events.venueId,
        total: sum(events.price),
      })
      .groupBy(events.venueId)
      .orderBy({ column: sum(events.price), direction: "DESC" })
      .toSQL();

    expect(sql).toContain("ORDER BY SUM(events.price) DESC");
  });

  test("orderBy with column ref and direction", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .selectAll()
      .orderBy({ column: events.id, direction: "DESC" })
      .toSQL();

    expect(sql).toContain("ORDER BY events.id DESC");
  });

  test("orderBy with plain column ref defaults to ASC", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .selectAll()
      .orderBy(events.id)
      .toSQL();

    expect(sql).toContain("ORDER BY events.id ASC");
  });
});

describe("JOIN operations", () => {
  test("INNER JOIN produces correct SQL", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .select({ title: events.title, venueName: venues.venueName })
      .innerJoin(venues, eq(events.venueId, venues.id))
      .toSQL();

    expect(sql).toContain("INNER JOIN `venues` ON (events.venue_id = venues.id)");
  });

  test("LEFT JOIN produces correct SQL", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .selectAll()
      .leftJoin(venues, eq(events.venueId, venues.id))
      .toSQL();

    expect(sql).toContain("LEFT JOIN `venues` ON (events.venue_id = venues.id)");
  });

  test("RIGHT JOIN produces correct SQL", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .selectAll()
      .rightJoin(venues, eq(events.venueId, venues.id))
      .toSQL();

    expect(sql).toContain("RIGHT JOIN `venues` ON (events.venue_id = venues.id)");
  });
});

describe("LIMIT and OFFSET", () => {
  test("LIMIT produces correct SQL", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .selectAll()
      .limit(10)
      .toSQL();

    expect(sql).toContain("LIMIT 10");
  });

  test("OFFSET produces correct SQL", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .selectAll()
      .limit(10)
      .offset(20)
      .toSQL();

    expect(sql).toContain("LIMIT 10");
    expect(sql).toContain("OFFSET 20");
  });
});

describe("Complex queries", () => {
  test("full query with all clauses", () => {
    const { sql, values } = new QueryBuilder()
      .from(events)
      .select({
        venueId: events.venueId,
        eventCount: count(events.id),
        avgPrice: avg(events.price),
      })
      .innerJoin(venues, eq(events.venueId, venues.id))
      .where(gt(events.price, 0))
      .groupBy(events.venueId)
      .having(gt(count(), 3))
      .orderBy({ column: count(events.id), direction: "DESC" })
      .limit(50)
      .offset(10)
      .toSQL();

    expect(sql).toContain("SELECT");
    expect(sql).toContain("FROM `events`");
    expect(sql).toContain("INNER JOIN `venues`");
    expect(sql).toContain("WHERE (events.price > ?)");
    expect(sql).toContain("GROUP BY events.venue_id");
    expect(sql).toContain("HAVING (COUNT(*) > ?)");
    expect(sql).toContain("ORDER BY COUNT(events.id) DESC");
    expect(sql).toContain("LIMIT 50");
    expect(sql).toContain("OFFSET 10");
    expect(values).toContain(0);
    expect(values).toContain(3);
  });
});

describe("Expression support in groupBy / orderBy (#7)", () => {
  test("groupBy accepts Expression", () => {
    const qb = new QueryBuilder()
      .select({
        bucket: sql`FLOOR(\`timestamp\` / 300000) * 300000`,
        volume: sql`SUM(volume)`,
      })
      .from(events)
      .groupBy(sql`FLOOR(\`timestamp\` / 300000) * 300000`);

    const { sql: query } = qb.toSQL();
    expect(query).toContain("GROUP BY FLOOR(`timestamp` / 300000) * 300000");
  });

  test("groupBy accepts mixed ColumnRef and Expression", () => {
    const qb = new QueryBuilder()
      .select({
        venueId: events.venueId,
        bucket: sql`FLOOR(price / 10)`,
        total: sql`COUNT(*)`,
      })
      .from(events)
      .groupBy(events.venueId, sql`FLOOR(price / 10)`);

    const { sql: query } = qb.toSQL();
    expect(query).toContain("GROUP BY events.venue_id, FLOOR(price / 10)");
  });

  test("orderBy accepts Expression", () => {
    const qb = new QueryBuilder()
      .select({ id: events.id })
      .from(events)
      .orderBy(sql`RAND()`);

    const { sql: query } = qb.toSQL();
    expect(query).toContain("ORDER BY RAND() ASC");
  });

  test("asc/desc helpers accept Expression", () => {
    const qb = new QueryBuilder()
      .select({ id: events.id })
      .from(events)
      .orderBy(desc(sql`FLOOR(price / 10)`), asc(sql`id`));

    const { sql: query } = qb.toSQL();
    expect(query).toContain("ORDER BY FLOOR(price / 10) DESC, id ASC");
  });
});
