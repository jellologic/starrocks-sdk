import { describe, test, expect } from "bun:test";
import {
  // Column types
  bigint,
  varchar,
  datetime,
  double,
  array,
  int,
  smallint,
  tinyint,
  largeint,
  float,
  decimal,
  char,
  string,
  date,
  boolean,
  json,
  map,
  struct,
  hll,
  bitmap,

  // Table
  starrocksTable,
  primaryKey,
  duplicateKey,
  aggregateKey,
  hash,
  random,
  rangePartition,
  listPartition,
  generateCreateTableSQL,

  // Expressions
  eq,
  gt,
  lt,
  and,
  or,
  not,
  inArray,
  between,
  like,
  sql,

  // Aggregates
  count,
  sum,
  avg,
  min,
  max,
  countDistinct,

  // Query builder
  QueryBuilder,
  desc,
} from "../src/schema/index";

describe("Schema Definitions", () => {
  describe("Column Types", () => {
    test("should create bigint column", () => {
      const col = bigint("id");
      expect(col.name).toBe("id");
      expect(col.dataType).toBe("BIGINT");
      expect(col.isNotNull).toBe(false);
    });

    test("should create varchar column with length", () => {
      const col = varchar("name", { length: 255 });
      expect(col.name).toBe("name");
      expect(col.dataType).toBe("VARCHAR(255)");
      expect(col.length).toBe(255);
    });

    test("should support notNull modifier", () => {
      const col = bigint("id").notNull();
      expect(col.isNotNull).toBe(true);
    });

    test("should support default modifier", () => {
      const col = varchar("status", { length: 50 }).default("active");
      expect(col.defaultValue).toBe("active");
    });

    test("should support aggregate modifier", () => {
      const col = bigint("count").aggregate("SUM");
      expect(col.aggregateFunc).toBe("SUM");
    });

    test("should chain modifiers", () => {
      const col = bigint("id").notNull().default(0n);
      expect(col.isNotNull).toBe(true);
      expect(col.defaultValue).toBe(0n);
    });

    test("should create array column", () => {
      const col = array("tags", varchar("", { length: 100 }));
      expect(col.dataType).toBe("ARRAY<VARCHAR(100)>");
    });
  });

  describe("Table Definitions", () => {
    test("should create basic table", () => {
      const events = starrocksTable("events", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
        createdAt: datetime("created_at"),
      });

      // Use getTableName() when table has a column named "name"
      expect(events.getTableName()).toBe("events");
      expect(events.columns.id.dataType).toBe("BIGINT");
      expect(events.columns.name.dataType).toBe("VARCHAR(255)");
    });

    test("should create table with PRIMARY KEY", () => {
      const events = starrocksTable(
        "events",
        {
          id: bigint("id").notNull(),
          name: varchar("name", { length: 255 }),
        },
        (t) => ({
          key: primaryKey(t.id),
          distribution: hash(t.id, { buckets: 8 }),
        })
      );

      expect(events.config.key?.type).toBe("PRIMARY");
      expect(events.config.key?.columns).toEqual(["id"]);
      expect(events.config.distribution?.type).toBe("HASH");
    });

    test("should create table with DUPLICATE KEY", () => {
      const logs = starrocksTable(
        "logs",
        {
          timestamp: datetime("timestamp"),
          message: varchar("message", { length: 1000 }),
        },
        (t) => ({
          key: duplicateKey(t.timestamp),
          distribution: random({ buckets: 4 }),
        })
      );

      expect(logs.config.key?.type).toBe("DUPLICATE");
      expect(logs.config.distribution?.type).toBe("RANDOM");
    });

    test("should create table with AGGREGATE KEY", () => {
      const stats = starrocksTable(
        "daily_stats",
        {
          date: datetime("date"),
          venueId: bigint("venue_id"),
          eventCount: bigint("event_count").aggregate("SUM"),
        },
        (t) => ({
          key: aggregateKey(t.date, t.venueId),
          distribution: hash(t.venueId, { buckets: 4 }),
        })
      );

      expect(stats.config.key?.type).toBe("AGGREGATE");
      expect(stats.config.key?.columns).toEqual(["date", "venue_id"]);
    });

    test("should create table with range partition", () => {
      const events = starrocksTable(
        "events",
        {
          id: bigint("id").notNull(),
          createdAt: datetime("created_at"),
        },
        (t) => ({
          key: primaryKey(t.id),
          distribution: hash(t.id, { buckets: 8 }),
          partition: rangePartition(t.createdAt, { interval: "DAY" }),
        })
      );

      expect(events.config.partition?.type).toBe("RANGE");
      expect((events.config.partition as any).column).toBe("created_at");
    });

    test("should create table with list partition", () => {
      const events = starrocksTable(
        "events",
        {
          id: bigint("id").notNull(),
          region: varchar("region", { length: 50 }),
        },
        (t) => ({
          key: primaryKey(t.id),
          distribution: hash(t.id, { buckets: 8 }),
          partition: listPartition(t.region, {
            us: ["us-east", "us-west"],
            eu: ["eu-west", "eu-central"],
          }),
        })
      );

      expect(events.config.partition?.type).toBe("LIST");
    });

    test("should expose column references", () => {
      const events = starrocksTable("events", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
      });

      // Column refs should be accessible
      expect((events as any).id.fullName).toBe("events.id");
      expect((events as any).name.fullName).toBe("events.name");
    });
  });

  describe("SQL Generation", () => {
    test("should generate CREATE TABLE SQL", () => {
      const events = starrocksTable(
        "events",
        {
          id: bigint("id").notNull(),
          name: varchar("name", { length: 255 }),
          price: double("price"),
        },
        (t) => ({
          key: primaryKey(t.id),
          distribution: hash(t.id, { buckets: 8 }),
          properties: { replication_num: 1 },
        })
      );

      const sql = generateCreateTableSQL(events);

      // All identifiers are quoted with backticks for safety (reserved word handling)
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS `events`");
      expect(sql).toContain("`id` BIGINT NOT NULL");
      expect(sql).toContain("`name` VARCHAR(255)");
      expect(sql).toContain("`price` DOUBLE");
      expect(sql).toContain("PRIMARY KEY (`id`)");
      expect(sql).toContain("DISTRIBUTED BY HASH(`id`) BUCKETS 8");
      expect(sql).toContain('PROPERTIES ("replication_num" = "1")');
    });
  });
});

