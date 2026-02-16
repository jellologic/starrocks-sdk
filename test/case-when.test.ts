import { describe, test, expect } from "bun:test";
import {
  // Table & columns
  starrocksTable,
  bigint,
  varchar,
  double,
  int,
  primaryKey,
  hash,

  // Expressions
  gt,
  lt,
  eq,
  sql,

  // CASE/WHEN + Conditionals
  when,
  caseWhen,
  caseExpr,
  ifExpr,
  coalesce,
  ifNull,
  nullIf,

  // Query builder
  QueryBuilder,
} from "../src/schema/index";

// Test table
const products = starrocksTable("products", {
  id: bigint("id").notNull(),
  name: varchar("name", { length: 255 }),
  price: double("price"),
  quantity: int("quantity"),
  status: varchar("status", { length: 50 }),
  category: varchar("category", { length: 100 }),
}, (t) => ({
  key: primaryKey(t.id),
  distribution: hash(t.id, { buckets: 4 }),
}));

describe("CASE/WHEN Expressions", () => {
  describe("caseWhen (searched CASE)", () => {
    test("should generate searched CASE with two WHEN clauses", () => {
      const expr = caseWhen(
        when(gt(products.price, 100), "expensive"),
        when(gt(products.price, 50), "moderate"),
      );

      expect(expr.sql).toBe(
        "CASE WHEN (products.price > ?) THEN ? WHEN (products.price > ?) THEN ? END"
      );
      expect(expr.values).toEqual([100, "expensive", 50, "moderate"]);
    });

    test("should support .else()", () => {
      const expr = caseWhen(
        when(gt(products.price, 100), "expensive"),
        when(gt(products.price, 50), "moderate"),
      ).else("cheap");

      expect(expr.sql).toBe(
        "CASE WHEN (products.price > ?) THEN ? WHEN (products.price > ?) THEN ? ELSE ? END"
      );
      expect(expr.values).toEqual([100, "expensive", 50, "moderate", "cheap"]);
    });

    test("should work with column refs in THEN", () => {
      const expr = caseWhen(
        when(gt(products.price, 100), products.category),
      ).else(products.status);

      expect(expr.sql).toBe(
        "CASE WHEN (products.price > ?) THEN products.category ELSE products.status END"
      );
      expect(expr.values).toEqual([100]);
    });

    test("should work in SELECT", () => {
      const tier = caseWhen(
        when(gt(products.price, 100), "high"),
        when(gt(products.price, 50), "medium"),
      ).else("low");

      const { sql: querySql, values } = new QueryBuilder()
        .from(products)
        .select({
          status: products.status,
          priceTier: tier,
        })
        .toSQL();

      expect(querySql).toContain("CASE WHEN");
      expect(querySql).toContain("AS priceTier");
      expect(values).toEqual([100, "high", 50, "medium", "low"]);
    });
  });

  describe("caseExpr (simple CASE)", () => {
    test("should generate simple CASE expression", () => {
      const expr = caseExpr(
        products.status,
        when("active", 1),
        when("inactive", 0),
      );

      expect(expr.sql).toBe(
        "CASE products.status WHEN ? THEN ? WHEN ? THEN ? END"
      );
      expect(expr.values).toEqual(["active", 1, "inactive", 0]);
    });

    test("should support .else() with simple CASE", () => {
      const expr = caseExpr(
        products.status,
        when("active", 1),
        when("inactive", 0),
      ).else(-1);

      expect(expr.sql).toBe(
        "CASE products.status WHEN ? THEN ? WHEN ? THEN ? ELSE ? END"
      );
      expect(expr.values).toEqual(["active", 1, "inactive", 0, -1]);
    });
  });

  describe("ifExpr", () => {
    test("should generate IF(cond, true, false)", () => {
      const expr = ifExpr(gt(products.price, 0), "positive", "non-positive");

      expect(expr.sql).toBe("IF((products.price > ?), ?, ?)");
      expect(expr.values).toEqual([0, "positive", "non-positive"]);
    });

    test("should work with column refs", () => {
      const expr = ifExpr(gt(products.quantity, 0), products.status, products.category);

      expect(expr.sql).toBe("IF((products.quantity > ?), products.status, products.category)");
      expect(expr.values).toEqual([0]);
    });
  });

  describe("coalesce", () => {
    test("should generate COALESCE with values", () => {
      const expr = coalesce(products.price, 0);

      expect(expr.sql).toBe("COALESCE(products.price, ?)");
      expect(expr.values).toEqual([0]);
    });

    test("should handle multiple column refs", () => {
      const expr = coalesce(products.price, products.quantity, 0);

      expect(expr.sql).toBe("COALESCE(products.price, products.quantity, ?)");
      expect(expr.values).toEqual([0]);
    });
  });

  describe("ifNull", () => {
    test("should generate IFNULL(expr, fallback)", () => {
      const expr = ifNull(products.price, 0);

      expect(expr.sql).toBe("IFNULL(products.price, ?)");
      expect(expr.values).toEqual([0]);
    });

    test("should work with expression fallback", () => {
      const expr = ifNull(products.price, products.quantity);

      expect(expr.sql).toBe("IFNULL(products.price, products.quantity)");
      expect(expr.values).toEqual([]);
    });
  });

  describe("nullIf", () => {
    test("should generate NULLIF(expr, value)", () => {
      const expr = nullIf(products.price, 0);

      expect(expr.sql).toBe("NULLIF(products.price, ?)");
      expect(expr.values).toEqual([0]);
    });

    test("should work with column ref comparison", () => {
      const expr = nullIf(products.price, products.quantity);

      expect(expr.sql).toBe("NULLIF(products.price, products.quantity)");
      expect(expr.values).toEqual([]);
    });
  });

  describe("composition", () => {
    test("should compose CASE inside COALESCE", () => {
      const tier = caseWhen(
        when(gt(products.price, 100), "high"),
      );
      const expr = coalesce(tier, "unknown");

      expect(expr.sql).toContain("COALESCE(CASE WHEN");
      expect(expr.sql).toContain("END, ?)");
    });

    test("should use conditional in WHERE via sql template", () => {
      const expr = ifNull(products.price, 0);
      const { sql: querySql } = new QueryBuilder()
        .from(products)
        .selectAll()
        .where(gt(expr, 10))
        .toSQL();

      expect(querySql).toContain("WHERE (IFNULL(products.price, ?) > ?)");
    });
  });
});
