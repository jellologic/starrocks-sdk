import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE, beHttpPort } from "../src/test-config";

/**
 * Battle Test: NULL Handling Edge Cases
 *
 * Tests StarRocks NULL handling:
 * - NULL values in different data types
 * - NULL in aggregations
 * - NULL comparisons (IS NULL, IS NOT NULL, COALESCE)
 * - NULL in key columns (where allowed)
 * - NULL with REPLACE/REPLACE_IF_NOT_NULL
 * - NULL sorting behavior
 *
 * IMPORTANT: Uses raw SQL with fully qualified table names (database.table)
 * because connection pooling makes USE DATABASE unreliable.
 */
describe("StarRocks NULL Handling Edge Cases", () => {
  let client: StarRocksClient;
  let streamLoader: StreamLoadClient;

  const FQN = (table: string) => `${TEST_DATABASE}.${table}`;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);

    streamLoader = createStreamLoadClient({
      host: testConfig.host,
      httpPort: beHttpPort,
      user: testConfig.user,
      password: testConfig.password,
    });
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  // ============================================================================
  // NULL in Different Data Types
  // ============================================================================

  describe("NULL in Different Data Types", () => {
    const TABLE = "null_types";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          int_val INT,
          bigint_val BIGINT,
          float_val FLOAT,
          double_val DOUBLE,
          decimal_val DECIMAL(10, 2),
          varchar_val VARCHAR(100),
          date_val DATE,
          datetime_val DATETIME,
          boolean_val BOOLEAN
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should store NULL in all nullable columns via INSERT", async () => {
      // Use INSERT for explicit NULL values
      await client.raw(`
        INSERT INTO ${FQN(TABLE)} (id, int_val, bigint_val, float_val, double_val, decimal_val, varchar_val, date_val, datetime_val, boolean_val)
        VALUES (1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      `);

      // Verify NULLs
      const row = await client.raw<any>(
        `SELECT * FROM ${FQN(TABLE)} WHERE id = 1`
      );

      expect(row.length).toBe(1);
      expect((row[0] as any).int_val).toBeNull();
      expect((row[0] as any).varchar_val).toBeNull();
      expect((row[0] as any).date_val).toBeNull();
    });

    test("should load mixed NULL and non-NULL values", async () => {
      const data = [
        { id: 2, int_val: 100, varchar_val: "has value", decimal_val: 99.99 },
        { id: 3, int_val: 200, varchar_val: "also has value", decimal_val: 50.00 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      // Non-null columns should have values
      const row = await client.raw<{ int_val: number; varchar_val: string }>(
        `SELECT int_val, varchar_val FROM ${FQN(TABLE)} WHERE id = 2`
      );
      expect((row[0] as any).int_val).toBe(100);
      expect((row[0] as any).varchar_val).toBe("has value");
    });
  });

  // ============================================================================
  // NULL in Aggregations
  // ============================================================================

  describe("NULL in Aggregations", () => {
    const TABLE = "null_agg";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          category VARCHAR(50) NOT NULL,
          value INT
        )
        DUPLICATE KEY (category)
        DISTRIBUTED BY HASH(category) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Use INSERT for explicit NULL values
      await client.raw(`
        INSERT INTO ${FQN(TABLE)} (category, value) VALUES
        ('A', 10),
        ('A', 20),
        ('A', NULL),
        ('B', NULL),
        ('B', NULL),
        ('C', 100)
      `);
    });

    test("should exclude NULLs from SUM", async () => {
      const result = await client.raw<{ category: string; total: number }>(
        `SELECT category, SUM(value) as total FROM ${FQN(TABLE)} GROUP BY category ORDER BY category`
      );

      expect((result[0] as any).total).toBe(30); // A: 10 + 20
      expect((result[1] as any).total).toBeNull(); // B: all NULL
      expect((result[2] as any).total).toBe(100); // C: 100
    });

    test("should exclude NULLs from AVG", async () => {
      const result = await client.raw<{ category: string; avg_val: number }>(
        `SELECT category, AVG(value) as avg_val FROM ${FQN(TABLE)} GROUP BY category ORDER BY category`
      );

      expect((result[0] as any).avg_val).toBe(15); // A: (10 + 20) / 2
      expect((result[1] as any).avg_val).toBeNull(); // B: all NULL
    });

    test("should count NULLs separately", async () => {
      const result = await client.raw<{ category: string; cnt: number; cnt_val: number }>(
        `SELECT category,
                COUNT(*) as cnt,
                COUNT(value) as cnt_val
         FROM ${FQN(TABLE)}
         GROUP BY category
         ORDER BY category`
      );

      // Category A: 3 rows, 2 non-null values
      expect((result[0] as any).cnt).toBe(3);
      expect((result[0] as any).cnt_val).toBe(2);

      // Category B: 2 rows, 0 non-null values
      expect((result[1] as any).cnt).toBe(2);
      expect((result[1] as any).cnt_val).toBe(0);
    });

    test("should handle MIN/MAX with NULLs", async () => {
      const result = await client.raw<{ category: string; min_val: number; max_val: number }>(
        `SELECT category, MIN(value) as min_val, MAX(value) as max_val
         FROM ${FQN(TABLE)}
         GROUP BY category
         ORDER BY category`
      );

      expect((result[0] as any).min_val).toBe(10);
      expect((result[0] as any).max_val).toBe(20);
      expect((result[1] as any).min_val).toBeNull(); // All NULL
      expect((result[1] as any).max_val).toBeNull();
    });
  });

  // ============================================================================
  // NULL Comparisons
  // ============================================================================

  describe("NULL Comparisons", () => {
    const TABLE = "null_compare";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          status VARCHAR(50),
          score INT
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Use INSERT for explicit NULL values
      await client.raw(`
        INSERT INTO ${FQN(TABLE)} (id, status, score) VALUES
        (1, 'active', 100),
        (2, NULL, 50),
        (3, 'inactive', NULL),
        (4, NULL, NULL),
        (5, 'active', 75)
      `);
    });

    test("should filter with IS NULL", async () => {
      const result = await client.raw<{ id: number }>(
        `SELECT id FROM ${FQN(TABLE)} WHERE status IS NULL ORDER BY id`
      );

      expect(result.length).toBe(2);
      expect((result[0] as any).id).toBe(2);
      expect((result[1] as any).id).toBe(4);
    });

    test("should filter with IS NOT NULL", async () => {
      const result = await client.raw<{ id: number }>(
        `SELECT id FROM ${FQN(TABLE)} WHERE status IS NOT NULL ORDER BY id`
      );

      expect(result.length).toBe(3);
      expect(result.map((r: any) => r.id)).toEqual([1, 3, 5]);
    });

    test("should handle COALESCE for NULL replacement", async () => {
      const result = await client.raw<{ id: number; status_val: string }>(
        `SELECT id, COALESCE(status, 'unknown') as status_val FROM ${FQN(TABLE)} ORDER BY id`
      );

      expect((result[0] as any).status_val).toBe("active");
      expect((result[1] as any).status_val).toBe("unknown");
      expect((result[3] as any).status_val).toBe("unknown");
    });

    test("should handle IFNULL function", async () => {
      const result = await client.raw<{ id: number; score_val: number }>(
        `SELECT id, IFNULL(score, 0) as score_val FROM ${FQN(TABLE)} ORDER BY id`
      );

      expect((result[0] as any).score_val).toBe(100);
      expect((result[2] as any).score_val).toBe(0); // Was NULL
      expect((result[3] as any).score_val).toBe(0); // Was NULL
    });

    test("should handle NULLIF function", async () => {
      const result = await client.raw<{ id: number; score_nulled: number | null }>(
        `SELECT id, NULLIF(score, 50) as score_nulled FROM ${FQN(TABLE)} ORDER BY id`
      );

      expect((result[0] as any).score_nulled).toBe(100); // Not 50, unchanged
      expect((result[1] as any).score_nulled).toBeNull(); // Was 50, now NULL
    });

    test("should handle NULL-safe equality (<=>)", async () => {
      const result = await client.raw<{ id: number }>(
        `SELECT id FROM ${FQN(TABLE)} WHERE status <=> NULL ORDER BY id`
      );

      expect(result.length).toBe(2);
      expect((result[0] as any).id).toBe(2);
      expect((result[1] as any).id).toBe(4);
    });
  });

  // ============================================================================
  // NULL Sorting
  // ============================================================================

  describe("NULL Sorting", () => {
    const TABLE = "null_sort";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          priority INT,
          name VARCHAR(50)
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Use INSERT for explicit NULL values
      await client.raw(`
        INSERT INTO ${FQN(TABLE)} (id, priority, name) VALUES
        (1, 3, 'C'),
        (2, NULL, 'B'),
        (3, 1, NULL),
        (4, NULL, NULL),
        (5, 2, 'A')
      `);
    });

    test("should sort NULLs with consistent behavior in ASC", async () => {
      const result = await client.raw<{ id: number; priority: number | null }>(
        `SELECT id, priority FROM ${FQN(TABLE)} ORDER BY priority ASC`
      );

      // Count NULLs and non-NULLs
      const nullRows = result.filter((r: any) => r.priority === null);
      const nonNullRows = result.filter((r: any) => r.priority !== null);

      expect(nullRows.length).toBe(2);
      expect(nonNullRows.length).toBe(3);

      // Non-NULL values should be sorted
      const values = nonNullRows.map((r: any) => r.priority);
      expect(values).toEqual([1, 2, 3]);
    });

    test("should sort NULLs with consistent behavior in DESC", async () => {
      const result = await client.raw<{ id: number; priority: number | null }>(
        `SELECT id, priority FROM ${FQN(TABLE)} ORDER BY priority DESC`
      );

      // Count NULLs and non-NULLs
      const nullRows = result.filter((r: any) => r.priority === null);
      const nonNullRows = result.filter((r: any) => r.priority !== null);

      expect(nullRows.length).toBe(2);
      expect(nonNullRows.length).toBe(3);

      // Non-NULL values should be sorted descending
      const values = nonNullRows.map((r: any) => r.priority);
      expect(values).toEqual([3, 2, 1]);
    });

    test("should handle NULLS FIRST/LAST hints", async () => {
      const result = await client.raw<{ id: number; priority: number | null }>(
        `SELECT id, priority FROM ${FQN(TABLE)} ORDER BY priority ASC NULLS FIRST`
      );

      // NULLs should come first with explicit NULLS FIRST
      expect((result[0] as any).priority).toBeNull();
      expect((result[1] as any).priority).toBeNull();
      // Followed by sorted non-NULL values
      expect((result[2] as any).priority).toBe(1);
    });
  });

  // ============================================================================
  // NULL in CASE Expressions
  // ============================================================================

  describe("NULL in CASE Expressions", () => {
    const TABLE = "null_case";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          value INT,
          status VARCHAR(50)
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Use INSERT for explicit NULL values
      await client.raw(`
        INSERT INTO ${FQN(TABLE)} (id, value, status) VALUES
        (1, 100, 'complete'),
        (2, NULL, 'pending'),
        (3, 50, NULL),
        (4, NULL, NULL)
      `);
    });

    test("should handle NULL in CASE WHEN condition", async () => {
      const result = await client.raw<{ id: number; category: string }>(
        `SELECT id,
                CASE WHEN value IS NULL THEN 'no_value'
                     WHEN value >= 100 THEN 'high'
                     ELSE 'low'
                END as category
         FROM ${FQN(TABLE)}
         ORDER BY id`
      );

      expect((result[0] as any).category).toBe("high");
      expect((result[1] as any).category).toBe("no_value");
      expect((result[2] as any).category).toBe("low");
      expect((result[3] as any).category).toBe("no_value");
    });

    test("should handle CASE returning NULL", async () => {
      const result = await client.raw<{ id: number; result: number | null }>(
        `SELECT id,
                CASE WHEN status = 'complete' THEN value
                     ELSE NULL
                END as result
         FROM ${FQN(TABLE)}
         ORDER BY id`
      );

      expect((result[0] as any).result).toBe(100);
      expect((result[1] as any).result).toBeNull();
      expect((result[2] as any).result).toBeNull();
    });
  });

  // ============================================================================
  // NULL in JOINs
  // ============================================================================

  describe("NULL in JOINs", () => {
    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("null_join_left")} (
          id BIGINT NOT NULL,
          ref_id BIGINT,
          name VARCHAR(50)
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("null_join_right")} (
          ref_id BIGINT NOT NULL,
          value INT
        )
        DUPLICATE KEY (ref_id)
        DISTRIBUTED BY HASH(ref_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Use INSERT for explicit NULL values
      await client.raw(`
        INSERT INTO ${FQN("null_join_left")} (id, ref_id, name) VALUES
        (1, 100, 'A'),
        (2, NULL, 'B'),
        (3, 200, 'C'),
        (4, NULL, 'D')
      `);

      await streamLoader.loadObjects([
        { ref_id: 100, value: 10 },
        { ref_id: 200, value: 20 },
        { ref_id: 300, value: 30 },
      ], {
        database: TEST_DATABASE,
        table: "null_join_right",
      });
    });

    test("should not match NULL in INNER JOIN", async () => {
      const result = await client.raw<{ id: number }>(
        `SELECT l.id
         FROM ${FQN("null_join_left")} l
         INNER JOIN ${FQN("null_join_right")} r ON l.ref_id = r.ref_id
         ORDER BY l.id`
      );

      // Only rows with matching ref_id (not NULL)
      expect(result.length).toBe(2);
      expect((result[0] as any).id).toBe(1);
      expect((result[1] as any).id).toBe(3);
    });

    test("should include NULL rows in LEFT JOIN", async () => {
      const result = await client.raw<{ id: number; value: number | null }>(
        `SELECT l.id, r.value
         FROM ${FQN("null_join_left")} l
         LEFT JOIN ${FQN("null_join_right")} r ON l.ref_id = r.ref_id
         ORDER BY l.id`
      );

      expect(result.length).toBe(4);
      expect((result[0] as any).value).toBe(10);
      expect((result[1] as any).value).toBeNull(); // NULL ref_id, no match
      expect((result[2] as any).value).toBe(20);
      expect((result[3] as any).value).toBeNull(); // NULL ref_id, no match
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    test("should distinguish NULL from empty string", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("null_vs_empty")} (
          id BIGINT NOT NULL,
          val VARCHAR(100)
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Use INSERT for explicit NULL values
      await client.raw(`
        INSERT INTO ${FQN("null_vs_empty")} (id, val) VALUES
        (1, ''),
        (2, NULL),
        (3, '   ')
      `);

      // Empty string is not NULL
      const emptyResult = await client.raw<{ id: number }>(
        `SELECT id FROM ${FQN("null_vs_empty")} WHERE val = ''`
      );
      expect(emptyResult.length).toBe(1);
      expect((emptyResult[0] as any).id).toBe(1);

      // NULL is distinct
      const nullResult = await client.raw<{ id: number }>(
        `SELECT id FROM ${FQN("null_vs_empty")} WHERE val IS NULL`
      );
      expect(nullResult.length).toBe(1);
      expect((nullResult[0] as any).id).toBe(2);
    });

    test("should handle NULL in DISTINCT", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("null_distinct")} (
          id BIGINT NOT NULL,
          category VARCHAR(50)
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Use INSERT for explicit NULL values
      await client.raw(`
        INSERT INTO ${FQN("null_distinct")} (id, category) VALUES
        (1, 'A'),
        (2, NULL),
        (3, 'A'),
        (4, NULL),
        (5, 'B')
      `);

      const result = await client.raw<{ category: string | null }>(
        `SELECT DISTINCT category FROM ${FQN("null_distinct")} ORDER BY category`
      );

      // Should have 3 distinct values: NULL, A, B
      expect(result.length).toBe(3);
    });

    test("should handle NULL in GROUP BY", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("null_group")} (
          id BIGINT NOT NULL,
          group_col VARCHAR(50),
          value INT
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Use INSERT for explicit NULL values
      await client.raw(`
        INSERT INTO ${FQN("null_group")} (id, group_col, value) VALUES
        (1, 'X', 10),
        (2, NULL, 20),
        (3, 'X', 30),
        (4, NULL, 40)
      `);

      const result = await client.raw<{ group_col: string | null; total: number }>(
        `SELECT group_col, SUM(value) as total
         FROM ${FQN("null_group")}
         GROUP BY group_col
         ORDER BY group_col`
      );

      // NULL is treated as a group
      expect(result.length).toBe(2);
      expect((result[0] as any).group_col).toBeNull();
      expect((result[0] as any).total).toBe(60); // 20 + 40
      expect((result[1] as any).group_col).toBe("X");
      expect((result[1] as any).total).toBe(40); // 10 + 30
    });

    test("should handle NULL in UNION", async () => {
      const result = await client.raw<{ val: number | null }>(
        `SELECT 1 as val
         UNION ALL
         SELECT NULL as val
         UNION ALL
         SELECT 2 as val`
      );

      expect(result.length).toBe(3);
      const vals = result.map((r: any) => r.val);
      expect(vals).toContain(1);
      expect(vals).toContain(2);
      expect(vals).toContain(null);
    });
  });
});
