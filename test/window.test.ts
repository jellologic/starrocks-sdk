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

  // Aggregates
  sum,
  count,
  avg,
  min,
  max,

  // Query builder
  QueryBuilder,
  desc,

  // Window functions
  rowNumber,
  rank,
  denseRank,
  ntile,
  lag,
  lead,
  firstValue,
  lastValue,
  partitionBy,
  windowOrderBy,
  rows,
  range,
  unboundedPreceding,
  currentRow,
  unboundedFollowing,
  preceding,
  following,
} from "../src/schema/index";

// Test table
const sales = starrocksTable("sales", {
  id: bigint("id").notNull(),
  eventId: bigint("event_id").notNull(),
  dept: varchar("dept", { length: 100 }),
  amount: double("amount"),
  quantity: int("quantity"),
  price: double("price"),
  crawledAt: datetime("crawled_at"),
}, (t) => ({
  key: primaryKey(t.id),
  distribution: hash(t.id, { buckets: 4 }),
}));

describe("Window Functions", () => {
  describe("Ranking functions", () => {
    test("ROW_NUMBER() with partition and order", () => {
      const expr = rowNumber().over(
        partitionBy(sales.dept),
        windowOrderBy({ column: sales.amount, direction: "DESC" })
      );

      expect(expr.sql).toBe(
        "ROW_NUMBER() OVER(PARTITION BY sales.dept ORDER BY sales.amount DESC)"
      );
      expect(expr.values).toEqual([]);
      expect(expr._isWindow).toBe(true);
    });

    test("RANK() with order only", () => {
      const expr = rank().over(
        windowOrderBy({ column: sales.amount, direction: "DESC" })
      );

      expect(expr.sql).toBe("RANK() OVER(ORDER BY sales.amount DESC)");
    });

    test("DENSE_RANK()", () => {
      const expr = denseRank().over(
        partitionBy(sales.eventId),
        windowOrderBy(sales.crawledAt)
      );

      expect(expr.sql).toBe(
        "DENSE_RANK() OVER(PARTITION BY sales.event_id ORDER BY sales.crawled_at ASC)"
      );
    });

    test("NTILE(4)", () => {
      const expr = ntile(4).over(
        windowOrderBy({ column: sales.amount, direction: "DESC" })
      );

      expect(expr.sql).toBe("NTILE(4) OVER(ORDER BY sales.amount DESC)");
    });
  });

  describe("Value functions", () => {
    test("LAG(col, offset, default)", () => {
      const expr = lag(sales.price, 1, 0).over(
        partitionBy(sales.eventId),
        windowOrderBy(sales.crawledAt)
      );

      expect(expr.sql).toBe(
        "LAG(sales.price, 1, ?) OVER(PARTITION BY sales.event_id ORDER BY sales.crawled_at ASC)"
      );
      expect(expr.values).toEqual([0]);
    });

    test("LAG(col) with no offset/default", () => {
      const expr = lag(sales.price).over(
        windowOrderBy(sales.crawledAt)
      );

      expect(expr.sql).toBe("LAG(sales.price) OVER(ORDER BY sales.crawled_at ASC)");
      expect(expr.values).toEqual([]);
    });

    test("LEAD(col, offset)", () => {
      const expr = lead(sales.price, 1).over(
        partitionBy(sales.eventId),
        windowOrderBy(sales.crawledAt)
      );

      expect(expr.sql).toBe(
        "LEAD(sales.price, 1) OVER(PARTITION BY sales.event_id ORDER BY sales.crawled_at ASC)"
      );
    });

    test("FIRST_VALUE(col)", () => {
      const expr = firstValue(sales.price).over(
        partitionBy(sales.eventId),
        windowOrderBy(sales.crawledAt)
      );

      expect(expr.sql).toBe(
        "FIRST_VALUE(sales.price) OVER(PARTITION BY sales.event_id ORDER BY sales.crawled_at ASC)"
      );
    });

    test("LAST_VALUE(col) with frame", () => {
      const expr = lastValue(sales.price).over(
        partitionBy(sales.eventId),
        windowOrderBy(sales.crawledAt),
        rows(unboundedPreceding(), unboundedFollowing())
      );

      expect(expr.sql).toBe(
        "LAST_VALUE(sales.price) OVER(PARTITION BY sales.event_id ORDER BY sales.crawled_at ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)"
      );
    });
  });

  describe("Window frames", () => {
    test("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW", () => {
      const expr = sum(sales.amount).over(
        partitionBy(sales.eventId),
        windowOrderBy(sales.crawledAt),
        rows(unboundedPreceding(), currentRow())
      );

      expect(expr.sql).toContain(
        "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"
      );
    });

    test("ROWS BETWEEN N PRECEDING AND N FOLLOWING", () => {
      const expr = avg(sales.price).over(
        windowOrderBy(sales.crawledAt),
        rows(preceding(3), following(3))
      );

      expect(expr.sql).toContain("ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING");
    });

    test("RANGE frame", () => {
      const expr = sum(sales.amount).over(
        windowOrderBy(sales.crawledAt),
        range(unboundedPreceding(), currentRow())
      );

      expect(expr.sql).toContain(
        "RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"
      );
    });
  });

  describe("Aggregate as window", () => {
    test("SUM() OVER()", () => {
      const expr = sum(sales.amount).over(
        partitionBy(sales.eventId),
        windowOrderBy(sales.crawledAt)
      );

      expect(expr.sql).toBe(
        "SUM(sales.amount) OVER(PARTITION BY sales.event_id ORDER BY sales.crawled_at ASC)"
      );
      expect(expr._isWindow).toBe(true);
    });

    test("COUNT() OVER()", () => {
      const expr = count().over(
        partitionBy(sales.dept)
      );

      expect(expr.sql).toBe("COUNT(*) OVER(PARTITION BY sales.dept)");
    });

    test("AVG() OVER() with frame", () => {
      const expr = avg(sales.price).over(
        windowOrderBy(sales.crawledAt),
        rows(preceding(5), currentRow())
      );

      expect(expr.sql).toBe(
        "AVG(sales.price) OVER(ORDER BY sales.crawled_at ASC ROWS BETWEEN 5 PRECEDING AND CURRENT ROW)"
      );
    });

    test("MIN/MAX OVER()", () => {
      const minExpr = min(sales.price).over(partitionBy(sales.eventId));
      const maxExpr = max(sales.price).over(partitionBy(sales.eventId));

      expect(minExpr.sql).toBe("MIN(sales.price) OVER(PARTITION BY sales.event_id)");
      expect(maxExpr.sql).toBe("MAX(sales.price) OVER(PARTITION BY sales.event_id)");
    });
  });

  describe("Integration with QueryBuilder", () => {
    test("should use window functions in SELECT", () => {
      const { sql, values } = new QueryBuilder()
        .from(sales)
        .select({
          eventId: sales.eventId,
          price: sales.price,
          rn: rowNumber().over(
            partitionBy(sales.eventId),
            windowOrderBy({ column: sales.price, direction: "DESC" })
          ),
          prevPrice: lag(sales.price, 1, 0).over(
            partitionBy(sales.eventId),
            windowOrderBy(sales.crawledAt)
          ),
        })
        .toSQL();

      expect(sql).toContain("ROW_NUMBER() OVER(");
      expect(sql).toContain("AS rn");
      expect(sql).toContain("LAG(sales.price, 1, ?) OVER(");
      expect(sql).toContain("AS prevPrice");
      expect(values).toEqual([0]);
    });

    test("should combine window functions with regular columns", () => {
      const { sql } = new QueryBuilder()
        .from(sales)
        .select({
          dept: sales.dept,
          amount: sales.amount,
          runningTotal: sum(sales.amount).over(
            partitionBy(sales.dept),
            windowOrderBy(sales.crawledAt),
            rows(unboundedPreceding(), currentRow())
          ),
        })
        .toSQL();

      expect(sql).toContain("sales.dept");
      expect(sql).toContain("sales.amount");
      expect(sql).toContain("SUM(sales.amount) OVER(");
      expect(sql).toContain("AS runningTotal");
    });
  });
});
