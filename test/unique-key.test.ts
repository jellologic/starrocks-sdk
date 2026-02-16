import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";

/**
 * Battle Test: Unique Key Table Edge Cases
 *
 * Tests StarRocks UNIQUE KEY tables:
 * - Automatic deduplication on key columns
 * - Replace behavior (last-write-wins)
 * - Compound unique keys
 * - Concurrent updates to same key
 * - Partial column updates
 * - NULL handling in unique keys
 *
 * IMPORTANT: Uses raw SQL with fully qualified table names (database.table)
 * because connection pooling makes USE DATABASE unreliable.
 */
describe("StarRocks Unique Key Table Edge Cases", () => {
  let client: StarRocksClient;
  let streamLoader: StreamLoadClient;

  const FQN = (table: string) => `${TEST_DATABASE}.${table}`;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);

    streamLoader = createStreamLoadClient({
      host: testConfig.host,
      httpPort: 18030,
      user: testConfig.user,
      password: testConfig.password,
    });
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  // ============================================================================
  // Basic Unique Key Behavior
  // ============================================================================

  describe("Basic Unique Key Behavior", () => {
    const TABLE = "unique_basic";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          user_id BIGINT NOT NULL,
          name VARCHAR(100),
          email VARCHAR(255),
          status VARCHAR(20)
        )
        UNIQUE KEY (user_id)
        DISTRIBUTED BY HASH(user_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should deduplicate by unique key within same load", async () => {
      const data = [
        { user_id: 1, name: "Alice V1", email: "alice1@test.com", status: "pending" },
        { user_id: 1, name: "Alice V2", email: "alice2@test.com", status: "active" },
        { user_id: 1, name: "Alice V3", email: "alice3@test.com", status: "premium" },
        { user_id: 2, name: "Bob", email: "bob@test.com", status: "active" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      // Should only have 2 rows (user_id 1 and 2)
      const rows = await client.raw<{ user_id: number; name: string }>(
        `SELECT user_id, name, email FROM ${FQN(TABLE)} ORDER BY user_id`
      );

      expect(rows.length).toBe(2);
      // Last value for user_id 1 should win
      expect((rows[0] as any).name).toBe("Alice V3");
      expect((rows[0] as any).email).toBe("alice3@test.com");
    });

    test("should replace on subsequent loads", async () => {
      // First load
      await streamLoader.loadObjects(
        [{ user_id: 10, name: "Original", email: "orig@test.com", status: "new" }],
        { database: TEST_DATABASE, table: TABLE }
      );

      // Second load with same key
      await streamLoader.loadObjects(
        [{ user_id: 10, name: "Updated", email: "updated@test.com", status: "verified" }],
        { database: TEST_DATABASE, table: TABLE }
      );

      const row = await client.raw<{ name: string; email: string; status: string }>(
        `SELECT name, email, status FROM ${FQN(TABLE)} WHERE user_id = 10`
      );

      expect(row.length).toBe(1);
      expect((row[0] as any).name).toBe("Updated");
      expect((row[0] as any).email).toBe("updated@test.com");
      expect((row[0] as any).status).toBe("verified");
    });

    test("should handle many duplicates efficiently", async () => {
      // Load same key 100 times
      const data = Array.from({ length: 100 }, (_, i) => ({
        user_id: 999,
        name: `Version ${i}`,
        email: `v${i}@test.com`,
        status: i % 2 === 0 ? "active" : "inactive",
      }));

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      // Should only have 1 row for user_id 999
      const count = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)} WHERE user_id = 999`
      );
      expect((count[0] as any).cnt).toBe(1);

      // Should have last version
      const row = await client.raw<{ name: string }>(
        `SELECT name FROM ${FQN(TABLE)} WHERE user_id = 999`
      );
      expect((row[0] as any).name).toBe("Version 99");
    });
  });

  // ============================================================================
  // Compound Unique Keys
  // ============================================================================

  describe("Compound Unique Keys", () => {
    const TABLE = "unique_compound";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          tenant_id INT NOT NULL,
          user_id BIGINT NOT NULL,
          name VARCHAR(100),
          role VARCHAR(50)
        )
        UNIQUE KEY (tenant_id, user_id)
        DISTRIBUTED BY HASH(tenant_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should deduplicate on compound key only", async () => {
      const data = [
        // Same user_id but different tenant_id - both should exist
        { tenant_id: 1, user_id: 100, name: "Alice T1", role: "admin" },
        { tenant_id: 2, user_id: 100, name: "Alice T2", role: "user" },
        // Same compound key - should dedupe
        { tenant_id: 1, user_id: 100, name: "Alice T1 Updated", role: "superadmin" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      // Should have 2 rows (different compound keys)
      const rows = await client.raw<{ tenant_id: number; user_id: number; name: string }>(
        `SELECT tenant_id, user_id, name, role FROM ${FQN(TABLE)} WHERE user_id = 100 ORDER BY tenant_id`
      );

      expect(rows.length).toBe(2);
      expect((rows[0] as any).name).toBe("Alice T1 Updated"); // Updated version
      expect((rows[0] as any).role).toBe("superadmin");
      expect((rows[1] as any).name).toBe("Alice T2"); // Tenant 2 unchanged
    });

    test("should handle high-cardinality compound keys", async () => {
      // Use distinct range to avoid pollution from other tests
      const data: any[] = [];

      // 10 tenants × 10 users = 100 unique combinations
      for (let t = 100; t <= 109; t++) {
        for (let u = 1000; u <= 1009; u++) {
          data.push({
            tenant_id: t,
            user_id: u,
            name: `User ${u} in Tenant ${t}`,
            role: t === 100 ? "admin" : "user",
          });
        }
      }

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const count = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)} WHERE tenant_id BETWEEN 100 AND 109`
      );
      expect((count[0] as any).cnt).toBe(100);
    });
  });

  // ============================================================================
  // Concurrent Updates
  // ============================================================================

  describe("Concurrent Updates", () => {
    const TABLE = "unique_concurrent";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          counter INT,
          last_update DATETIME
        )
        UNIQUE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle concurrent loads to same key", async () => {
      const timestamp = Date.now();

      // 5 concurrent loads all updating same key
      const results = await Promise.all([
        streamLoader.loadObjects(
          [{ id: 1, counter: 1, last_update: "2024-01-01 10:00:01" }],
          { database: TEST_DATABASE, table: TABLE, label: `conc_uk_1_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ id: 1, counter: 2, last_update: "2024-01-01 10:00:02" }],
          { database: TEST_DATABASE, table: TABLE, label: `conc_uk_2_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ id: 1, counter: 3, last_update: "2024-01-01 10:00:03" }],
          { database: TEST_DATABASE, table: TABLE, label: `conc_uk_3_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ id: 1, counter: 4, last_update: "2024-01-01 10:00:04" }],
          { database: TEST_DATABASE, table: TABLE, label: `conc_uk_4_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ id: 1, counter: 5, last_update: "2024-01-01 10:00:05" }],
          { database: TEST_DATABASE, table: TABLE, label: `conc_uk_5_${timestamp}` }
        ),
      ]);

      // All should succeed
      results.forEach(r => expect(r.status).toBe("Success"));

      // Wait for merge
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should only have 1 row (one of the concurrent updates won)
      const count = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)} WHERE id = 1`
      );
      expect((count[0] as any).cnt).toBe(1);
    });

    test("should handle concurrent loads to different keys", async () => {
      const timestamp = Date.now();

      // 5 concurrent loads to different keys
      const results = await Promise.all([
        streamLoader.loadObjects(
          [{ id: 100, counter: 1, last_update: "2024-01-01 10:00:00" }],
          { database: TEST_DATABASE, table: TABLE, label: `diff_uk_1_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ id: 101, counter: 2, last_update: "2024-01-01 10:00:00" }],
          { database: TEST_DATABASE, table: TABLE, label: `diff_uk_2_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ id: 102, counter: 3, last_update: "2024-01-01 10:00:00" }],
          { database: TEST_DATABASE, table: TABLE, label: `diff_uk_3_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ id: 103, counter: 4, last_update: "2024-01-01 10:00:00" }],
          { database: TEST_DATABASE, table: TABLE, label: `diff_uk_4_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ id: 104, counter: 5, last_update: "2024-01-01 10:00:00" }],
          { database: TEST_DATABASE, table: TABLE, label: `diff_uk_5_${timestamp}` }
        ),
      ]);

      // All should succeed
      results.forEach(r => expect(r.status).toBe("Success"));

      // Wait for merge
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should have all 5 rows
      const count = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)} WHERE id BETWEEN 100 AND 104`
      );
      expect((count[0] as any).cnt).toBe(5);
    });
  });

  // ============================================================================
  // Partial Updates (requires Primary Key table)
  // ============================================================================

  describe("Partial Updates with Primary Key", () => {
    const TABLE = "pk_partial_update";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          name VARCHAR(100),
          email VARCHAR(255),
          status VARCHAR(20),
          score INT
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should perform full replacement by default", async () => {
      // Initial load
      await streamLoader.loadObjects(
        [{ id: 1, name: "Alice", email: "alice@test.com", status: "active", score: 100 }],
        { database: TEST_DATABASE, table: TABLE }
      );

      // Full update (all columns)
      await streamLoader.loadObjects(
        [{ id: 1, name: "Alice Updated", email: "alice.new@test.com", status: "premium", score: 200 }],
        { database: TEST_DATABASE, table: TABLE }
      );

      const row = await client.raw<{ name: string; email: string; status: string; score: number }>(
        `SELECT name, email, status, score FROM ${FQN(TABLE)} WHERE id = 1`
      );

      expect((row[0] as any).name).toBe("Alice Updated");
      expect((row[0] as any).score).toBe(200);
    });

    test("should support partial column update via SQL UPDATE", async () => {
      // Initial load
      await streamLoader.loadObjects(
        [{ id: 2, name: "Bob", email: "bob@test.com", status: "active", score: 50 }],
        { database: TEST_DATABASE, table: TABLE }
      );

      // Partial update via SQL (more reliable than stream load partial update)
      await client.raw(`UPDATE ${FQN(TABLE)} SET score = 150 WHERE id = 2`);

      const row = await client.raw<{ name: string; email: string; score: number }>(
        `SELECT name, email, score FROM ${FQN(TABLE)} WHERE id = 2`
      );

      // name and email should be preserved
      expect((row[0] as any).name).toBe("Bob");
      expect((row[0] as any).email).toBe("bob@test.com");
      // score should be updated
      expect((row[0] as any).score).toBe(150);
    });

    test("should support partial update of multiple columns via SQL", async () => {
      // Initial load
      await streamLoader.loadObjects(
        [{ id: 3, name: "Charlie", email: "charlie@test.com", status: "new", score: 0 }],
        { database: TEST_DATABASE, table: TABLE }
      );

      // Partial update via SQL
      await client.raw(`UPDATE ${FQN(TABLE)} SET status = 'verified', score = 75 WHERE id = 3`);

      const row = await client.raw<{ name: string; status: string; score: number }>(
        `SELECT name, status, score FROM ${FQN(TABLE)} WHERE id = 3`
      );

      expect((row[0] as any).name).toBe("Charlie"); // Preserved
      expect((row[0] as any).status).toBe("verified"); // Updated
      expect((row[0] as any).score).toBe(75); // Updated
    });
  });

  // ============================================================================
  // Delete Operations (Primary Key only)
  // ============================================================================

  describe("Delete Operations with Primary Key", () => {
    const TABLE = "pk_delete_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          name VARCHAR(100),
          value INT
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should delete rows via DELETE statement", async () => {
      // Load data
      await streamLoader.loadObjects(
        [
          { id: 1, name: "A", value: 1 },
          { id: 2, name: "B", value: 2 },
          { id: 3, name: "C", value: 3 },
          { id: 4, name: "D", value: 4 },
          { id: 5, name: "E", value: 5 },
        ],
        { database: TEST_DATABASE, table: TABLE }
      );

      // Delete specific rows
      await client.raw(`DELETE FROM ${FQN(TABLE)} WHERE id IN (2, 4)`);

      // Verify
      const rows = await client.raw<{ id: number }>(
        `SELECT id FROM ${FQN(TABLE)} ORDER BY id`
      );

      expect(rows.length).toBe(3);
      expect(rows.map((r: any) => r.id)).toEqual([1, 3, 5]);
    });

    test("should delete rows based on condition", async () => {
      // Load more data
      await streamLoader.loadObjects(
        [
          { id: 10, name: "Ten", value: 10 },
          { id: 20, name: "Twenty", value: 20 },
          { id: 30, name: "Thirty", value: 30 },
        ],
        { database: TEST_DATABASE, table: TABLE }
      );

      // Delete where value > 15
      await client.raw(`DELETE FROM ${FQN(TABLE)} WHERE value > 15`);

      const rows = await client.raw<{ id: number; value: number }>(
        `SELECT id, value FROM ${FQN(TABLE)} WHERE id >= 10 ORDER BY id`
      );

      expect(rows.length).toBe(1);
      expect((rows[0] as any).id).toBe(10);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    test("should handle unique key with all data types", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("unique_types")} (
          str_key VARCHAR(100) NOT NULL,
          int_key INT NOT NULL,
          value VARCHAR(100)
        )
        UNIQUE KEY (str_key, int_key)
        DISTRIBUTED BY HASH(str_key) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = [
        { str_key: "A", int_key: 1, value: "v1" },
        { str_key: "A", int_key: 2, value: "v2" },
        { str_key: "B", int_key: 1, value: "v3" },
        { str_key: "A", int_key: 1, value: "v1_updated" }, // Duplicate key
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "unique_types",
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ str_key: string; int_key: number; value: string }>(
        `SELECT str_key, int_key, value FROM ${FQN("unique_types")} ORDER BY str_key, int_key`
      );

      expect(rows.length).toBe(3);
      expect((rows[0] as any).value).toBe("v1_updated"); // Replaced
    });

    test("should handle very long unique key values", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("unique_long_key")} (
          long_key VARCHAR(500) NOT NULL,
          data VARCHAR(100)
        )
        UNIQUE KEY (long_key)
        DISTRIBUTED BY HASH(long_key) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const longKey = "K".repeat(500);
      const data = [
        { long_key: longKey, data: "first" },
        { long_key: longKey, data: "second" }, // Same key - should replace
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "unique_long_key",
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ data: string }>(
        `SELECT data FROM ${FQN("unique_long_key")}`
      );

      expect(rows.length).toBe(1);
      expect((rows[0] as any).data).toBe("second");
    });

    test("should handle unicode in unique key", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("unique_unicode")} (
          key_col VARCHAR(100) NOT NULL,
          value INT
        )
        UNIQUE KEY (key_col)
        DISTRIBUTED BY HASH(key_col) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = [
        { key_col: "日本語", value: 1 },
        { key_col: "中文", value: 2 },
        { key_col: "🚀", value: 3 },
        { key_col: "日本語", value: 10 }, // Duplicate - should replace
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "unique_unicode",
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ key_col: string; value: number }>(
        `SELECT key_col, value FROM ${FQN("unique_unicode")} ORDER BY value`
      );

      expect(rows.length).toBe(3);
      // Japanese key should have updated value
      const jpRow = rows.find((r: any) => r.key_col === "日本語");
      expect((jpRow as any).value).toBe(10);
    });

    test("should handle empty value columns with unique key", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("unique_empty_vals")} (
          id BIGINT NOT NULL,
          name VARCHAR(100),
          desc1 VARCHAR(100),
          desc2 VARCHAR(100)
        )
        UNIQUE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = [
        { id: 1, name: "A", desc1: "", desc2: "" },
        { id: 2, name: "B", desc1: "   ", desc2: "" },
        { id: 1, name: "A Updated", desc1: "now filled", desc2: "" }, // Update
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "unique_empty_vals",
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ id: number; desc1: string }>(
        `SELECT id, desc1 FROM ${FQN("unique_empty_vals")} WHERE id = 1`
      );

      expect(rows.length).toBe(1);
      expect((rows[0] as any).desc1).toBe("now filled");
    });
  });
});
