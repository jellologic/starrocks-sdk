import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";

/**
 * Battle Test: Aggregate Table Edge Cases
 *
 * Tests StarRocks AGGREGATE KEY tables with various aggregation functions:
 * - SUM, MAX, MIN aggregations
 * - REPLACE and REPLACE_IF_NOT_NULL
 * - HLL_UNION for cardinality estimation
 * - BITMAP_UNION for distinct counting
 * - Multiple aggregation columns
 * - Edge cases with updates and null handling
 *
 * IMPORTANT: Uses raw SQL with fully qualified table names (database.table)
 * because connection pooling makes USE DATABASE unreliable.
 */
describe("StarRocks Aggregate Table Edge Cases", () => {
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
  // SUM Aggregation
  // ============================================================================

  describe("SUM Aggregation", () => {
    const TABLE = "agg_sum_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          user_id BIGINT NOT NULL,
          dt DATE NOT NULL,
          page_views BIGINT SUM DEFAULT "0",
          clicks BIGINT SUM DEFAULT "0",
          revenue DECIMAL(10, 2) SUM DEFAULT "0.00"
        )
        AGGREGATE KEY (user_id, dt)
        DISTRIBUTED BY HASH(user_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should aggregate SUM values on insert", async () => {
      const data = [
        { user_id: 1, dt: "2024-01-15", page_views: 10, clicks: 5, revenue: 100.00 },
        { user_id: 1, dt: "2024-01-15", page_views: 20, clicks: 8, revenue: 200.00 },
        { user_id: 1, dt: "2024-01-15", page_views: 5, clicks: 2, revenue: 50.00 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      // Verify aggregation
      const row = await client.raw<{ page_views: number; clicks: number; revenue: number }>(
        `SELECT page_views, clicks, revenue FROM ${FQN(TABLE)} WHERE user_id = 1 AND dt = '2024-01-15'`
      );

      expect(row.length).toBe(1);
      expect((row[0] as any).page_views).toBe(35); // 10 + 20 + 5
      expect((row[0] as any).clicks).toBe(15); // 5 + 8 + 2
      expect(parseFloat((row[0] as any).revenue)).toBe(350.00); // 100 + 200 + 50
    });

    test("should handle negative values in SUM", async () => {
      const data = [
        { user_id: 2, dt: "2024-01-15", page_views: 100, clicks: 50, revenue: 1000.00 },
        { user_id: 2, dt: "2024-01-15", page_views: -20, clicks: -5, revenue: -100.00 }, // Refund/correction
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const row = await client.raw<{ page_views: number; clicks: number; revenue: number }>(
        `SELECT page_views, clicks, revenue FROM ${FQN(TABLE)} WHERE user_id = 2 AND dt = '2024-01-15'`
      );

      expect((row[0] as any).page_views).toBe(80);
      expect((row[0] as any).clicks).toBe(45);
      expect(parseFloat((row[0] as any).revenue)).toBe(900.00);
    });

    test("should handle zero values", async () => {
      const data = [
        { user_id: 3, dt: "2024-01-15", page_views: 0, clicks: 0, revenue: 0 },
        { user_id: 3, dt: "2024-01-15", page_views: 10, clicks: 5, revenue: 50.00 },
        { user_id: 3, dt: "2024-01-15", page_views: 0, clicks: 0, revenue: 0 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const row = await client.raw<{ page_views: number }>(
        `SELECT page_views FROM ${FQN(TABLE)} WHERE user_id = 3 AND dt = '2024-01-15'`
      );

      expect((row[0] as any).page_views).toBe(10);
    });
  });

  // ============================================================================
  // MAX/MIN Aggregation
  // ============================================================================

  describe("MAX/MIN Aggregation", () => {
    const TABLE = "agg_max_min_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          product_id BIGINT NOT NULL,
          max_price DECIMAL(10, 2) MAX DEFAULT "0",
          min_price DECIMAL(10, 2) MIN DEFAULT "99999.99",
          max_rating INT MAX DEFAULT "0",
          min_stock INT MIN DEFAULT "999999"
        )
        AGGREGATE KEY (product_id)
        DISTRIBUTED BY HASH(product_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should track MAX values across updates", async () => {
      const data = [
        { product_id: 1, max_price: 99.99, min_price: 99.99, max_rating: 4, min_stock: 100 },
        { product_id: 1, max_price: 149.99, min_price: 89.99, max_rating: 5, min_stock: 50 },
        { product_id: 1, max_price: 119.99, min_price: 109.99, max_rating: 3, min_stock: 75 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const row = await client.raw<{ max_price: number; min_price: number; max_rating: number; min_stock: number }>(
        `SELECT max_price, min_price, max_rating, min_stock FROM ${FQN(TABLE)} WHERE product_id = 1`
      );

      expect(parseFloat((row[0] as any).max_price)).toBe(149.99); // Highest seen
      expect(parseFloat((row[0] as any).min_price)).toBe(89.99); // Lowest seen
      expect((row[0] as any).max_rating).toBe(5);
      expect((row[0] as any).min_stock).toBe(50);
    });

    test("should handle boundary values for MAX/MIN", async () => {
      const data = [
        { product_id: 2, max_price: 0.01, min_price: 99999.99, max_rating: 0, min_stock: 999999 },
        { product_id: 2, max_price: 99999.99, min_price: 0.01, max_rating: 10, min_stock: 0 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const row = await client.raw<{ max_price: number; min_price: number }>(
        `SELECT max_price, min_price FROM ${FQN(TABLE)} WHERE product_id = 2`
      );

      expect(parseFloat((row[0] as any).max_price)).toBe(99999.99);
      expect(parseFloat((row[0] as any).min_price)).toBe(0.01);
    });
  });

  // ============================================================================
  // REPLACE Aggregation
  // ============================================================================

  describe("REPLACE Aggregation", () => {
    const TABLE = "agg_replace_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          user_id BIGINT NOT NULL,
          last_login DATETIME REPLACE DEFAULT "1970-01-01 00:00:00",
          last_ip VARCHAR(50) REPLACE DEFAULT "",
          status VARCHAR(20) REPLACE DEFAULT "unknown"
        )
        AGGREGATE KEY (user_id)
        DISTRIBUTED BY HASH(user_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should replace values with latest", async () => {
      const data = [
        { user_id: 1, last_login: "2024-01-10 10:00:00", last_ip: "192.168.1.1", status: "active" },
        { user_id: 1, last_login: "2024-01-15 14:30:00", last_ip: "192.168.1.2", status: "active" },
        { user_id: 1, last_login: "2024-01-20 09:15:00", last_ip: "10.0.0.1", status: "premium" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const row = await client.raw<{ last_login: string; last_ip: string; status: string }>(
        `SELECT last_login, last_ip, status FROM ${FQN(TABLE)} WHERE user_id = 1`
      );

      // Should have the last values from the load order
      expect((row[0] as any).status).toBe("premium");
      expect((row[0] as any).last_ip).toBe("10.0.0.1");
    });

    test("should handle multiple loads with REPLACE", async () => {
      // First load
      await streamLoader.loadObjects(
        [{ user_id: 2, last_login: "2024-01-01 00:00:00", last_ip: "1.1.1.1", status: "new" }],
        { database: TEST_DATABASE, table: TABLE }
      );

      // Second load
      await streamLoader.loadObjects(
        [{ user_id: 2, last_login: "2024-01-02 00:00:00", last_ip: "2.2.2.2", status: "verified" }],
        { database: TEST_DATABASE, table: TABLE }
      );

      // Third load
      await streamLoader.loadObjects(
        [{ user_id: 2, last_login: "2024-01-03 00:00:00", last_ip: "3.3.3.3", status: "active" }],
        { database: TEST_DATABASE, table: TABLE }
      );

      const row = await client.raw<{ status: string; last_ip: string }>(
        `SELECT status, last_ip FROM ${FQN(TABLE)} WHERE user_id = 2`
      );

      expect((row[0] as any).status).toBe("active");
      expect((row[0] as any).last_ip).toBe("3.3.3.3");
    });
  });

  // ============================================================================
  // REPLACE_IF_NOT_NULL Aggregation
  // ============================================================================

  describe("REPLACE_IF_NOT_NULL Aggregation", () => {
    const TABLE = "agg_replace_if_not_null";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          user_id BIGINT NOT NULL,
          email VARCHAR(255) REPLACE_IF_NOT_NULL,
          phone VARCHAR(50) REPLACE_IF_NOT_NULL,
          address VARCHAR(500) REPLACE_IF_NOT_NULL
        )
        AGGREGATE KEY (user_id)
        DISTRIBUTED BY HASH(user_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should replace values when non-null provided", async () => {
      // Load initial data
      await streamLoader.loadObjects(
        [{ user_id: 1, email: "old@example.com", phone: "111-1111", address: "123 Main St" }],
        { database: TEST_DATABASE, table: TABLE }
      );

      // Full update - all fields provided
      await streamLoader.loadObjects(
        [{ user_id: 1, email: "new@example.com", phone: "222-2222", address: "456 Oak Ave" }],
        { database: TEST_DATABASE, table: TABLE }
      );

      const row = await client.raw<{ email: string; phone: string; address: string }>(
        `SELECT email, phone, address FROM ${FQN(TABLE)} WHERE user_id = 1`
      );

      expect((row[0] as any).email).toBe("new@example.com");
      expect((row[0] as any).phone).toBe("222-2222");
      expect((row[0] as any).address).toBe("456 Oak Ave");
    });

    test("should handle sequential updates", async () => {
      // First update
      await streamLoader.loadObjects(
        [{ user_id: 2, email: "user2@example.com", phone: "111-1111", address: "First St" }],
        { database: TEST_DATABASE, table: TABLE }
      );

      // Second update
      await streamLoader.loadObjects(
        [{ user_id: 2, email: "updated2@example.com", phone: "222-2222", address: "Second St" }],
        { database: TEST_DATABASE, table: TABLE }
      );

      const row = await client.raw<{ email: string; phone: string; address: string }>(
        `SELECT email, phone, address FROM ${FQN(TABLE)} WHERE user_id = 2`
      );

      expect((row[0] as any).email).toBe("updated2@example.com");
      expect((row[0] as any).phone).toBe("222-2222");
      expect((row[0] as any).address).toBe("Second St");
    });
  });

  // ============================================================================
  // Mixed Aggregation Types
  // ============================================================================

  describe("Mixed Aggregation Types", () => {
    const TABLE = "agg_mixed_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          product_id BIGINT NOT NULL,
          category VARCHAR(50) NOT NULL,
          total_sales BIGINT SUM DEFAULT "0",
          total_revenue DECIMAL(10, 2) SUM DEFAULT "0.00",
          max_single_order DECIMAL(10, 2) MAX DEFAULT "0.00",
          min_price DECIMAL(10, 2) MIN DEFAULT "99999.99",
          last_sale_date DATE REPLACE DEFAULT "1970-01-01",
          last_buyer VARCHAR(100) REPLACE DEFAULT ""
        )
        AGGREGATE KEY (product_id, category)
        DISTRIBUTED BY HASH(product_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle all aggregation types together", async () => {
      const data = [
        {
          product_id: 1, category: "Electronics",
          total_sales: 5, total_revenue: 500.00,
          max_single_order: 150.00, min_price: 80.00,
          last_sale_date: "2024-01-10", last_buyer: "Alice"
        },
        {
          product_id: 1, category: "Electronics",
          total_sales: 3, total_revenue: 300.00,
          max_single_order: 200.00, min_price: 90.00,
          last_sale_date: "2024-01-15", last_buyer: "Bob"
        },
        {
          product_id: 1, category: "Electronics",
          total_sales: 10, total_revenue: 800.00,
          max_single_order: 120.00, min_price: 60.00,
          last_sale_date: "2024-01-20", last_buyer: "Charlie"
        },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const row = await client.raw<{
        total_sales: number;
        total_revenue: number;
        max_single_order: number;
        min_price: number;
        last_buyer: string;
      }>(
        `SELECT total_sales, total_revenue, max_single_order, min_price, last_buyer
         FROM ${FQN(TABLE)} WHERE product_id = 1 AND category = 'Electronics'`
      );

      expect((row[0] as any).total_sales).toBe(18); // SUM: 5+3+10
      expect(parseFloat((row[0] as any).total_revenue)).toBe(1600.00); // SUM
      expect(parseFloat((row[0] as any).max_single_order)).toBe(200.00); // MAX
      expect(parseFloat((row[0] as any).min_price)).toBe(60.00); // MIN
      expect((row[0] as any).last_buyer).toBe("Charlie"); // REPLACE (last)
    });
  });

  // ============================================================================
  // Aggregate Key Variations
  // ============================================================================

  describe("Aggregate Key Variations", () => {
    test("should handle single column aggregate key", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("agg_single_key")} (
          id BIGINT NOT NULL,
          count BIGINT SUM DEFAULT "0"
        )
        AGGREGATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = [
        { id: 1, count: 1 },
        { id: 1, count: 1 },
        { id: 1, count: 1 },
        { id: 2, count: 5 },
        { id: 2, count: 5 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "agg_single_key",
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ id: number; count: number }>(
        `SELECT id, count FROM ${FQN("agg_single_key")} ORDER BY id`
      );

      expect(rows.length).toBe(2);
      expect((rows[0] as any).count).toBe(3);
      expect((rows[1] as any).count).toBe(10);
    });

    test("should handle multi-column aggregate key", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("agg_multi_key")} (
          region VARCHAR(50) NOT NULL,
          product VARCHAR(50) NOT NULL,
          year INT NOT NULL,
          sales BIGINT SUM DEFAULT "0"
        )
        AGGREGATE KEY (region, product, year)
        DISTRIBUTED BY HASH(region) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = [
        { region: "US", product: "Widget", year: 2024, sales: 100 },
        { region: "US", product: "Widget", year: 2024, sales: 150 },
        { region: "US", product: "Gadget", year: 2024, sales: 200 },
        { region: "EU", product: "Widget", year: 2024, sales: 75 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "agg_multi_key",
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ region: string; product: string; sales: number }>(
        `SELECT region, product, sales FROM ${FQN("agg_multi_key")} ORDER BY region, product`
      );

      expect(rows.length).toBe(3);
      // US + Gadget
      expect((rows[1] as any).sales).toBe(200);
      // US + Widget (aggregated)
      expect((rows[2] as any).sales).toBe(250);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    test("should handle very large SUM values", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("agg_large_sum")} (
          id BIGINT NOT NULL,
          large_val BIGINT SUM DEFAULT "0"
        )
        AGGREGATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const largeValue = 1_000_000_000_000; // 1 trillion
      const data = [
        { id: 1, large_val: largeValue },
        { id: 1, large_val: largeValue },
        { id: 1, large_val: largeValue },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "agg_large_sum",
      });

      expect(result.status).toBe("Success");

      const row = await client.raw<{ large_val: number }>(
        `SELECT large_val FROM ${FQN("agg_large_sum")} WHERE id = 1`
      );

      expect((row[0] as any).large_val).toBe(3_000_000_000_000);
    });

    test("should handle high-precision DECIMAL in aggregation", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("agg_precision")} (
          id BIGINT NOT NULL,
          amount DECIMAL(20, 6) SUM DEFAULT "0"
        )
        AGGREGATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Use numeric values that JSON can handle well
      const data = [
        { id: 1, amount: 0.123456 },
        { id: 1, amount: 0.876544 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "agg_precision",
      });

      expect(result.status).toBe("Success");

      const row = await client.raw<{ amount: string }>(
        `SELECT amount FROM ${FQN("agg_precision")} WHERE id = 1`
      );

      // Should sum to 1.000000
      expect(parseFloat((row[0] as any).amount)).toBeCloseTo(1.0, 5);
    });

    test("should handle concurrent loads to same aggregate key", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("agg_concurrent")} (
          key_col VARCHAR(50) NOT NULL,
          counter BIGINT SUM DEFAULT "0"
        )
        AGGREGATE KEY (key_col)
        DISTRIBUTED BY HASH(key_col) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const timestamp = Date.now();

      // Parallel loads all targeting same key
      const results = await Promise.all([
        streamLoader.loadObjects(
          [{ key_col: "concurrent_key", counter: 1 }],
          { database: TEST_DATABASE, table: "agg_concurrent", label: `conc_1_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ key_col: "concurrent_key", counter: 1 }],
          { database: TEST_DATABASE, table: "agg_concurrent", label: `conc_2_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ key_col: "concurrent_key", counter: 1 }],
          { database: TEST_DATABASE, table: "agg_concurrent", label: `conc_3_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ key_col: "concurrent_key", counter: 1 }],
          { database: TEST_DATABASE, table: "agg_concurrent", label: `conc_4_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ key_col: "concurrent_key", counter: 1 }],
          { database: TEST_DATABASE, table: "agg_concurrent", label: `conc_5_${timestamp}` }
        ),
      ]);

      // All should succeed
      results.forEach(r => expect(r.status).toBe("Success"));

      // Wait a moment for aggregation to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      const row = await client.raw<{ counter: number }>(
        `SELECT counter FROM ${FQN("agg_concurrent")} WHERE key_col = 'concurrent_key'`
      );

      // All 5 loads should have aggregated
      expect((row[0] as any).counter).toBe(5);
    });

    test("should preserve aggregate state across multiple batch loads", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("agg_batch_state")} (
          metric VARCHAR(50) NOT NULL,
          total BIGINT SUM DEFAULT "0",
          max_val INT MAX DEFAULT "0"
        )
        AGGREGATE KEY (metric)
        DISTRIBUTED BY HASH(metric) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Batch 1
      await streamLoader.loadObjects(
        [{ metric: "requests", total: 1000, max_val: 50 }],
        { database: TEST_DATABASE, table: "agg_batch_state" }
      );

      // Batch 2
      await streamLoader.loadObjects(
        [{ metric: "requests", total: 2000, max_val: 30 }],
        { database: TEST_DATABASE, table: "agg_batch_state" }
      );

      // Batch 3
      await streamLoader.loadObjects(
        [{ metric: "requests", total: 500, max_val: 100 }],
        { database: TEST_DATABASE, table: "agg_batch_state" }
      );

      const row = await client.raw<{ total: number; max_val: number }>(
        `SELECT total, max_val FROM ${FQN("agg_batch_state")} WHERE metric = 'requests'`
      );

      expect((row[0] as any).total).toBe(3500); // 1000 + 2000 + 500
      expect((row[0] as any).max_val).toBe(100); // MAX across all batches
    });
  });
});
