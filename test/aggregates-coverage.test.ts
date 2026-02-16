import { describe, test, expect } from "bun:test";
import {
  bigint,
  varchar,
  double,
  starrocksTable,
  primaryKey,
  hash,
  count,
  countDistinct,
  sum,
  avg,
  min,
  max,
  stddev,
  variance,
  approxCountDistinct,
  hllUnionAgg,
  bitmapUnion,
  bitmapCount,
  groupConcat,
  arrayAgg,
} from "../src/schema/index";

const events = starrocksTable("events", {
  id: bigint("id").notNull(),
  title: varchar("title", { length: 255 }),
  price: double("price"),
  venueId: bigint("venue_id"),
  hllCol: bigint("hll_col"),
  bitmapCol: bigint("bitmap_col"),
}, (t) => ({
  pk: primaryKey(t.id),
  dist: hash(t.id, { buckets: 8 }),
}));

describe("Basic Aggregates", () => {
  test("count() produces COUNT(*)", () => {
    const expr = count();
    expect(expr.sql).toBe("COUNT(*)");
    expect(expr.values).toEqual([]);
    expect(expr._isAggregate).toBe(true);
  });

  test("count(column) produces COUNT(col)", () => {
    const expr = count(events.id);
    expect(expr.sql).toBe("COUNT(events.id)");
  });

  test("countDistinct produces COUNT(DISTINCT col)", () => {
    const expr = countDistinct(events.venueId);
    expect(expr.sql).toBe("COUNT(DISTINCT events.venue_id)");
    expect(expr.values).toEqual([]);
  });

  test("countDistinct with alias", () => {
    const expr = countDistinct(events.venueId).as("uniqueVenues");
    expect(expr.sql).toBe("COUNT(DISTINCT events.venue_id) AS uniqueVenues");
    expect(expr.alias).toBe("uniqueVenues");
  });

  test("sum produces SUM(col)", () => {
    const expr = sum(events.price);
    expect(expr.sql).toBe("SUM(events.price)");
  });

  test("avg produces AVG(col)", () => {
    const expr = avg(events.price);
    expect(expr.sql).toBe("AVG(events.price)");
  });

  test("min produces MIN(col)", () => {
    const expr = min(events.price);
    expect(expr.sql).toBe("MIN(events.price)");
  });

  test("max produces MAX(col)", () => {
    const expr = max(events.price);
    expect(expr.sql).toBe("MAX(events.price)");
  });
});

describe("Statistical Aggregates", () => {
  test("stddev produces STDDEV(col)", () => {
    const expr = stddev(events.price);
    expect(expr.sql).toBe("STDDEV(events.price)");
    expect(expr._isAggregate).toBe(true);
  });

  test("variance produces VARIANCE(col)", () => {
    const expr = variance(events.price);
    expect(expr.sql).toBe("VARIANCE(events.price)");
    expect(expr._isAggregate).toBe(true);
  });
});

describe("StarRocks-Specific Aggregates", () => {
  test("approxCountDistinct produces APPROX_COUNT_DISTINCT(col)", () => {
    const expr = approxCountDistinct(events.id);
    expect(expr.sql).toBe("APPROX_COUNT_DISTINCT(events.id)");
    expect(expr._isAggregate).toBe(true);
  });

  test("hllUnionAgg produces HLL_UNION_AGG(col)", () => {
    const expr = hllUnionAgg(events.hllCol);
    expect(expr.sql).toBe("HLL_UNION_AGG(events.hll_col)");
  });

  test("bitmapUnion produces BITMAP_UNION(col)", () => {
    const expr = bitmapUnion(events.bitmapCol);
    expect(expr.sql).toBe("BITMAP_UNION(events.bitmap_col)");
  });

  test("bitmapCount produces BITMAP_COUNT(BITMAP_UNION(col))", () => {
    const expr = bitmapCount(events.bitmapCol);
    expect(expr.sql).toBe("BITMAP_COUNT(BITMAP_UNION(events.bitmap_col))");
    expect(expr._isAggregate).toBe(true);
  });

  test("bitmapCount with alias", () => {
    const expr = bitmapCount(events.bitmapCol).as("uniqueCount");
    expect(expr.sql).toBe("BITMAP_COUNT(BITMAP_UNION(events.bitmap_col)) AS uniqueCount");
    expect(expr.alias).toBe("uniqueCount");
  });

  test("groupConcat with default separator", () => {
    const expr = groupConcat(events.title);
    expect(expr.sql).toBe("GROUP_CONCAT(events.title, ',')");
    expect(expr._isAggregate).toBe(true);
  });

  test("groupConcat with custom separator", () => {
    const expr = groupConcat(events.title, " | ");
    expect(expr.sql).toBe("GROUP_CONCAT(events.title, ' | ')");
  });

  test("groupConcat with alias", () => {
    const expr = groupConcat(events.title, ",").as("allTitles");
    expect(expr.sql).toBe("GROUP_CONCAT(events.title, ',') AS allTitles");
  });

  test("groupConcat with separator containing single quote", () => {
    const expr = groupConcat(events.title, "it's");
    expect(expr.sql).toBe("GROUP_CONCAT(events.title, 'it''s')");
  });

  test("arrayAgg produces ARRAY_AGG(col)", () => {
    const expr = arrayAgg(events.title);
    expect(expr.sql).toBe("ARRAY_AGG(events.title)");
    expect(expr._isAggregate).toBe(true);
  });
});

describe("Aggregate aliasing", () => {
  test("count with alias", () => {
    const expr = count().as("total");
    expect(expr.sql).toBe("COUNT(*) AS total");
    expect(expr.alias).toBe("total");
  });

  test("sum with alias", () => {
    const expr = sum(events.price).as("totalPrice");
    expect(expr.sql).toBe("SUM(events.price) AS totalPrice");
  });

  test("avg with alias", () => {
    const expr = avg(events.price).as("avgPrice");
    expect(expr.sql).toBe("AVG(events.price) AS avgPrice");
  });
});