describe("Expressions", () => {
  const events = starrocksTable("events", {
    id: bigint("id").notNull(),
    name: varchar("name", { length: 255 }),
    price: double("price"),
    createdAt: datetime("created_at"),
  });

  describe("Comparison", () => {
    test("should create eq expression", () => {
      const expr = eq((events as any).id, 1n);
      expect(expr.sql).toBe("(events.id = ?)");
      expect(expr.values).toEqual([1n]);
    });

    test("should create gt expression", () => {
      const expr = gt((events as any).price, 100);
      expect(expr.sql).toBe("(events.price > ?)");
      expect(expr.values).toEqual([100]);
    });

    test("should create lt expression", () => {
      const expr = lt((events as any).price, 1000);
      expect(expr.sql).toBe("(events.price < ?)");
      expect(expr.values).toEqual([1000]);
    });

    test("should compare two columns", () => {
      const venues = starrocksTable("venues", {
        id: bigint("id").notNull(),
      });
      const expr = eq((events as any).id, (venues as any).id);
      expect(expr.sql).toBe("(events.id = venues.id)");
      expect(expr.values).toEqual([]);
    });
  });

  describe("Logical", () => {
    test("should create and expression", () => {
      const expr = and(
        eq((events as any).id, 1n),
        gt((events as any).price, 100)
      );
      expect(expr.sql).toBe("((events.id = ?) AND (events.price > ?))");
      expect(expr.values).toEqual([1n, 100]);
    });

    test("should create or expression", () => {
      const expr = or(
        eq((events as any).id, 1n),
        eq((events as any).id, 2n)
      );
      expect(expr.sql).toBe("((events.id = ?) OR (events.id = ?))");
      expect(expr.values).toEqual([1n, 2n]);
    });

    test("should create not expression", () => {
      const expr = not(eq((events as any).id, 1n));
      expect(expr.sql).toBe("NOT ((events.id = ?))");
      expect(expr.values).toEqual([1n]);
    });
  });

  describe("IN / BETWEEN / LIKE", () => {
    test("should create inArray expression", () => {
      const expr = inArray((events as any).id, [1n, 2n, 3n]);
      expect(expr.sql).toBe("(events.id IN (?, ?, ?))");
      expect(expr.values).toEqual([1n, 2n, 3n]);
    });

    test("should create between expression", () => {
      const expr = between((events as any).price, 100, 500);
      expect(expr.sql).toBe("(events.price BETWEEN ? AND ?)");
      expect(expr.values).toEqual([100, 500]);
    });

    test("should create like expression", () => {
      const expr = like((events as any).name, "%test%");
      expect(expr.sql).toBe("(events.name LIKE ?)");
      expect(expr.values).toEqual(["%test%"]);
    });
  });

  describe("SQL Template", () => {
    test("should create raw SQL expression", () => {
      const expr = sql`NOW() - INTERVAL 7 DAY`;
      expect(expr.sql).toBe("NOW() - INTERVAL 7 DAY");
      expect(expr.values).toEqual([]);
    });

    test("should interpolate values", () => {
      const days = 7;
      const expr = sql`NOW() - INTERVAL ${days} DAY`;
      expect(expr.sql).toBe("NOW() - INTERVAL ? DAY");
      expect(expr.values).toEqual([7]);
    });

    test("should interpolate column references", () => {
      const expr = sql`UPPER(${(events as any).name})`;
      expect(expr.sql).toBe("UPPER(events.name)");
      expect(expr.values).toEqual([]);
    });
  });
});

describe("Aggregates", () => {
  const events = starrocksTable("events", {
    id: bigint("id").notNull(),
    price: double("price"),
    venueId: bigint("venue_id"),
  });

  test("should create count(*)", () => {
    const agg = count();
    expect(agg.sql).toBe("COUNT(*)");
  });

  test("should create count(column)", () => {
    const agg = count((events as any).id);
    expect(agg.sql).toBe("COUNT(events.id)");
  });

  test("should create countDistinct", () => {
    const agg = countDistinct((events as any).venueId);
    expect(agg.sql).toBe("COUNT(DISTINCT events.venue_id)");
  });

  test("should create sum", () => {
    const agg = sum((events as any).price);
    expect(agg.sql).toBe("SUM(events.price)");
  });

  test("should create avg", () => {
    const agg = avg((events as any).price);
    expect(agg.sql).toBe("AVG(events.price)");
  });

  test("should create min", () => {
    const agg = min((events as any).price);
    expect(agg.sql).toBe("MIN(events.price)");
  });

  test("should create max", () => {
    const agg = max((events as any).price);
    expect(agg.sql).toBe("MAX(events.price)");
  });

  test("should support alias", () => {
    const agg = count().as("total_count");
    expect(agg.sql).toBe("COUNT(*) AS total_count");
    expect(agg.alias).toBe("total_count");
  });
});

