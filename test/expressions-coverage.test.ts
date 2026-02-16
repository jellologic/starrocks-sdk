import { describe, test, expect } from "bun:test";
import {
  bigint,
  varchar,
  double,
  starrocksTable,
  primaryKey,
  hash,
  // Expression functions
  eq,
  ne,
  gt,
  lt,
  gte,
  lte,
  and,
  or,
  not,
  like,
  ilike,
  isNull,
  isNotNull,
  inArray,
  notInArray,
  between,
  sql,
  // Conditional functions
  coalesce,
  ifNull,
  nullIf,
  ifExpr,
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

describe("Logical Operators", () => {
  test("not() wraps expression in NOT", () => {
    const expr = not(eq(events.id, 1n));
    expect(expr.sql).toBe("NOT ((events.id = ?))");
    expect(expr.values).toEqual([1n]);
  });

  test("not() with compound expression", () => {
    const expr = not(and(gt(events.id, 1n), lt(events.id, 10n)));
    expect(expr.sql).toBe("NOT (((events.id > ?) AND (events.id < ?)))");
    expect(expr.values).toEqual([1n, 10n]);
  });

  test("and() with empty array returns TRUE", () => {
    const expr = and();
    expect(expr.sql).toBe("TRUE");
    expect(expr.values).toEqual([]);
  });

  test("and() with single condition returns it unchanged", () => {
    const inner = eq(events.id, 1n);
    const expr = and(inner);
    expect(expr.sql).toBe(inner.sql);
  });

  test("or() with empty array returns FALSE", () => {
    const expr = or();
    expect(expr.sql).toBe("FALSE");
    expect(expr.values).toEqual([]);
  });

  test("or() with single condition returns it unchanged", () => {
    const inner = eq(events.id, 1n);
    const expr = or(inner);
    expect(expr.sql).toBe(inner.sql);
  });
});

describe("LIKE and ILIKE", () => {
  test("like() produces LIKE expression", () => {
    const expr = like(events.title, "%concert%");
    expect(expr.sql).toBe("(events.title LIKE ?)");
    expect(expr.values).toEqual(["%concert%"]);
  });

  test("like() with SQL wildcards", () => {
    const expr = like(events.title, "test\\_value");
    expect(expr.sql).toBe("(events.title LIKE ?)");
    expect(expr.values).toEqual(["test\\_value"]);
  });

  test("ilike() produces case-insensitive LIKE", () => {
    const expr = ilike(events.title, "%Concert%");
    expect(expr.sql).toBe("(LOWER(events.title) LIKE LOWER(?))");
    expect(expr.values).toEqual(["%Concert%"]);
  });
});

describe("NULL checks", () => {
  test("isNull() produces IS NULL", () => {
    const expr = isNull(events.title);
    expect(expr.sql).toBe("(events.title IS NULL)");
    expect(expr.values).toEqual([]);
  });

  test("isNotNull() produces IS NOT NULL", () => {
    const expr = isNotNull(events.title);
    expect(expr.sql).toBe("(events.title IS NOT NULL)");
    expect(expr.values).toEqual([]);
  });

  test("isNull() with bigint column", () => {
    const expr = isNull(events.venueId);
    expect(expr.sql).toBe("(events.venue_id IS NULL)");
  });
});

describe("IN array edge cases", () => {
  test("inArray with empty array returns FALSE", () => {
    const expr = inArray(events.id, []);
    expect(expr.sql).toBe("FALSE");
    expect(expr.values).toEqual([]);
  });

  test("notInArray with values", () => {
    const expr = notInArray(events.id, [1n, 2n, 3n]);
    expect(expr.sql).toBe("(events.id NOT IN (?, ?, ?))");
    expect(expr.values).toEqual([1n, 2n, 3n]);
  });

  test("notInArray with empty array returns TRUE", () => {
    const expr = notInArray(events.id, []);
    expect(expr.sql).toBe("TRUE");
    expect(expr.values).toEqual([]);
  });

  test("inArray with single value", () => {
    const expr = inArray(events.id, [42n]);
    expect(expr.sql).toBe("(events.id IN (?))");
    expect(expr.values).toEqual([42n]);
  });
});

describe("BETWEEN", () => {
  test("between produces correct SQL", () => {
    const expr = between(events.price, 10.0, 100.0);
    expect(expr.sql).toBe("(events.price BETWEEN ? AND ?)");
    expect(expr.values).toEqual([10.0, 100.0]);
  });
});

describe("Comparison operators", () => {
  test("ne produces !=", () => {
    const expr = ne(events.id, 5n);
    expect(expr.sql).toBe("(events.id != ?)");
    expect(expr.values).toEqual([5n]);
  });

  test("gte produces >=", () => {
    const expr = gte(events.price, 100.0);
    expect(expr.sql).toBe("(events.price >= ?)");
  });

  test("lte produces <=", () => {
    const expr = lte(events.price, 500.0);
    expect(expr.sql).toBe("(events.price <= ?)");
  });

  test("eq with two column refs (for joins)", () => {
    const other = starrocksTable("venues", {
      id: bigint("id").notNull(),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 4 }),
    }));

    const expr = eq(events.venueId, other.id);
    expect(expr.sql).toBe("(events.venue_id = venues.id)");
    expect(expr.values).toEqual([]);
  });
});

describe("SQL template tag", () => {
  test("embeds expressions with values", () => {
    const condition = gt(events.id, 5n);
    const expr = sql`${condition} AND ${lt(events.id, 10n)}`;
    expect(expr.sql).toBe("(events.id > ?) AND (events.id < ?)");
    expect(expr.values).toEqual([5n, 10n]);
  });

  test("embeds column refs as identifiers", () => {
    const expr = sql`UPPER(${events.title})`;
    expect(expr.sql).toBe("UPPER(events.title)");
    expect(expr.values).toEqual([]);
  });

  test("embeds literal values as params", () => {
    const expr = sql`NOW() - INTERVAL ${7} DAY`;
    expect(expr.sql).toBe("NOW() - INTERVAL ? DAY");
    expect(expr.values).toEqual([7]);
  });

  test("combines column refs and literals", () => {
    const expr = sql`${events.price} * ${1.1}`;
    expect(expr.sql).toBe("events.price * ?");
    expect(expr.values).toEqual([1.1]);
  });
});

describe("Conditional functions", () => {
  test("coalesce with column and fallback", () => {
    const expr = coalesce(events.title, "unknown");
    expect(expr.sql).toBe("COALESCE(events.title, ?)");
    expect(expr.values).toEqual(["unknown"]);
  });

  test("coalesce with multiple values", () => {
    const expr = coalesce(events.title, events.title, "fallback");
    expect(expr.sql).toBe("COALESCE(events.title, events.title, ?)");
    expect(expr.values).toEqual(["fallback"]);
  });

  test("ifNull produces IFNULL", () => {
    const expr = ifNull(events.price, 0);
    expect(expr.sql).toBe("IFNULL(events.price, ?)");
    expect(expr.values).toEqual([0]);
  });

  test("nullIf produces NULLIF", () => {
    const expr = nullIf(events.price, 0);
    expect(expr.sql).toBe("NULLIF(events.price, ?)");
    expect(expr.values).toEqual([0]);
  });

  test("ifExpr produces IF()", () => {
    const expr = ifExpr(gt(events.price, 100), "expensive", "cheap");
    expect(expr.sql).toBe("IF((events.price > ?), ?, ?)");
    expect(expr.values).toEqual([100, "expensive", "cheap"]);
  });
});
