import { describe, test, expect } from "bun:test";
import {
  bigint,
  varchar,
  datetime,
  double,
  starrocksTable,
  primaryKey,
  hash,
  QueryBuilder,
  // Scalar functions
  substring,
  upper,
  lower,
  concat,
  trim,
  length,
  replace,
  dateFormat,
  dateAdd,
  dateSub,
  datediff,
  now,
  curdate,
  abs,
  ceil,
  floor,
  round,
  cast,
  eq,
} from "../src/schema/index";

const events = starrocksTable("events", {
  id: bigint("id").notNull(),
  title: varchar("title", { length: 255 }),
  price: double("price"),
  createdAt: datetime("created_at"),
}, (t) => ({
  pk: primaryKey(t.id),
  dist: hash(t.id, { buckets: 8 }),
}));

describe("String Functions", () => {
  test("substring", () => {
    const expr = substring(events.title, 1, 5);
    expect(expr.sql).toBe("SUBSTRING(events.title, ?, ?)");
    expect(expr.values).toEqual([1, 5]);
  });

  test("substring without length", () => {
    const expr = substring(events.title, 3);
    expect(expr.sql).toBe("SUBSTRING(events.title, ?)");
    expect(expr.values).toEqual([3]);
  });

  test("upper", () => {
    const expr = upper(events.title);
    expect(expr.sql).toBe("UPPER(events.title)");
    expect(expr.values).toEqual([]);
  });

  test("lower", () => {
    const expr = lower(events.title);
    expect(expr.sql).toBe("LOWER(events.title)");
  });

  test("concat", () => {
    const expr = concat(events.title, " - ", "suffix");
    expect(expr.sql).toBe("CONCAT(events.title, ?, ?)");
    expect(expr.values).toEqual([" - ", "suffix"]);
  });

  test("trim", () => {
    const expr = trim(events.title);
    expect(expr.sql).toBe("TRIM(events.title)");
  });

  test("length", () => {
    const expr = length(events.title);
    expect(expr.sql).toBe("LENGTH(events.title)");
  });

  test("replace", () => {
    const expr = replace(events.title, "old", "new");
    expect(expr.sql).toBe("REPLACE(events.title, ?, ?)");
    expect(expr.values).toEqual(["old", "new"]);
  });
});

describe("Date Functions", () => {
  test("dateFormat", () => {
    const expr = dateFormat(events.createdAt, "%Y-%m-%d");
    expect(expr.sql).toBe("DATE_FORMAT(events.created_at, ?)");
    expect(expr.values).toEqual(["%Y-%m-%d"]);
  });

  test("dateAdd", () => {
    const expr = dateAdd(events.createdAt, 7, "DAY");
    expect(expr.sql).toBe("DATE_ADD(events.created_at, INTERVAL 7 DAY)");
    expect(expr.values).toEqual([]);
  });

  test("dateSub", () => {
    const expr = dateSub(events.createdAt, 1, "MONTH");
    expect(expr.sql).toBe("DATE_SUB(events.created_at, INTERVAL 1 MONTH)");
  });

  test("datediff", () => {
    const expr = datediff(now(), events.createdAt);
    expect(expr.sql).toBe("DATEDIFF(NOW(), events.created_at)");
  });

  test("now", () => {
    const expr = now();
    expect(expr.sql).toBe("NOW()");
    expect(expr.values).toEqual([]);
  });

  test("curdate", () => {
    const expr = curdate();
    expect(expr.sql).toBe("CURDATE()");
    expect(expr.values).toEqual([]);
  });
});

describe("Math Functions", () => {
  test("abs", () => {
    const expr = abs(events.price);
    expect(expr.sql).toBe("ABS(events.price)");
  });

  test("ceil", () => {
    const expr = ceil(events.price);
    expect(expr.sql).toBe("CEIL(events.price)");
  });

  test("floor", () => {
    const expr = floor(events.price);
    expect(expr.sql).toBe("FLOOR(events.price)");
  });

  test("round with no decimals", () => {
    const expr = round(events.price);
    expect(expr.sql).toBe("ROUND(events.price)");
  });

  test("round with decimals", () => {
    const expr = round(events.price, 2);
    expect(expr.sql).toBe("ROUND(events.price, ?)");
    expect(expr.values).toEqual([2]);
  });
});

describe("Cast Function", () => {
  test("cast to VARCHAR", () => {
    const expr = cast(events.id, "VARCHAR");
    expect(expr.sql).toBe("CAST(events.id AS VARCHAR)");
  });

  test("cast to INT", () => {
    const expr = cast(events.title, "INT");
    expect(expr.sql).toBe("CAST(events.title AS INT)");
  });

  test("cast to DATETIME", () => {
    const expr = cast("2024-01-01", "DATETIME");
    expect(expr.sql).toBe("CAST(? AS DATETIME)");
    expect(expr.values).toEqual(["2024-01-01"]);
  });

  test("cast with expression input", () => {
    const expr = cast(now(), "VARCHAR");
    expect(expr.sql).toBe("CAST(NOW() AS VARCHAR)");
    expect(expr.values).toEqual([]);
  });

  test("cast with nested function", () => {
    const expr = cast(round(events.price, 0), "INT");
    expect(expr.sql).toBe("CAST(ROUND(events.price, ?) AS INT)");
    expect(expr.values).toEqual([0]);
  });
});

describe("Function Composition", () => {
  test("functions compose in SELECT", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .select({
        upperTitle: upper(events.title),
        daysSince: datediff(now(), events.createdAt),
        roundedPrice: round(events.price, 2),
      })
      .toSQL();

    expect(sql).toContain("UPPER(events.title) AS upperTitle");
    expect(sql).toContain("DATEDIFF(NOW(), events.created_at) AS daysSince");
    expect(sql).toContain("ROUND(events.price, ?) AS roundedPrice");
  });

  test("functions compose in WHERE", () => {
    const { sql } = new QueryBuilder()
      .from(events)
      .selectAll()
      .where(eq(upper(events.title), "TEST"))
      .toSQL();

    expect(sql).toContain("WHERE (UPPER(events.title) = ?)");
  });

  test("nested function composition", () => {
    const expr = upper(trim(events.title));
    expect(expr.sql).toBe("UPPER(TRIM(events.title))");
  });
});