describe("Reserved Words and Special Characters", () => {
  describe("Reserved word column names", () => {
    test("should handle SQL reserved words as column names", () => {
      // Using StarRocks reserved keywords as column names
      const table = starrocksTable("test_reserved", {
        order: bigint("order").notNull(),      // Reserved: ORDER
        key: varchar("key", { length: 100 }),   // Reserved: KEY
        select: datetime("select"),             // Reserved: SELECT
        from: double("from"),                   // Reserved: FROM
        where: varchar("where", { length: 50 }), // Reserved: WHERE
      }, (t) => ({
        key: primaryKey(t.order),
        distribution: hash(t.order, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);

      // All reserved words should be quoted with backticks
      expect(sql).toContain("`order`");
      expect(sql).toContain("`key`");
      expect(sql).toContain("`select`");
      expect(sql).toContain("`from`");
      expect(sql).toContain("`where`");
    });

    test("should handle reserved words in PRIMARY KEY clause", () => {
      const table = starrocksTable("pk_reserved", {
        key: bigint("key").notNull(),
        index: bigint("index").notNull(),
      }, (t) => ({
        key: primaryKey(t.key, t.index),
        distribution: hash(t.key, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);

      // Key columns should be quoted
      expect(sql).toContain("PRIMARY KEY (`key`, `index`)");
    });

    test("should handle reserved words in HASH distribution", () => {
      const table = starrocksTable("dist_reserved", {
        group: bigint("group").notNull(),
        by: bigint("by").notNull(),
      }, (t) => ({
        key: primaryKey(t.group),
        distribution: hash([t.group, t.by], { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);

      // Distribution columns should be quoted
      expect(sql).toContain("DISTRIBUTED BY HASH(`group`, `by`)");
    });

    test("should handle reserved word as table name", () => {
      const table = starrocksTable("select", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);

      // Table name should be quoted
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS `select`");
    });
  });

  describe("Special characters in identifiers", () => {
    test("should escape backticks in column names", () => {
      const table = starrocksTable("special_chars", {
        // Column with backtick in name (edge case)
        weird: varchar("col`name", { length: 100 }).notNull(),
      }, (t) => ({
        key: duplicateKey(t.weird),
        distribution: random({ buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);

      // Backtick should be escaped by doubling
      expect(sql).toContain("`col``name`");
    });

    test("should handle column names with hyphens", () => {
      const table = starrocksTable("hyphen_table", {
        userId: bigint("user-id").notNull(),
      }, (t) => ({
        key: primaryKey(t.userId),
        distribution: hash(t.userId, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);

      // Hyphenated names need backticks
      expect(sql).toContain("`user-id`");
    });
  });
});

describe("Query Builder", () => {
  const events = starrocksTable("events", {
    id: bigint("id").notNull(),
    name: varchar("name", { length: 255 }),
    price: double("price"),
    venueId: bigint("venue_id"),
    createdAt: datetime("created_at"),
  });

  const venues = starrocksTable("venues", {
    id: bigint("id").notNull(),
    name: varchar("name", { length: 255 }),
    city: varchar("city", { length: 100 }),
  });

  describe("SELECT", () => {
    test("should generate SELECT * query", () => {
      const qb = new QueryBuilder()
        .selectAll()
        .from(events);

      const { sql } = qb.toSQL();
      expect(sql).toBe("SELECT *\nFROM `events`");
    });

    test("should generate SELECT with specific columns", () => {
      const qb = new QueryBuilder()
        .select({
          id: (events as any).id,
          name: (events as any).name,
        })
        .from(events);

      const { sql } = qb.toSQL();
      expect(sql).toContain("SELECT");
      expect(sql).toContain("events.id");
      expect(sql).toContain("events.name");
      expect(sql).toContain("FROM `events`");
    });

    test("should generate SELECT with column alias", () => {
      const qb = new QueryBuilder()
        .select({
          eventName: (events as any).name,
        })
        .from(events);

      const { sql } = qb.toSQL();
      expect(sql).toContain("events.name AS eventName");
    });
  });

  describe("WHERE", () => {
    test("should generate WHERE clause", () => {
      const qb = new QueryBuilder()
        .selectAll()
        .from(events)
        .where(eq((events as any).id, 1n));

      const { sql, values } = qb.toSQL();
      expect(sql).toContain("WHERE (events.id = ?)");
      expect(values).toEqual([1n]);
    });

    test("should generate complex WHERE clause", () => {
      const qb = new QueryBuilder()
        .selectAll()
        .from(events)
        .where(
          and(
            gt((events as any).price, 100),
            lt((events as any).price, 1000)
          )
        );

      const { sql, values } = qb.toSQL();
      expect(sql).toContain("WHERE ((events.price > ?) AND (events.price < ?))");
      expect(values).toEqual([100, 1000]);
    });
  });

  describe("JOIN", () => {
    test("should generate INNER JOIN", () => {
      const qb = new QueryBuilder()
        .select({
          eventName: (events as any).name,
          venueName: (venues as any).name,
        })
        .from(events)
        .innerJoin(venues, eq((events as any).venueId, (venues as any).id));

      const { sql } = qb.toSQL();
      expect(sql).toContain("FROM `events`");
      expect(sql).toContain("INNER JOIN `venues` ON (events.venue_id = venues.id)");
    });

    test("should generate LEFT JOIN", () => {
      const qb = new QueryBuilder()
        .selectAll()
        .from(events)
        .leftJoin(venues, eq((events as any).venueId, (venues as any).id));

      const { sql } = qb.toSQL();
      expect(sql).toContain("LEFT JOIN `venues` ON");
    });
  });

  describe("GROUP BY / HAVING", () => {
    test("should generate GROUP BY", () => {
      const qb = new QueryBuilder()
        .select({
          venueId: (events as any).venueId,
          total: count(),
        })
        .from(events)
        .groupBy((events as any).venueId);

      const { sql } = qb.toSQL();
      expect(sql).toContain("GROUP BY events.venue_id");
    });

    test("should generate HAVING", () => {
      const qb = new QueryBuilder()
        .select({
          venueId: (events as any).venueId,
          total: count().as("total"),
        })
        .from(events)
        .groupBy((events as any).venueId)
        .having(gt(count(), 10));

      const { sql, values } = qb.toSQL();
      expect(sql).toContain("HAVING (COUNT(*) > ?)");
      expect(values).toEqual([10]);
    });
  });

  describe("ORDER BY / LIMIT / OFFSET", () => {
    test("should generate ORDER BY", () => {
      const qb = new QueryBuilder()
        .selectAll()
        .from(events)
        .orderBy((events as any).createdAt);

      const { sql } = qb.toSQL();
      expect(sql).toContain("ORDER BY events.created_at ASC");
    });

    test("should generate ORDER BY DESC", () => {
      const qb = new QueryBuilder()
        .selectAll()
        .from(events)
        .orderBy(desc((events as any).price));

      const { sql } = qb.toSQL();
      expect(sql).toContain("ORDER BY events.price DESC");
    });

    test("should generate LIMIT", () => {
      const qb = new QueryBuilder()
        .selectAll()
        .from(events)
        .limit(10);

      const { sql } = qb.toSQL();
      expect(sql).toContain("LIMIT 10");
    });

    test("should generate OFFSET", () => {
      const qb = new QueryBuilder()
        .selectAll()
        .from(events)
        .limit(10)
        .offset(20);

      const { sql } = qb.toSQL();
      expect(sql).toContain("LIMIT 10");
      expect(sql).toContain("OFFSET 20");
    });
  });

  describe("Subqueries", () => {
    test("should generate subquery", () => {
      const subquery = new QueryBuilder()
        .select({
          venueId: (events as any).venueId,
          cnt: count().as("cnt"),
        })
        .from(events)
        .groupBy((events as any).venueId)
        .as("venue_counts");

      expect(subquery._type).toBe("subquery");
      expect(subquery.alias).toBe("venue_counts");
      expect(subquery.sql).toContain("AS venue_counts");
    });
  });
});

// ============================================================================
// Battle Tests: Type System Boundary Values and Coercion
// ============================================================================

describe("Type System Boundaries", () => {
  describe("Column Type Definitions", () => {
    describe("Numeric Types", () => {
      test("should define BIGINT column with correct type", () => {
        const col = bigint("test_col");
        expect(col.name).toBe("test_col");
        expect(col.dataType).toBe("BIGINT");
      });

      test("should define INT column with correct type", () => {
        const col = int("test_col");
        expect(col.dataType).toBe("INT");
      });

      test("should define SMALLINT column with correct type", () => {
        const col = smallint("test_col");
        expect(col.dataType).toBe("SMALLINT");
      });

      test("should define TINYINT column with correct type", () => {
        const col = tinyint("test_col");
        expect(col.dataType).toBe("TINYINT");
      });

      test("should define LARGEINT column with correct type", () => {
        const col = largeint("test_col");
        expect(col.dataType).toBe("LARGEINT");
      });

      test("should define DOUBLE column with correct type", () => {
        const col = double("test_col");
        expect(col.dataType).toBe("DOUBLE");
      });

      test("should define FLOAT column with correct type", () => {
        const col = float("test_col");
        expect(col.dataType).toBe("FLOAT");
      });

      test("should define DECIMAL with precision and scale", () => {
        const col = decimal("test_col", { precision: 18, scale: 6 });
        expect(col.dataType).toBe("DECIMAL(18, 6)");
        expect(col.precision).toBe(18);
        expect(col.scale).toBe(6);
      });
    });

    describe("String Types", () => {
      test("should define VARCHAR with length", () => {
        const col = varchar("test_col", { length: 255 });
        expect(col.dataType).toBe("VARCHAR(255)");
        expect(col.length).toBe(255);
      });

      test("should define CHAR with fixed length", () => {
        const col = char("test_col", { length: 10 });
        expect(col.dataType).toBe("CHAR(10)");
        expect(col.length).toBe(10);
      });

      test("should define STRING type", () => {
        const col = string("test_col");
        expect(col.dataType).toBe("STRING");
      });
    });

    describe("Date/Time Types", () => {
      test("should define DATE column", () => {
        const col = date("test_col");
        expect(col.dataType).toBe("DATE");
      });

      test("should define DATETIME column", () => {
        const col = datetime("test_col");
        expect(col.dataType).toBe("DATETIME");
      });
    });

    describe("Boolean Type", () => {
      test("should define BOOLEAN column", () => {
        const col = boolean("test_col");
        expect(col.dataType).toBe("BOOLEAN");
      });
    });

    describe("JSON Type", () => {
      test("should define JSON column", () => {
        const col = json("test_col");
        expect(col.dataType).toBe("JSON");
      });
    });

    describe("Complex Types", () => {
      test("should define ARRAY column", () => {
        const col = array("test_col", int("element"));
        expect(col.dataType).toBe("ARRAY<INT>");
      });

      test("should define nested ARRAY column", () => {
        const col = array("test_col", array("inner", varchar("s", { length: 100 })));
        expect(col.dataType).toBe("ARRAY<ARRAY<VARCHAR(100)>>");
      });

      test("should define MAP column", () => {
        const col = map("test_col", varchar("k", { length: 100 }), int("v"));
        expect(col.dataType).toBe("MAP<VARCHAR(100), INT>");
      });

      test("should define STRUCT column", () => {
        const col = struct("test_col", {
          name: varchar("name", { length: 100 }),
          age: int("age"),
          active: boolean("active"),
        });
        expect(col.dataType).toContain("STRUCT<");
        expect(col.dataType).toContain("name VARCHAR(100)");
        expect(col.dataType).toContain("age INT");
        expect(col.dataType).toContain("active BOOLEAN");
      });
    });

    describe("Special Types", () => {
      test("should define HLL column", () => {
        const col = hll("test_col");
        expect(col.dataType).toBe("HLL");
      });

      test("should define BITMAP column", () => {
        const col = bitmap("test_col");
        expect(col.dataType).toBe("BITMAP");
      });
    });
  });

  describe("Column Modifiers", () => {
    test("should support NOT NULL modifier", () => {
      const col = bigint("id").notNull();
      expect(col.isNotNull).toBe(true);
    });

    test("should chain NOT NULL and DEFAULT", () => {
      const col = int("count").notNull().default(0);
      expect(col.isNotNull).toBe(true);
      expect(col.defaultValue).toBe(0);
    });

    test("should support aggregate modifier", () => {
      const col = bigint("count").aggregate("SUM");
      expect(col.aggregateFunc).toBe("SUM");
    });

    test("should support all aggregate functions", () => {
      const funcs: import("../src/schema/columns").AggregateFunction[] = [
        "SUM", "MAX", "MIN", "REPLACE", "REPLACE_IF_NOT_NULL", "HLL_UNION", "BITMAP_UNION"
      ];
      for (const fn of funcs) {
        const col = bigint("col").aggregate(fn);
        expect(col.aggregateFunc).toBe(fn);
      }
    });
  });

  describe("Table SQL Generation with Various Types", () => {
    test("should generate table with all numeric types", () => {
      const table = starrocksTable("numeric_test", {
        id: bigint("id").notNull(),
        count: int("count"),
        small: smallint("small"),
        tiny: tinyint("tiny"),
        large: largeint("large"),
        price: double("price"),
        ratio: float("ratio"),
        amount: decimal("amount", { precision: 18, scale: 2 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);

      expect(sql).toContain("`id` BIGINT NOT NULL");
      expect(sql).toContain("`count` INT");
      expect(sql).toContain("`small` SMALLINT");
      expect(sql).toContain("`tiny` TINYINT");
      expect(sql).toContain("`large` LARGEINT");
      expect(sql).toContain("`price` DOUBLE");
      expect(sql).toContain("`ratio` FLOAT");
      expect(sql).toContain("`amount` DECIMAL(18, 2)");
    });

    test("should generate table with string types of various lengths", () => {
      const table = starrocksTable("string_test", {
        id: bigint("id").notNull(),
        short: varchar("short", { length: 10 }),
        medium: varchar("medium", { length: 255 }),
        long: varchar("long", { length: 65533 }),
        fixed: char("fixed", { length: 5 }),
        unlimited: string("unlimited"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);

      expect(sql).toContain("`short` VARCHAR(10)");
      expect(sql).toContain("`medium` VARCHAR(255)");
      expect(sql).toContain("`long` VARCHAR(65533)");
      expect(sql).toContain("`fixed` CHAR(5)");
      expect(sql).toContain("`unlimited` STRING");
    });

    test("should generate table with complex types", () => {
      const table = starrocksTable("complex_test", {
        id: bigint("id").notNull(),
        tags: array("tags", varchar("tag", { length: 50 })),
        metadata: json("metadata"),
        scores: map("scores", varchar("subject", { length: 50 }), int("score")),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);

      expect(sql).toContain("`tags` ARRAY<VARCHAR(50)>");
      expect(sql).toContain("`metadata` JSON");
      expect(sql).toContain("`scores` MAP<VARCHAR(50), INT>");
    });
  });

  describe("Edge Case Values in Expressions", () => {
    test("should handle bigint MAX_SAFE_INTEGER in expression", () => {
      const events = starrocksTable("events", {
        id: bigint("id").notNull(),
      });

      // Number.MAX_SAFE_INTEGER = 9007199254740991
      const expr = eq((events as any).id, BigInt(Number.MAX_SAFE_INTEGER));
      expect(expr.values).toEqual([BigInt(Number.MAX_SAFE_INTEGER)]);
    });

    test("should handle bigint values beyond MAX_SAFE_INTEGER", () => {
      const events = starrocksTable("events", {
        id: bigint("id").notNull(),
      });

      // Beyond safe integer range
      const bigValue = BigInt("9223372036854775807"); // BIGINT max
      const expr = eq((events as any).id, bigValue);
      expect(expr.values).toEqual([bigValue]);
    });

    test("should handle negative bigint values", () => {
      const events = starrocksTable("events", {
        id: bigint("id").notNull(),
      });

      const negValue = BigInt("-9223372036854775808"); // BIGINT min
      const expr = eq((events as any).id, negValue);
      expect(expr.values).toEqual([negValue]);
    });

    test("should handle zero in numeric expressions", () => {
      const events = starrocksTable("events", {
        price: int("price"),
      });

      const expr = eq((events as any).price, 0);
      expect(expr.values).toEqual([0]);
    });

    test("should handle empty string in expression", () => {
      const events = starrocksTable("events", {
        name: varchar("name", { length: 255 }),
      });

      const expr = eq((events as any).name, "");
      expect(expr.values).toEqual([""]);
    });

    test("should handle IN with single value", () => {
      const events = starrocksTable("events", {
        id: bigint("id"),
      });

      const expr = inArray((events as any).id, [1n]);
      expect(expr.sql).toContain("IN (?)");
      expect(expr.values).toEqual([1n]);
    });

    test("should handle IN with many values", () => {
      const events = starrocksTable("events", {
        id: bigint("id"),
      });

      const manyValues = Array.from({ length: 100 }, (_, i) => BigInt(i));
      const expr = inArray((events as any).id, manyValues);
      expect(expr.values.length).toBe(100);
    });

    test("should handle BETWEEN with same low and high value", () => {
      const events = starrocksTable("events", {
        price: int("price"),
      });

      const expr = between((events as any).price, 100, 100);
      expect(expr.sql).toContain("BETWEEN ? AND ?");
      expect(expr.values).toEqual([100, 100]);
    });

    test("should handle LIKE with SQL wildcards", () => {
      const events = starrocksTable("events", {
        name: varchar("name", { length: 255 }),
      });

      const expr = like((events as any).name, "%test%");
      expect(expr.values).toEqual(["%test%"]);
    });

    test("should handle LIKE with literal percent sign (escape needed by user)", () => {
      const events = starrocksTable("events", {
        name: varchar("name", { length: 255 }),
      });

      // User needs to escape % if they want literal match
      const expr = like((events as any).name, "100\\% discount");
      expect(expr.values).toEqual(["100\\% discount"]);
    });
  });

  describe("Date/Time Expressions", () => {
    test("should handle Date objects in expressions", () => {
      const events = starrocksTable("events", {
        createdAt: datetime("created_at"),
      });

      const date = new Date("2024-01-15T10:30:00Z");
      const expr = eq((events as any).createdAt, date);
      expect(expr.values).toEqual([date]);
    });

    test("should handle epoch date", () => {
      const events = starrocksTable("events", {
        createdAt: datetime("created_at"),
      });

      const epoch = new Date(0);
      const expr = gt((events as any).createdAt, epoch);
      expect(expr.values).toEqual([epoch]);
    });

    test("should handle far future date", () => {
      const events = starrocksTable("events", {
        createdAt: datetime("created_at"),
      });

      const futureDate = new Date("2099-12-31T23:59:59Z");
      const expr = lt((events as any).createdAt, futureDate);
      expect(expr.values).toEqual([futureDate]);
    });
  });

  describe("Boolean Expressions", () => {
    test("should handle boolean true in expression", () => {
      const events = starrocksTable("events", {
        isActive: boolean("is_active"),
      });

      const expr = eq((events as any).isActive, true);
      expect(expr.values).toEqual([true]);
    });

    test("should handle boolean false in expression", () => {
      const events = starrocksTable("events", {
        isActive: boolean("is_active"),
      });

      const expr = eq((events as any).isActive, false);
      expect(expr.values).toEqual([false]);
    });
  });

  describe("Logical Expression Combinations", () => {
    test("should handle empty AND conditions", () => {
      const expr = and();
      expect(expr.sql).toBe("TRUE");
      expect(expr.values).toEqual([]);
    });

    test("should handle empty OR conditions", () => {
      const expr = or();
      expect(expr.sql).toBe("FALSE");
      expect(expr.values).toEqual([]);
    });

    test("should handle single condition in AND", () => {
      const events = starrocksTable("events", {
        id: bigint("id"),
      });

      const single = eq((events as any).id, 1n);
      const expr = and(single);
      // Single condition should pass through unchanged
      expect(expr.sql).toBe(single.sql);
    });

    test("should handle single condition in OR", () => {
      const events = starrocksTable("events", {
        id: bigint("id"),
      });

      const single = eq((events as any).id, 1n);
      const expr = or(single);
      expect(expr.sql).toBe(single.sql);
    });

    test("should handle deeply nested conditions", () => {
      const events = starrocksTable("events", {
        id: bigint("id"),
        price: int("price"),
        status: varchar("status", { length: 50 }),
      });

      const expr = and(
        or(
          eq((events as any).id, 1n),
          eq((events as any).id, 2n)
        ),
        and(
          gt((events as any).price, 100),
          eq((events as any).status, "active")
        )
      );

      expect(expr.sql).toContain("AND");
      expect(expr.sql).toContain("OR");
      expect(expr.values.length).toBe(4);
    });
  });
});

// ============================================================================
// Table Builder Edge Cases
// ============================================================================

describe("Table Builder Edge Cases", () => {
  describe("Reserved Words as Identifiers", () => {
    test("should handle reserved SQL word as table name", () => {
      const selectTable = starrocksTable("select", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(selectTable);

      // Reserved word should be quoted
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS `select`");
    });

    test("should handle reserved SQL word as column name", () => {
      const tableWithReserved = starrocksTable("test_table", {
        index: bigint("index").notNull(),
        order: varchar("order", { length: 50 }),
        select: datetime("select"),
        from: bigint("from"),
        where: varchar("where", { length: 100 }),
      }, (t) => ({
        key: primaryKey(t.index),
        distribution: hash(t.index, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(tableWithReserved);

      // All reserved words as column names should be quoted
      expect(sql).toContain("`index` BIGINT NOT NULL");
      expect(sql).toContain("`order` VARCHAR(50)");
      expect(sql).toContain("`select` DATETIME");
      expect(sql).toContain("`from` BIGINT");
      expect(sql).toContain("`where` VARCHAR(100)");
    });

    test("should handle MySQL reserved words", () => {
      const tableWithMysqlReserved = starrocksTable("mysql_reserved", {
        database: bigint("database").notNull(),
        table: varchar("table", { length: 50 }),
        column: varchar("column", { length: 50 }),
        primary: bigint("primary"),
        key: varchar("key", { length: 50 }),
      }, (t) => ({
        key: primaryKey(t.database),
        distribution: hash(t.database, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(tableWithMysqlReserved);

      // All MySQL reserved words should be quoted
      expect(sql).toContain("`database` BIGINT NOT NULL");
      expect(sql).toContain("`table` VARCHAR(50)");
      expect(sql).toContain("`column` VARCHAR(50)");
      expect(sql).toContain("`primary` BIGINT");
      expect(sql).toContain("`key` VARCHAR(50)");
    });
  });

  describe("Long Identifiers", () => {
    test("should handle maximum length table name (64 chars)", () => {
      const longTableName = "a".repeat(64);
      const longTable = starrocksTable(longTableName, {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(longTable);
      expect(sql).toContain(`\`${longTableName}\``);
    });

    test("should handle maximum length column name (64 chars)", () => {
      const longColName = "b".repeat(64);
      const cols: any = {
        id: bigint("id").notNull(),
      };
      cols.longCol = varchar(longColName, { length: 100 });

      const tableWithLongCol = starrocksTable("test_long_col", cols, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(tableWithLongCol);
      expect(sql).toContain(`\`${longColName}\``);
    });
  });

  describe("Special Characters in Names", () => {
    test("should handle table name with numbers", () => {
      const table123 = starrocksTable("events_2024", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table123);
      expect(sql).toContain("`events_2024`");
    });

    test("should handle column name starting with number", () => {
      const tableWith123Col = starrocksTable("test_num_col", {
        id: bigint("id").notNull(),
        col_123: varchar("123_col", { length: 50 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(tableWith123Col);
      expect(sql).toContain("`123_col`");
    });

    test("should handle column name with underscores", () => {
      const table = starrocksTable("test_underscores", {
        id: bigint("id").notNull(),
        my_long_column_name: varchar("my_long_column_name", { length: 100 }),
        __double__underscore__: bigint("__double__underscore__"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain("`my_long_column_name` VARCHAR(100)");
      expect(sql).toContain("`__double__underscore__` BIGINT");
    });
  });

  describe("Distribution Edge Cases", () => {
    test("should handle random distribution", () => {
      const randomDistTable = starrocksTable("random_dist", {
        id: bigint("id").notNull(),
        data: varchar("data", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: random({ buckets: 8 }),
      }));

      const sql = generateCreateTableSQL(randomDistTable);
      expect(sql).toContain("DISTRIBUTED BY RANDOM BUCKETS 8");
    });

    test("should handle multi-column hash distribution", () => {
      const multiColDist = starrocksTable("multi_dist", {
        tenantId: bigint("tenant_id").notNull(),
        userId: bigint("user_id").notNull(),
        data: varchar("data", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.tenantId, t.userId),
        distribution: hash([t.tenantId, t.userId], { buckets: 16 }),
      }));

      const sql = generateCreateTableSQL(multiColDist);
      expect(sql).toContain("DISTRIBUTED BY HASH(`tenant_id`, `user_id`) BUCKETS 16");
    });

    test("should handle single bucket", () => {
      const singleBucket = starrocksTable("single_bucket", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 1 }),
      }));

      const sql = generateCreateTableSQL(singleBucket);
      expect(sql).toContain("BUCKETS 1");
    });

    test("should handle large bucket count", () => {
      const largeBuckets = starrocksTable("large_buckets", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 256 }),
      }));

      const sql = generateCreateTableSQL(largeBuckets);
      expect(sql).toContain("BUCKETS 256");
    });
  });

  describe("Partition Edge Cases", () => {
    test("should handle range partition with MAXVALUE", () => {
      const maxvaluePartition = starrocksTable("maxvalue_part", {
        dt: date("dt").notNull(),
        id: bigint("id").notNull(),
      }, (t) => ({
        key: duplicateKey(t.dt, t.id),
        partition: rangePartition(t.dt, {
          partitions: [
            { name: "p2024", lessThan: "2025-01-01" },
            { name: "p_max", lessThan: "MAXVALUE" },
          ],
        }),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(maxvaluePartition);
      expect(sql).toContain('PARTITION p2024 VALUES LESS THAN ("2025-01-01")');
      expect(sql).toContain("PARTITION p_max VALUES LESS THAN (MAXVALUE)");
    });

    test("should handle single partition", () => {
      const singlePart = starrocksTable("single_part", {
        dt: date("dt").notNull(),
        id: bigint("id").notNull(),
      }, (t) => ({
        key: duplicateKey(t.dt, t.id),
        partition: rangePartition(t.dt, {
          partitions: [
            { name: "p_all", lessThan: "MAXVALUE" },
          ],
        }),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(singlePart);
      expect(sql).toContain("PARTITION p_all VALUES LESS THAN (MAXVALUE)");
    });

    test("should handle list partition with multiple values", () => {
      const listPart = starrocksTable("list_part", {
        region: varchar("region", { length: 50 }).notNull(),
        id: bigint("id").notNull(),
      }, (t) => ({
        key: duplicateKey(t.region, t.id),
        partition: listPartition(t.region, {
          americas: ["us", "ca", "mx", "br"],
          europe: ["uk", "de", "fr", "es", "it"],
          asia: ["jp", "cn", "kr", "in", "sg"],
        }),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(listPart);
      expect(sql).toContain('PARTITION americas VALUES IN ("us", "ca", "mx", "br")');
      expect(sql).toContain('PARTITION europe VALUES IN ("uk", "de", "fr", "es", "it")');
      expect(sql).toContain('PARTITION asia VALUES IN ("jp", "cn", "kr", "in", "sg")');
    });

    test("should handle list partition with single value", () => {
      const singleValuePart = starrocksTable("single_value_part", {
        status: varchar("status", { length: 20 }).notNull(),
        id: bigint("id").notNull(),
      }, (t) => ({
        key: duplicateKey(t.status, t.id),
        partition: listPartition(t.status, {
          active: ["active"],
          archived: ["archived"],
        }),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(singleValuePart);
      expect(sql).toContain('PARTITION active VALUES IN ("active")');
      expect(sql).toContain('PARTITION archived VALUES IN ("archived")');
    });
  });

  describe("Key Type Edge Cases", () => {
    test("should handle multi-column primary key", () => {
      const multiPk = starrocksTable("multi_pk", {
        tenantId: bigint("tenant_id").notNull(),
        userId: bigint("user_id").notNull(),
        timestamp: datetime("timestamp").notNull(),
        data: varchar("data", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.tenantId, t.userId, t.timestamp),
        distribution: hash(t.tenantId, { buckets: 8 }),
      }));

      const sql = generateCreateTableSQL(multiPk);
      expect(sql).toContain("PRIMARY KEY (`tenant_id`, `user_id`, `timestamp`)");
    });

    test("should handle aggregate key with different aggregate functions", () => {
      const aggTable = starrocksTable("agg_table", {
        dt: date("dt").notNull(),
        category: varchar("category", { length: 50 }).notNull(),
        totalCount: bigint("total_count").aggregate("SUM"),
        maxValue: double("max_value").aggregate("MAX"),
        minValue: double("min_value").aggregate("MIN"),
        avgPrice: double("avg_price").aggregate("REPLACE"),
      }, (t) => ({
        key: aggregateKey(t.dt, t.category),
        distribution: hash(t.category, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(aggTable);
      expect(sql).toContain("AGGREGATE KEY (`dt`, `category`)");
      expect(sql).toContain("`total_count` BIGINT SUM");
      expect(sql).toContain("`max_value` DOUBLE MAX");
      expect(sql).toContain("`min_value` DOUBLE MIN");
      expect(sql).toContain("`avg_price` DOUBLE REPLACE");
    });
  });

  describe("Properties Edge Cases", () => {
    test("should handle multiple properties", () => {
      const propsTable = starrocksTable("props_table", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: {
          replication_num: 1,
          storage_medium: "SSD",
          colocate_with: "group1",
        },
      }));

      const sql = generateCreateTableSQL(propsTable);
      expect(sql).toContain('"replication_num" = "1"');
      expect(sql).toContain('"storage_medium" = "SSD"');
      expect(sql).toContain('"colocate_with" = "group1"');
    });

    test("should handle bloom filter columns property", () => {
      const bloomTable = starrocksTable("bloom_table", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
        email: varchar("email", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: {
          replication_num: 1,
          bloom_filter_columns: ["name", "email"],
        },
      }));

      const sql = generateCreateTableSQL(bloomTable);
      expect(sql).toContain('"bloom_filter_columns" = "name,email"');
    });
  });

  describe("Default Value Edge Cases", () => {
    test("should handle numeric default values", () => {
      const numDefaultsTable = starrocksTable("num_defaults", {
        id: bigint("id").notNull(),
        intDefault: int("int_default").default(0),
        // Note: bigint default with BigInt literal not supported in formatDefaultValue
        // Use number instead for bigint defaults
        bigintDefault: bigint("bigint_default").default(100),
        doubleDefault: double("double_default").default(3.14),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(numDefaultsTable);
      expect(sql).toContain("`int_default` INT DEFAULT 0");
      expect(sql).toContain("`bigint_default` BIGINT DEFAULT 100");
      expect(sql).toContain("`double_default` DOUBLE DEFAULT 3.14");
    });

    test("should handle string default values", () => {
      const strDefaultsTable = starrocksTable("str_defaults", {
        id: bigint("id").notNull(),
        status: varchar("status", { length: 50 }).default("active"),
        emptyDefault: varchar("empty_default", { length: 50 }).default(""),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(strDefaultsTable);
      expect(sql).toContain("`status` VARCHAR(50) DEFAULT 'active'");
      expect(sql).toContain("`empty_default` VARCHAR(50) DEFAULT ''");
    });

    test("should handle boolean default values", () => {
      const boolDefaultsTable = starrocksTable("bool_defaults", {
        id: bigint("id").notNull(),
        isActive: boolean("is_active").default(true),
        isDeleted: boolean("is_deleted").default(false),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(boolDefaultsTable);
      // SQL uses uppercase TRUE/FALSE
      expect(sql).toContain("`is_active` BOOLEAN DEFAULT TRUE");
      expect(sql).toContain("`is_deleted` BOOLEAN DEFAULT FALSE");
    });
  });

  describe("Table Without Config", () => {
    test("should throw if no key type is defined", () => {
      const noConfigTable = starrocksTable("no_config", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 100 }),
      });

      expect(() => generateCreateTableSQL(noConfigTable)).toThrow(
        'Table "no_config" has no key type defined'
      );
    });

    test("should throw if config callback returns empty object", () => {
      const emptyConfigTable = starrocksTable("empty_config", {
        id: bigint("id").notNull(),
      }, () => ({}));

      expect(() => generateCreateTableSQL(emptyConfigTable)).toThrow(
        'Table "empty_config" has no key type defined'
      );
    });
  });

  describe("Column Name Conflicts", () => {
    test("should handle column named 'name' (conflicts with table property)", () => {
      const tableWithNameCol = starrocksTable("with_name_col", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      // The table's actual name is accessible via internal _tableName and getTableName()
      // Note: .name property is overwritten by the column ref
      expect((tableWithNameCol as any)._tableName).toBe("with_name_col");
      expect((tableWithNameCol as any).getTableName()).toBe("with_name_col");

      // Column 'name' should be accessible as a column ref (overwrites .name property)
      expect((tableWithNameCol as any).name.column).toBe("name");
      expect((tableWithNameCol as any).name.fullName).toBe("with_name_col.name");
    });

    test("should handle column named 'columns' (conflicts with table property)", () => {
      const tableWithColumnsCol = starrocksTable("with_columns_col", {
        id: bigint("id").notNull(),
        columnsCol: int("columns"), // Use different JS key
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      // Table columns are still accessible via the proper columns property
      expect(tableWithColumnsCol.columns.id).toBeDefined();
      expect(tableWithColumnsCol.columns.columnsCol).toBeDefined();

      // Column ref 'columns' is accessible via the JS property name
      expect((tableWithColumnsCol as any).columnsCol.column).toBe("columns");
      expect((tableWithColumnsCol as any).columnsCol.fullName).toBe("with_columns_col.columns");
    });
  });

  describe("VARCHAR Length Edge Cases", () => {
    test("should handle VARCHAR with minimum length", () => {
      const minVarchar = varchar("min", { length: 1 });
      expect(minVarchar.dataType).toBe("VARCHAR(1)");
    });

    test("should handle VARCHAR with maximum length", () => {
      // StarRocks VARCHAR max is 1048576 (1MB)
      const maxVarchar = varchar("max", { length: 1048576 });
      expect(maxVarchar.dataType).toBe("VARCHAR(1048576)");
    });

    test("should handle CHAR with fixed length", () => {
      const fixedChar = char("fixed", { length: 36 }); // UUID length
      expect(fixedChar.dataType).toBe("CHAR(36)");
    });
  });

  describe("Decimal Precision Edge Cases", () => {
    test("should handle DECIMAL with maximum precision", () => {
      // StarRocks max precision is 38
      const maxPrecision = decimal("max_precision", { precision: 38, scale: 0 });
      expect(maxPrecision.dataType).toBe("DECIMAL(38, 0)");
    });

    test("should handle DECIMAL with maximum scale", () => {
      const maxScale = decimal("max_scale", { precision: 38, scale: 38 });
      expect(maxScale.dataType).toBe("DECIMAL(38, 38)");
    });

    test("should handle DECIMAL with minimum precision", () => {
      const minPrecision = decimal("min_precision", { precision: 1, scale: 0 });
      expect(minPrecision.dataType).toBe("DECIMAL(1, 0)");
    });

    test("should handle DECIMAL common use cases", () => {
      const money = decimal("money", { precision: 18, scale: 2 });
      expect(money.dataType).toBe("DECIMAL(18, 2)");

      const percentage = decimal("percentage", { precision: 5, scale: 4 });
      expect(percentage.dataType).toBe("DECIMAL(5, 4)");
    });
  });
});

// ============================================================================
// StarRocks-Specific Data Type Limits
// ============================================================================

describe("StarRocks-Specific Data Type Limits", () => {
  describe("LARGEINT (128-bit integer)", () => {
    test("should define LARGEINT column", () => {
      const col = largeint("large_value");
      expect(col.dataType).toBe("LARGEINT");
      expect(col.name).toBe("large_value");
    });

    test("should define LARGEINT with notNull", () => {
      const col = largeint("large_id").notNull();
      expect(col.dataType).toBe("LARGEINT");
      expect(col.isNotNull).toBe(true);
    });

    test("should create table with LARGEINT column", () => {
      const largeTable = starrocksTable("large_table", {
        id: largeint("id").notNull(),
        value: largeint("value"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(largeTable);
      expect(sql).toContain("`id` LARGEINT NOT NULL");
      expect(sql).toContain("`value` LARGEINT");
    });
  });

  describe("DECIMAL Precision Limits", () => {
    test("should handle DECIMAL64 range (precision <= 18)", () => {
      // DECIMAL64 uses int64 storage for precision <= 18
      const decimal18 = decimal("decimal18", { precision: 18, scale: 6 });
      expect(decimal18.dataType).toBe("DECIMAL(18, 6)");
    });

    test("should handle DECIMAL128 range (18 < precision <= 38)", () => {
      // DECIMAL128 uses int128 storage for 18 < precision <= 38
      const decimal38 = decimal("decimal38", { precision: 38, scale: 10 });
      expect(decimal38.dataType).toBe("DECIMAL(38, 10)");
    });

    test("should handle boundary between DECIMAL64 and DECIMAL128", () => {
      // Precision 18 is the boundary
      const atBoundary = decimal("at_boundary", { precision: 18, scale: 9 });
      expect(atBoundary.dataType).toBe("DECIMAL(18, 9)");

      const justAbove = decimal("just_above", { precision: 19, scale: 9 });
      expect(justAbove.dataType).toBe("DECIMAL(19, 9)");
    });
  });

  describe("ARRAY Type Limits", () => {
    test("should define simple ARRAY column", () => {
      const col = array("tags", varchar("", { length: 100 }));
      expect(col.dataType).toBe("ARRAY<VARCHAR(100)>");
    });

    test("should define ARRAY with different element types", () => {
      const intArray = array("int_arr", int(""));
      expect(intArray.dataType).toBe("ARRAY<INT>");

      const bigintArray = array("bigint_arr", bigint(""));
      expect(bigintArray.dataType).toBe("ARRAY<BIGINT>");

      const doubleArray = array("double_arr", double(""));
      expect(doubleArray.dataType).toBe("ARRAY<DOUBLE>");

      const datetimeArray = array("dt_arr", datetime(""));
      expect(datetimeArray.dataType).toBe("ARRAY<DATETIME>");
    });

    test("should define nested ARRAY (2 levels)", () => {
      const nested = array("nested", array("", varchar("", { length: 50 })));
      expect(nested.dataType).toBe("ARRAY<ARRAY<VARCHAR(50)>>");
    });

    test("should define 3-level nested ARRAY", () => {
      const nested3 = array("nested3",
        array("",
          array("", int(""))
        )
      );
      expect(nested3.dataType).toBe("ARRAY<ARRAY<ARRAY<INT>>>");
    });

    test("should create table with ARRAY column", () => {
      const arrayTable = starrocksTable("array_table", {
        id: bigint("id").notNull(),
        tags: array("tags", varchar("", { length: 100 })),
        scores: array("scores", int("")),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(arrayTable);
      expect(sql).toContain("`tags` ARRAY<VARCHAR(100)>");
      expect(sql).toContain("`scores` ARRAY<INT>");
    });

    test("should create table with NOT NULL ARRAY column", () => {
      const notNullArray = starrocksTable("not_null_array", {
        id: bigint("id").notNull(),
        required_tags: array("required_tags", varchar("", { length: 50 })).notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(notNullArray);
      expect(sql).toContain("`required_tags` ARRAY<VARCHAR(50)> NOT NULL");
    });
  });

  describe("MAP Type", () => {
    test("should define simple MAP column", () => {
      const col = map("metadata", varchar("", { length: 100 }), varchar("", { length: 255 }));
      expect(col.dataType).toBe("MAP<VARCHAR(100), VARCHAR(255)>");
    });

    test("should define MAP with different key/value types", () => {
      const intStringMap = map("int_map", int(""), varchar("", { length: 100 }));
      expect(intStringMap.dataType).toBe("MAP<INT, VARCHAR(100)>");

      const stringIntMap = map("string_int", varchar("", { length: 50 }), bigint(""));
      expect(stringIntMap.dataType).toBe("MAP<VARCHAR(50), BIGINT>");
    });

    test("should create table with MAP column", () => {
      const mapTable = starrocksTable("map_table", {
        id: bigint("id").notNull(),
        attributes: map("attributes", varchar("", { length: 50 }), varchar("", { length: 255 })),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(mapTable);
      expect(sql).toContain("`attributes` MAP<VARCHAR(50), VARCHAR(255)>");
    });
  });

  describe("STRUCT Type", () => {
    test("should define simple STRUCT column", () => {
      const col = struct("person", {
        name: varchar("name", { length: 100 }),
        age: int("age"),
      });
      expect(col.dataType).toContain("STRUCT<");
      expect(col.dataType).toContain("name VARCHAR(100)");
      expect(col.dataType).toContain("age INT");
    });

    test("should define STRUCT with multiple field types", () => {
      const col = struct("complex", {
        id: bigint("id"),
        value: double("value"),
        created: datetime("created"),
        active: boolean("active"),
      });
      expect(col.dataType).toContain("id BIGINT");
      expect(col.dataType).toContain("value DOUBLE");
      expect(col.dataType).toContain("created DATETIME");
      expect(col.dataType).toContain("active BOOLEAN");
    });

    test("should create table with STRUCT column", () => {
      const structTable = starrocksTable("struct_table", {
        id: bigint("id").notNull(),
        contact: struct("contact", {
          email: varchar("email", { length: 255 }),
          phone: varchar("phone", { length: 20 }),
        }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(structTable);
      expect(sql).toContain("`contact` STRUCT<");
    });
  });

  describe("HLL and BITMAP Types", () => {
    test("should define HLL column", () => {
      const col = hll("user_hll");
      expect(col.dataType).toBe("HLL");
      expect(col.name).toBe("user_hll");
    });

    test("should define BITMAP column", () => {
      const col = bitmap("user_bitmap");
      expect(col.dataType).toBe("BITMAP");
      expect(col.name).toBe("user_bitmap");
    });

    test("should create aggregate table with HLL column", () => {
      const hllTable = starrocksTable("hll_table", {
        dt: date("dt").notNull(),
        category: varchar("category", { length: 50 }).notNull(),
        userCount: hll("user_count").aggregate("HLL_UNION"),
      }, (t) => ({
        key: aggregateKey(t.dt, t.category),
        distribution: hash(t.category, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(hllTable);
      expect(sql).toContain("`user_count` HLL HLL_UNION");
    });

    test("should create aggregate table with BITMAP column", () => {
      const bitmapTable = starrocksTable("bitmap_table", {
        dt: date("dt").notNull(),
        category: varchar("category", { length: 50 }).notNull(),
        userBitmap: bitmap("user_bitmap").aggregate("BITMAP_UNION"),
      }, (t) => ({
        key: aggregateKey(t.dt, t.category),
        distribution: hash(t.category, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(bitmapTable);
      expect(sql).toContain("`user_bitmap` BITMAP BITMAP_UNION");
    });
  });

  describe("JSON Type", () => {
    test("should define JSON column", () => {
      const col = json("data");
      expect(col.dataType).toBe("JSON");
      expect(col.name).toBe("data");
    });

    test("should create table with JSON column", () => {
      const jsonTable = starrocksTable("json_table", {
        id: bigint("id").notNull(),
        payload: json("payload"),
        metadata: json("metadata"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(jsonTable);
      expect(sql).toContain("`payload` JSON");
      expect(sql).toContain("`metadata` JSON");
    });
  });

  describe("STRING Type (unbounded)", () => {
    test("should define STRING column (unlimited length)", () => {
      const col = string("content");
      expect(col.dataType).toBe("STRING");
      expect(col.name).toBe("content");
    });

    test("should create table with STRING column", () => {
      const stringTable = starrocksTable("string_table", {
        id: bigint("id").notNull(),
        content: string("content"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(stringTable);
      expect(sql).toContain("`content` STRING");
    });
  });

  describe("Date and Time Types", () => {
    test("should define DATE column", () => {
      const col = date("event_date");
      expect(col.dataType).toBe("DATE");
    });

    test("should define DATETIME column", () => {
      const col = datetime("event_time");
      expect(col.dataType).toBe("DATETIME");
    });

    test("should create table with date/time columns", () => {
      const dateTable = starrocksTable("date_table", {
        id: bigint("id").notNull(),
        eventDate: date("event_date"),
        eventTime: datetime("event_time"),
        createdAt: datetime("created_at").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(dateTable);
      expect(sql).toContain("`event_date` DATE");
      expect(sql).toContain("`event_time` DATETIME");
      expect(sql).toContain("`created_at` DATETIME NOT NULL");
    });
  });

  describe("Integer Type Ranges", () => {
    test("should define TINYINT column", () => {
      const col = tinyint("small_value");
      expect(col.dataType).toBe("TINYINT");
    });

    test("should define SMALLINT column", () => {
      const col = smallint("medium_value");
      expect(col.dataType).toBe("SMALLINT");
    });

    test("should define INT column", () => {
      const col = int("regular_value");
      expect(col.dataType).toBe("INT");
    });

    test("should define BIGINT column", () => {
      const col = bigint("large_value");
      expect(col.dataType).toBe("BIGINT");
    });

    test("should create table with all integer types", () => {
      const intTable = starrocksTable("int_table", {
        id: bigint("id").notNull(),
        tinyVal: tinyint("tiny_val"),
        smallVal: smallint("small_val"),
        intVal: int("int_val"),
        bigVal: bigint("big_val"),
        largeVal: largeint("large_val"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(intTable);
      expect(sql).toContain("`tiny_val` TINYINT");
      expect(sql).toContain("`small_val` SMALLINT");
      expect(sql).toContain("`int_val` INT");
      expect(sql).toContain("`big_val` BIGINT");
      expect(sql).toContain("`large_val` LARGEINT");
    });
  });

  describe("Floating Point Types", () => {
    test("should define FLOAT column", () => {
      const col = float("float_value");
      expect(col.dataType).toBe("FLOAT");
    });

    test("should define DOUBLE column", () => {
      const col = double("double_value");
      expect(col.dataType).toBe("DOUBLE");
    });

    test("should create table with floating point columns", () => {
      const floatTable = starrocksTable("float_table", {
        id: bigint("id").notNull(),
        floatVal: float("float_val"),
        doubleVal: double("double_val"),
        price: decimal("price", { precision: 18, scale: 2 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(floatTable);
      expect(sql).toContain("`float_val` FLOAT");
      expect(sql).toContain("`double_val` DOUBLE");
      expect(sql).toContain("`price` DECIMAL(18, 2)");
    });
  });
});
