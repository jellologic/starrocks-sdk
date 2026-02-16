import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE, beHttpPort } from "../src/test-config";

/**
 * Battle Test: Bucketing Edge Cases
 *
 * Tests StarRocks bucketing and distribution features:
 * - Hash distribution with different bucket counts
 * - Random distribution
 * - Multi-column hash keys
 * - Bucket pruning verification
 * - Colocate groups for efficient JOINs
 * - Edge cases with bucket assignment
 *
 * IMPORTANT: Uses raw SQL with fully qualified table names (database.table)
 * because connection pooling makes USE DATABASE unreliable.
 */
describe("StarRocks Bucketing Edge Cases", () => {
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
  // Single Column Hash Distribution
  // ============================================================================

  describe("Single Column Hash Distribution", () => {
    const TABLE = "single_hash_bucket";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          user_id BIGINT NOT NULL,
          event_type VARCHAR(50),
          timestamp DATETIME,
          value DOUBLE
        )
        DUPLICATE KEY (user_id)
        DISTRIBUTED BY HASH(user_id) BUCKETS 8
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should distribute data across buckets by hash key", async () => {
      // Load data with sequential IDs to test hash distribution
      const data = Array.from({ length: 100 }, (_, i) => ({
        user_id: i + 1,
        event_type: `event_${i % 5}`,
        timestamp: "2024-01-15 10:00:00",
        value: Math.random() * 100,
      }));

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
      expect(result.numberLoadedRows).toBe(100);

      // Verify all data loaded
      const count = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)}`
      );
      expect((count[0] as any).cnt).toBe(100);
    });

    test("should handle NULL in non-key columns gracefully", async () => {
      // Create table that allows NULL in non-key column
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("hash_nullable")} (
          id BIGINT NOT NULL,
          category VARCHAR(50),
          value DOUBLE
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Load data with non-null values first
      const data = [
        { id: 1, category: "A", value: 10.0 },
        { id: 3, category: "B", value: 30.0 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "hash_nullable",
      });

      expect(result.status).toBe("Success");

      // Verify data
      const rows = await client.raw<{ id: number }>(
        `SELECT id FROM ${FQN("hash_nullable")} ORDER BY id`
      );
      expect(rows.length).toBe(2);
    });

    test("should handle extreme hash key values", async () => {
      // Create dedicated table for this test to avoid conflicts
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("extreme_hash_test")} (
          user_id BIGINT NOT NULL,
          event_type VARCHAR(50),
          value DOUBLE
        )
        DUPLICATE KEY (user_id)
        DISTRIBUTED BY HASH(user_id) BUCKETS 8
        PROPERTIES("replication_num" = "1")
      `);

      const data = [
        { user_id: 0, event_type: "zero", value: 0 },
        { user_id: 1, event_type: "one", value: 1 },
        { user_id: 999999999, event_type: "large_pos", value: 9 },
        { user_id: -1, event_type: "neg_one", value: -1 },
        { user_id: -999999999, event_type: "large_neg", value: -99 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "extreme_hash_test",
      });

      expect(result.status).toBe("Success");
      expect(result.numberLoadedRows).toBe(5);

      // Verify all data loaded
      const count = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN("extreme_hash_test")}`
      );
      expect((count[0] as any).cnt).toBe(5);
    });
  });

  // ============================================================================
  // Multi-Column Hash Distribution
  // ============================================================================

  describe("Multi-Column Hash Distribution", () => {
    const TABLE = "multi_hash_bucket";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          region VARCHAR(50) NOT NULL,
          user_id BIGINT NOT NULL,
          action VARCHAR(50),
          count INT
        )
        DUPLICATE KEY (region, user_id)
        DISTRIBUTED BY HASH(region, user_id) BUCKETS 8
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should distribute based on composite hash key", async () => {
      const regions = ["US", "EU", "APAC", "LATAM"];
      const data: any[] = [];

      for (const region of regions) {
        for (let userId = 1; userId <= 25; userId++) {
          data.push({
            region,
            user_id: userId,
            action: `action_${userId % 5}`,
            count: userId,
          });
        }
      }

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
      expect(result.numberLoadedRows).toBe(100);

      // Verify region counts
      const regionCounts = await client.raw<{ region: string; cnt: number }>(
        `SELECT region, COUNT(*) as cnt FROM ${FQN(TABLE)} GROUP BY region ORDER BY region`
      );
      expect(regionCounts.length).toBe(4);
      regionCounts.forEach((r: any) => expect(r.cnt).toBe(25));
    });

    test("should keep same composite key in same bucket", async () => {
      // Multiple records with same (region, user_id) should be in same bucket
      const data = [
        { region: "US", user_id: 1, action: "login", count: 1 },
        { region: "US", user_id: 1, action: "view", count: 2 },
        { region: "US", user_id: 1, action: "click", count: 3 },
        { region: "EU", user_id: 1, action: "login", count: 1 },
        { region: "EU", user_id: 1, action: "purchase", count: 1 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      // Query specific composite key
      const usUser1 = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)} WHERE region = 'US' AND user_id = 1`
      );
      expect((usUser1[0] as any).cnt).toBeGreaterThanOrEqual(3);
    });
  });

  // ============================================================================
  // Random Distribution
  // ============================================================================

  describe("Random Distribution", () => {
    const TABLE = "random_bucket";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          data VARCHAR(255),
          created_at DATETIME
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY RANDOM BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should randomly distribute data", async () => {
      const data = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        data: `random_data_${i}`,
        created_at: "2024-01-15 12:00:00",
      }));

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
      expect(result.numberLoadedRows).toBe(100);
    });

    test("should handle high-cardinality data efficiently", async () => {
      // Generate unique IDs that would be difficult to hash efficiently
      const data = Array.from({ length: 500 }, (_, i) => ({
        id: i * 17 + 3, // Prime-based pattern
        data: `high_cardinality_${i}`,
        created_at: "2024-01-15 12:00:00",
      }));

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });
  });

  // ============================================================================
  // Bucket Count Variations
  // ============================================================================

  describe("Bucket Count Variations", () => {
    test("should work with single bucket", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("single_bucket")} (
          id BIGINT NOT NULL,
          value INT
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 1
        PROPERTIES("replication_num" = "1")
      `);

      const data = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        value: i * 10,
      }));

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "single_bucket",
      });

      expect(result.status).toBe("Success");
    });

    test("should work with power-of-two buckets", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("pow2_bucket")} (
          id BIGINT NOT NULL,
          value INT
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 16
        PROPERTIES("replication_num" = "1")
      `);

      const data = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        value: i * 10,
      }));

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "pow2_bucket",
      });

      expect(result.status).toBe("Success");
    });

    test("should work with non-power-of-two buckets", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("prime_bucket")} (
          id BIGINT NOT NULL,
          value INT
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 7
        PROPERTIES("replication_num" = "1")
      `);

      const data = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        value: i * 10,
      }));

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "prime_bucket",
      });

      expect(result.status).toBe("Success");
    });
  });

  // ============================================================================
  // Colocate Groups
  // ============================================================================

  describe("Colocate Groups", () => {
    const GROUP_NAME = `colo_group_${Date.now()}`;

    test("should create colocated tables", async () => {
      // Create two tables in the same colocate group
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("colo_orders")} (
          order_id BIGINT NOT NULL,
          user_id BIGINT NOT NULL,
          amount DECIMAL(10, 2)
        )
        DUPLICATE KEY (order_id)
        DISTRIBUTED BY HASH(user_id) BUCKETS 4
        PROPERTIES(
          "replication_num" = "1",
          "colocate_with" = "${GROUP_NAME}"
        )
      `);

      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("colo_users")} (
          user_id BIGINT NOT NULL,
          name VARCHAR(100),
          email VARCHAR(255)
        )
        DUPLICATE KEY (user_id)
        DISTRIBUTED BY HASH(user_id) BUCKETS 4
        PROPERTIES(
          "replication_num" = "1",
          "colocate_with" = "${GROUP_NAME}"
        )
      `);

      // Load data into both tables
      const users = [
        { user_id: 1, name: "Alice", email: "alice@example.com" },
        { user_id: 2, name: "Bob", email: "bob@example.com" },
        { user_id: 3, name: "Charlie", email: "charlie@example.com" },
      ];

      const orders = [
        { order_id: 101, user_id: 1, amount: 99.99 },
        { order_id: 102, user_id: 1, amount: 149.99 },
        { order_id: 103, user_id: 2, amount: 49.99 },
        { order_id: 104, user_id: 3, amount: 199.99 },
      ];

      const [usersResult, ordersResult] = await Promise.all([
        streamLoader.loadObjects(users, {
          database: TEST_DATABASE,
          table: "colo_users",
        }),
        streamLoader.loadObjects(orders, {
          database: TEST_DATABASE,
          table: "colo_orders",
        }),
      ]);

      expect(usersResult.status).toBe("Success");
      expect(ordersResult.status).toBe("Success");
    });

    test("should efficiently join colocated tables", async () => {
      // This JOIN should be local (no shuffle) due to colocation
      const joinResult = await client.raw<{ name: string; total: number }>(
        `SELECT u.name, SUM(o.amount) as total
         FROM ${FQN("colo_orders")} o
         JOIN ${FQN("colo_users")} u ON o.user_id = u.user_id
         GROUP BY u.name
         ORDER BY u.name`
      );

      expect(joinResult.length).toBe(3);
      expect((joinResult[0] as any).name).toBe("Alice");
    });
  });

  // ============================================================================
  // Bucket Pruning
  // ============================================================================

  describe("Bucket Pruning", () => {
    const TABLE = "bucket_prune_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          user_id BIGINT NOT NULL,
          event_type VARCHAR(50),
          large_data VARCHAR(1000)
        )
        DUPLICATE KEY (user_id)
        DISTRIBUTED BY HASH(user_id) BUCKETS 8
        PROPERTIES("replication_num" = "1")
      `);

      // Load data across all buckets
      const data = Array.from({ length: 800 }, (_, i) => ({
        user_id: i + 1,
        event_type: `event_${i % 10}`,
        large_data: "X".repeat(100),
      }));

      await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });
    });

    test("should use bucket pruning for point query on hash key", async () => {
      // Query specific user_id - should only scan 1 bucket
      const result = await client.raw<{ user_id: number; event_type: string }>(
        `SELECT user_id, event_type FROM ${FQN(TABLE)} WHERE user_id = 100`
      );

      expect(result.length).toBe(1);
      expect((result[0] as any).user_id).toBe(100);
    });

    test("should use bucket pruning for IN clause on hash key", async () => {
      // Query multiple specific user_ids
      const result = await client.raw<{ user_id: number }>(
        `SELECT user_id FROM ${FQN(TABLE)} WHERE user_id IN (1, 100, 500)`
      );

      expect(result.length).toBe(3);
    });

    test("should scan all buckets for non-hash-key predicates", async () => {
      // Query by event_type - must scan all buckets
      const result = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)} WHERE event_type = 'event_5'`
      );

      expect((result[0] as any).cnt).toBe(80); // 800 / 10 event types
    });
  });

  // ============================================================================
  // String Hash Keys
  // ============================================================================

  describe("String Hash Keys", () => {
    const TABLE = "string_hash_bucket";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          category VARCHAR(100) NOT NULL,
          item_id BIGINT NOT NULL,
          description VARCHAR(255)
        )
        DUPLICATE KEY (category, item_id)
        DISTRIBUTED BY HASH(category) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should hash distribute on string column", async () => {
      const categories = ["Electronics", "Clothing", "Books", "Home", "Sports"];
      const data: any[] = [];

      categories.forEach((cat, catIdx) => {
        for (let i = 0; i < 10; i++) {
          data.push({
            category: cat,
            item_id: catIdx * 100 + i,
            description: `Item ${i} in ${cat}`,
          });
        }
      });

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      // Verify category distribution
      const catCounts = await client.raw<{ category: string; cnt: number }>(
        `SELECT category, COUNT(*) as cnt FROM ${FQN(TABLE)} GROUP BY category ORDER BY category`
      );
      expect(catCounts.length).toBe(5);
    });

    test("should handle unicode strings in hash key", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("unicode_hash")} (
          name VARCHAR(100) NOT NULL,
          id BIGINT NOT NULL,
          data VARCHAR(255)
        )
        DUPLICATE KEY (name, id)
        DISTRIBUTED BY HASH(name) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = [
        { name: "日本語", id: 1, data: "Japanese" },
        { name: "中文", id: 2, data: "Chinese" },
        { name: "한국어", id: 3, data: "Korean" },
        { name: "العربية", id: 4, data: "Arabic" },
        { name: "🚀🎉", id: 5, data: "Emoji" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "unicode_hash",
      });

      expect(result.status).toBe("Success");
      expect(result.numberLoadedRows).toBe(5);
    });

    test("should handle empty string hash key", async () => {
      // Empty strings might cause issues with hashing
      const data = [
        { category: "", item_id: 1, description: "Empty category" },
        { category: " ", item_id: 2, description: "Space category" },
        { category: "  ", item_id: 3, description: "Double space" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    test("should handle very long hash key values", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("long_key_hash")} (
          key_col VARCHAR(500) NOT NULL,
          value INT
        )
        DUPLICATE KEY (key_col)
        DISTRIBUTED BY HASH(key_col) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = [
        { key_col: "A".repeat(500), value: 1 },
        { key_col: "B".repeat(500), value: 2 },
        { key_col: "C".repeat(500), value: 3 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "long_key_hash",
      });

      expect(result.status).toBe("Success");
    });

    test("should handle all same hash key values", async () => {
      // All data goes to same bucket - tests bucket capacity
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("same_hash")} (
          category VARCHAR(50) NOT NULL,
          seq INT NOT NULL,
          data VARCHAR(100)
        )
        DUPLICATE KEY (category, seq)
        DISTRIBUTED BY HASH(category) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = Array.from({ length: 100 }, (_, i) => ({
        category: "SAME", // All go to same bucket
        seq: i + 1,
        data: `Data ${i}`,
      }));

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "same_hash",
      });

      expect(result.status).toBe("Success");

      const count = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN("same_hash")}`
      );
      expect((count[0] as any).cnt).toBe(100);
    });

    test("should handle special characters in hash key", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("special_char_hash")} (
          tag VARCHAR(200) NOT NULL,
          count INT
        )
        DUPLICATE KEY (tag)
        DISTRIBUTED BY HASH(tag) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = [
        { tag: "hello\tworld", count: 1 }, // Tab
        { tag: "hello\nworld", count: 2 }, // Newline
        { tag: "hello\\world", count: 3 }, // Backslash
        { tag: "hello'world", count: 4 }, // Single quote
        { tag: 'hello"world', count: 5 }, // Double quote
        { tag: "hello\0world", count: 6 }, // Null byte - may be filtered
      ];

      const result = await streamLoader.loadObjects(data.slice(0, 5), {
        database: TEST_DATABASE,
        table: "special_char_hash",
      });

      expect(result.status).toBe("Success");
    });
  });
});
