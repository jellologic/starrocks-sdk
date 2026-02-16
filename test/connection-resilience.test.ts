import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, type StarRocksClient } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import type { TableOptions } from "../src/types";

/**
 * Connection Resilience Tests
 *
 * Tests connection pool behavior, parallel queries, timeout handling,
 * and graceful error recovery.
 *
 * Note: We use fully qualified table names ({database}.{table}) because
 * useDatabase only affects the connection it runs on, and the pool may
 * use different connections for subsequent queries.
 */
describe("StarRocks Connection Resilience", () => {
  let client: StarRocksClient;
  const FQ_TABLE = `${TEST_DATABASE}.connection_test`; // Fully qualified name

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);

    // Create test table using fully qualified name
    const options: TableOptions = {
      keyType: "PRIMARY",
      keys: ["id"],
      distribution: {
        type: "HASH",
        columns: ["id"],
        buckets: 4,
      },
      properties: {
        replication_num: 1,
      },
    };

    await client.execute(`CREATE TABLE IF NOT EXISTS ${FQ_TABLE} (
      id BIGINT NOT NULL,
      name VARCHAR(255),
      value DOUBLE
    )
    PRIMARY KEY(id)
    DISTRIBUTED BY HASH(id) BUCKETS 4
    PROPERTIES ("replication_num" = "1")`);

    // Insert test data
    await client.execute(`INSERT INTO ${FQ_TABLE} (id, name, value) VALUES
      (1, 'Test1', 100.0),
      (2, 'Test2', 200.0),
      (3, 'Test3', 300.0)`);
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  describe("Connection Pool Basics", () => {
    test("single query should use pooled connection", async () => {
      const rows = await client.raw<{ id: number }>(
        `SELECT * FROM ${FQ_TABLE} WHERE id = 1`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(1);
    });

    test("sequential queries should reuse connections", async () => {
      for (let i = 0; i < 10; i++) {
        const rows = await client.raw<{ id: number }>(
          `SELECT * FROM ${FQ_TABLE} LIMIT 1`
        );
        expect(rows.length).toBeGreaterThan(0);
      }
    });

    test("pool should handle many sequential operations", async () => {
      // 100 sequential queries
      for (let i = 0; i < 100; i++) {
        await client.raw(`SELECT 1 AS result`);
      }
    });
  });

  describe("Parallel Query Handling", () => {
    test("should handle 10 parallel queries", async () => {
      const queries = Array.from({ length: 10 }, (_, i) =>
        client.raw<{ id: number }>(`SELECT * FROM ${FQ_TABLE} WHERE id = ${(i % 3) + 1}`)
      );

      const results = await Promise.all(queries);

      results.forEach((rows) => {
        expect(rows).toHaveLength(1);
      });
    });

    test("should handle 50 parallel SELECT queries", async () => {
      const queries = Array.from({ length: 50 }, () =>
        client.raw<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${FQ_TABLE}`)
      );

      const results = await Promise.all(queries);

      results.forEach((rows) => {
        expect(rows).toHaveLength(1);
        expect(Number(rows[0]?.cnt)).toBe(3);
      });
    });

    test("should handle mixed parallel operations", async () => {
      const operations = [
        // SELECT queries
        client.raw(`SELECT * FROM ${FQ_TABLE} WHERE id = 1`),
        client.raw(`SELECT * FROM ${FQ_TABLE} WHERE id = 2`),
        client.raw(`SELECT COUNT(*) as cnt FROM ${FQ_TABLE}`),
        // More SELECTs
        client.raw(`SELECT MAX(value) as max_val FROM ${FQ_TABLE}`),
        client.raw(`SELECT MIN(value) as min_val FROM ${FQ_TABLE}`),
        client.raw(`SELECT AVG(value) as avg_val FROM ${FQ_TABLE}`),
        // Simple queries
        client.raw(`SELECT 1`),
        client.raw(`SELECT 2`),
        client.raw(`SELECT 3`),
        client.raw(`SHOW DATABASES`),
      ];

      const results = await Promise.all(operations);
      expect(results).toHaveLength(10);
      results.forEach((result) => {
        expect(result).toBeDefined();
      });
    });

    test("should handle parallel queries with varying complexity", async () => {
      const queries = [
        // Simple queries
        client.raw(`SELECT 1`),
        client.raw(`SELECT 2`),
        // Slightly more complex
        client.raw(`SELECT * FROM ${FQ_TABLE} LIMIT 1`),
        client.raw(`SELECT * FROM ${FQ_TABLE} LIMIT 2`),
        // Aggregations
        client.raw(`SELECT COUNT(*) as cnt FROM ${FQ_TABLE}`),
        client.raw(`SELECT SUM(value) as total FROM ${FQ_TABLE}`),
      ];

      const results = await Promise.all(queries);
      expect(results).toHaveLength(6);
    });
  });

  describe("Error Recovery", () => {
    test("connection should recover after query syntax error", async () => {
      // First, cause a syntax error
      try {
        await client.raw(`INVALID SQL SYNTAX`);
      } catch (error) {
        // Expected to fail
      }

      // Connection should still work
      const rows = await client.raw<{ id: number }>(
        `SELECT * FROM ${FQ_TABLE} WHERE id = 1`
      );
      expect(rows).toHaveLength(1);
    });

    test("connection should recover after non-existent table error", async () => {
      // Try to query non-existent table
      try {
        await client.raw(`SELECT * FROM ${TEST_DATABASE}.nonexistent_table_xyz`);
      } catch (error) {
        // Expected to fail
      }

      // Connection should still work
      const rows = await client.raw<{ id: number }>(
        `SELECT * FROM ${FQ_TABLE}`
      );
      expect(rows).toHaveLength(3);
    });

    test("connection should recover after multiple errors", async () => {
      // Cause multiple errors
      for (let i = 0; i < 5; i++) {
        try {
          await client.raw(`SELECT * FROM ${TEST_DATABASE}.fake_table_${i}`);
        } catch (error) {
          // Expected
        }
      }

      // Connection should still work
      const rows = await client.raw<{ result: number }>(
        `SELECT 1 as result`
      );
      expect(rows[0]?.result).toBe(1);
    });

    test("parallel queries should recover after some failures", async () => {
      const queries = [
        // Good queries
        client.raw(`SELECT * FROM ${FQ_TABLE} WHERE id = 1`),
        client.raw(`SELECT * FROM ${FQ_TABLE} WHERE id = 2`),
        // Bad queries (will fail)
        client.raw(`SELECT * FROM ${TEST_DATABASE}.nonexistent1`).catch(() => null),
        client.raw(`SELECT * FROM ${TEST_DATABASE}.nonexistent2`).catch(() => null),
        // More good queries
        client.raw(`SELECT * FROM ${FQ_TABLE} WHERE id = 3`),
        client.raw(`SELECT COUNT(*) FROM ${FQ_TABLE}`),
      ];

      const results = await Promise.all(queries);

      // Good queries should succeed
      expect(results[0]).toHaveLength(1);
      expect(results[1]).toHaveLength(1);
      expect(results[4]).toHaveLength(1);

      // Bad queries should be null (caught errors)
      expect(results[2]).toBeNull();
      expect(results[3]).toBeNull();
    });
  });

  describe("DDL Operations", () => {
    test("should handle parallel DDL operations safely", async () => {
      // Create multiple temp tables in parallel
      const creates = Array.from({ length: 5 }, (_, i) =>
        client.execute(`CREATE TABLE IF NOT EXISTS ${TEST_DATABASE}.temp_parallel_${i} (
          id BIGINT NOT NULL
        )
        DUPLICATE KEY(id)
        DISTRIBUTED BY HASH(id) BUCKETS 2
        PROPERTIES ("replication_num" = "1")`)
      );

      await Promise.all(creates);

      // Verify all tables exist
      const tables = await client.raw<{ Tables_in_starrocks_test: string }>(
        `SHOW TABLES FROM ${TEST_DATABASE}`
      );
      const tableNames = tables.map(t => Object.values(t)[0]);
      for (let i = 0; i < 5; i++) {
        expect(tableNames).toContain(`temp_parallel_${i}`);
      }

      // Drop all temp tables in parallel
      const drops = Array.from({ length: 5 }, (_, i) =>
        client.execute(`DROP TABLE IF EXISTS ${TEST_DATABASE}.temp_parallel_${i}`)
      );
      await Promise.all(drops);
    });

    test("sequential DDL operations should be stable", async () => {
      // Create and drop tables sequentially
      for (let i = 0; i < 5; i++) {
        await client.execute(`CREATE TABLE IF NOT EXISTS ${TEST_DATABASE}.temp_seq_${i} (
          id BIGINT NOT NULL
        )
        DUPLICATE KEY(id)
        DISTRIBUTED BY HASH(id) BUCKETS 2
        PROPERTIES ("replication_num" = "1")`);

        // Check existence
        const tables = await client.raw<Record<string, string>>(
          `SHOW TABLES FROM ${TEST_DATABASE} LIKE 'temp_seq_${i}'`
        );
        expect(tables.length).toBeGreaterThan(0);

        await client.execute(`DROP TABLE IF EXISTS ${TEST_DATABASE}.temp_seq_${i}`);
      }
    });
  });

  describe("Insert Operations Under Load", () => {
    test("should handle parallel inserts to same table", async () => {
      // Create a temp table for this test
      await client.execute(`CREATE TABLE IF NOT EXISTS ${TEST_DATABASE}.parallel_insert_test (
        id BIGINT NOT NULL,
        value DOUBLE
      )
      DUPLICATE KEY(id)
      DISTRIBUTED BY HASH(id) BUCKETS 4
      PROPERTIES ("replication_num" = "1")`);

      // Parallel inserts
      const inserts = Array.from({ length: 20 }, (_, i) =>
        client.execute(`INSERT INTO ${TEST_DATABASE}.parallel_insert_test (id, value) VALUES (${i}, ${i * 10.0})`)
      );

      await Promise.all(inserts);

      // Verify count
      const result = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${TEST_DATABASE}.parallel_insert_test`
      );
      expect(Number(result[0]?.cnt)).toBe(20);

      await client.execute(`DROP TABLE IF EXISTS ${TEST_DATABASE}.parallel_insert_test`);
    });

    test("should handle batch insert followed by queries", async () => {
      // Create temp table
      await client.execute(`CREATE TABLE IF NOT EXISTS ${TEST_DATABASE}.batch_query_test (
        id BIGINT NOT NULL,
        name VARCHAR(100)
      )
      DUPLICATE KEY(id)
      DISTRIBUTED BY HASH(id) BUCKETS 4
      PROPERTIES ("replication_num" = "1")`);

      // Batch insert using VALUES list
      const valuesList = Array.from({ length: 100 }, (_, i) =>
        `(${i}, 'Item_${i}')`
      ).join(",\n");
      await client.execute(`INSERT INTO ${TEST_DATABASE}.batch_query_test (id, name) VALUES ${valuesList}`);

      // Parallel queries immediately after
      const queries = Array.from({ length: 10 }, (_, i) =>
        client.raw<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${TEST_DATABASE}.batch_query_test WHERE id >= ${i * 10}`)
      );
      const results = await Promise.all(queries);

      results.forEach((rows) => {
        expect(Number(rows[0]?.cnt)).toBeGreaterThanOrEqual(0);
      });

      await client.execute(`DROP TABLE IF EXISTS ${TEST_DATABASE}.batch_query_test`);
    });
  });

  describe("Connection Pool Exhaustion", () => {
    test("should queue queries when pool is busy", async () => {
      // Create many parallel queries that exceed connection limit (10)
      // The pool should queue excess queries
      // Note: SLEEP() function might not be available in StarRocks, use simple queries instead
      const queries = Array.from({ length: 30 }, () =>
        client.raw(`SELECT 1 AS result`)
      );

      const results = await Promise.all(queries);

      // All queries should succeed
      expect(results).toHaveLength(30);
      results.forEach((rows) => {
        expect(rows[0]).toBeDefined();
      });
    });

    test("should handle burst of parallel queries", async () => {
      // Start 50 queries in burst
      const queries = Array.from({ length: 50 }, () =>
        client.raw(`SELECT 1 AS fast_result`)
      );

      const results = await Promise.all(queries);

      expect(results).toHaveLength(50);
    });
  });

  describe("Multiple Client Instances", () => {
    test("multiple clients should work independently", async () => {
      const client1 = createStarRocksClient(testConfig);
      const client2 = createStarRocksClient(testConfig);

      // Parallel queries from different clients using FQ names
      const [result1, result2] = await Promise.all([
        client1.raw<{ id: number }>(`SELECT * FROM ${FQ_TABLE} WHERE id = 1`),
        client2.raw<{ id: number }>(`SELECT * FROM ${FQ_TABLE} WHERE id = 2`),
      ]);

      expect(result1[0]?.id).toBe(1);
      expect(result2[0]?.id).toBe(2);

      await client1.close();
      await client2.close();
    });

    test("one client closing should not affect others", async () => {
      const client1 = createStarRocksClient(testConfig);
      const client2 = createStarRocksClient(testConfig);

      // Close client1
      await client1.close();

      // client2 should still work
      const result = await client2.raw<{ id: number }>(
        `SELECT * FROM ${FQ_TABLE} WHERE id = 1`
      );
      expect(result[0]?.id).toBe(1);

      await client2.close();
    });

    test("clients should be isolated in their connections", async () => {
      const client1 = createStarRocksClient(testConfig);
      const client2 = createStarRocksClient(testConfig);

      // Queries should work independently
      const [tables1, tables2] = await Promise.all([
        client1.raw(`SHOW DATABASES`),
        client2.raw(`SHOW DATABASES`),
      ]);

      expect(tables1.length).toBeGreaterThan(0);
      expect(tables2.length).toBeGreaterThan(0);

      await client1.close();
      await client2.close();
    });
  });

  describe("Edge Cases", () => {
    test("empty result set should not cause issues", async () => {
      const rows = await client.raw(
        `SELECT * FROM ${FQ_TABLE} WHERE id = 999999`
      );
      expect(rows).toHaveLength(0);
    });

    test("null values should be handled correctly", async () => {
      // Create table with nullable column
      await client.execute(`CREATE TABLE IF NOT EXISTS ${TEST_DATABASE}.null_test (
        id BIGINT NOT NULL,
        value VARCHAR(100)
      )
      DUPLICATE KEY(id)
      DISTRIBUTED BY HASH(id) BUCKETS 2
      PROPERTIES ("replication_num" = "1")`);

      // Insert with null value
      await client.execute(`INSERT INTO ${TEST_DATABASE}.null_test (id, value) VALUES (1, NULL)`);

      const rows = await client.raw<{ id: number; value: string | null }>(
        `SELECT * FROM ${TEST_DATABASE}.null_test`
      );
      expect(rows[0]?.value).toBeNull();

      await client.execute(`DROP TABLE IF EXISTS ${TEST_DATABASE}.null_test`);
    });

    test("very long string values should be handled", async () => {
      // Create table with large varchar
      await client.execute(`CREATE TABLE IF NOT EXISTS ${TEST_DATABASE}.long_string_test (
        id BIGINT NOT NULL,
        content VARCHAR(65535)
      )
      DUPLICATE KEY(id)
      DISTRIBUTED BY HASH(id) BUCKETS 2
      PROPERTIES ("replication_num" = "1")`);

      // Insert long string (10KB)
      const longString = "x".repeat(10000);
      await client.execute(`INSERT INTO ${TEST_DATABASE}.long_string_test (id, content) VALUES (1, '${longString}')`);

      const rows = await client.raw<{ content: string }>(
        `SELECT content FROM ${TEST_DATABASE}.long_string_test WHERE id = 1`
      );
      expect(rows[0]?.content.length).toBe(10000);

      await client.execute(`DROP TABLE IF EXISTS ${TEST_DATABASE}.long_string_test`);
    });

    test("special characters in data should be handled", async () => {
      // Create temp table
      await client.execute(`CREATE TABLE IF NOT EXISTS ${TEST_DATABASE}.special_char_test (
        id BIGINT NOT NULL,
        content VARCHAR(255)
      )
      DUPLICATE KEY(id)
      DISTRIBUTED BY HASH(id) BUCKETS 2
      PROPERTIES ("replication_num" = "1")`);

      // Insert with special characters - escape single quotes
      await client.execute(`INSERT INTO ${TEST_DATABASE}.special_char_test (id, content) VALUES (1, 'Hello ''World'' with quotes')`);

      const rows = await client.raw<{ content: string }>(
        `SELECT content FROM ${TEST_DATABASE}.special_char_test WHERE id = 1`
      );
      expect(rows[0]?.content).toContain("'World'");

      await client.execute(`DROP TABLE IF EXISTS ${TEST_DATABASE}.special_char_test`);
    });

    test("rapid open/close should not cause issues", async () => {
      for (let i = 0; i < 10; i++) {
        const tempClient = createStarRocksClient(testConfig);
        const rows = await tempClient.raw(`SELECT 1 AS result`);
        expect(rows).toHaveLength(1);
        await tempClient.close();
      }
    });
  });

  describe("Information Schema Queries", () => {
    test("should handle information_schema queries", async () => {
      const result = await client.raw(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${TEST_DATABASE}' LIMIT 10`
      );
      expect(Array.isArray(result)).toBe(true);
    });

    test("parallel information_schema queries should work", async () => {
      const queries = [
        client.raw(`SELECT COUNT(*) as cnt FROM information_schema.TABLES`),
        client.raw(`SELECT COUNT(*) as cnt FROM information_schema.COLUMNS`),
        client.raw(`SELECT COUNT(*) as cnt FROM information_schema.SCHEMATA`),
      ];

      const results = await Promise.all(queries);
      results.forEach((rows) => {
        expect(rows).toHaveLength(1);
      });
    });
  });
});
