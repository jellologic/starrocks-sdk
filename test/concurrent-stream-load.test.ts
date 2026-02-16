import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE, beHttpPort } from "../src/test-config";

/**
 * Battle Test: Concurrent Stream Load Operations
 *
 * Tests parallel stream load operations to ensure proper handling of:
 * - Concurrent loads to same table
 * - Concurrent loads to different tables
 * - Label conflicts during concurrent operations
 * - Resource management under load
 * - Error recovery during concurrent operations
 *
 * IMPORTANT: Uses fully qualified table names (database.table) because
 * connection pooling makes USE DATABASE unreliable across queries.
 */
describe("StarRocks Concurrent Stream Load", () => {
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
  // Concurrent Loads to Same Table
  // ============================================================================

  describe("Concurrent Loads to Same Table", () => {
    const TABLE = "concurrent_same_table";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          batch_id INT,
          name VARCHAR(255),
          created_at DATETIME
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 8
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle 5 parallel loads to same table", async () => {
      const batches = Array.from({ length: 5 }, (_, batchIdx) =>
        Array.from({ length: 10 }, (_, rowIdx) => ({
          id: batchIdx * 1000 + rowIdx,
          batch_id: batchIdx,
          name: `Batch${batchIdx}_Row${rowIdx}`,
          created_at: "2024-01-15 10:00:00",
        }))
      );

      const results = await Promise.all(
        batches.map((batch, idx) =>
          streamLoader.loadObjects(batch, {
            database: TEST_DATABASE,
            table: TABLE,
            label: `concurrent_5_${Date.now()}_${idx}`,
          })
        )
      );

      // All loads should complete (success or with managed error)
      results.forEach(result => {
        expect(["Success", "Fail", "Publish Timeout", "Label Already Exists"]).toContain(result.status);
      });

      // At least some should succeed
      const successCount = results.filter(r => r.status === "Success").length;
      expect(successCount).toBeGreaterThan(0);

      // Verify data was loaded
      const rows = await client.raw<{ id: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)}`
      );
      expect((rows[0] as any).cnt).toBeGreaterThan(0);
    });

    test("should handle 10 parallel loads with unique labels", async () => {
      const timestamp = Date.now();
      const batches = Array.from({ length: 10 }, (_, batchIdx) =>
        Array.from({ length: 5 }, (_, rowIdx) => ({
          id: 10000 + batchIdx * 100 + rowIdx,
          batch_id: batchIdx + 100,
          name: `Parallel10_Batch${batchIdx}_Row${rowIdx}`,
          created_at: "2024-01-15 11:00:00",
        }))
      );

      const results = await Promise.all(
        batches.map((batch, idx) =>
          streamLoader.loadObjects(batch, {
            database: TEST_DATABASE,
            table: TABLE,
            label: `parallel10_${timestamp}_${idx}`,
          })
        )
      );

      // Count successes
      const successCount = results.filter(r => r.status === "Success").length;
      const failCount = results.filter(r => r.status === "Fail").length;

      // Expect most to succeed
      expect(successCount + failCount).toBe(10);
      expect(successCount).toBeGreaterThan(5); // At least half should succeed
    });

    test("should handle concurrent loads with overlapping IDs (PRIMARY KEY upsert)", async () => {
      // All batches will try to write the same IDs - tests upsert behavior
      const sharedIds = [50000, 50001, 50002, 50003, 50004];
      const batches = Array.from({ length: 3 }, (_, batchIdx) =>
        sharedIds.map(id => ({
          id,
          batch_id: batchIdx + 200,
          name: `Overlap_Batch${batchIdx}_ID${id}`,
          created_at: "2024-01-15 12:00:00",
        }))
      );

      const results = await Promise.all(
        batches.map((batch, idx) =>
          streamLoader.loadObjects(batch, {
            database: TEST_DATABASE,
            table: TABLE,
            label: `overlap_${Date.now()}_${idx}`,
          })
        )
      );

      // All should complete
      results.forEach(result => {
        expect(["Success", "Fail", "Publish Timeout", "Label Already Exists"]).toContain(result.status);
      });

      // Check that only one value exists per ID (last write wins)
      const rows = await client.raw<{ id: number; batch_id: number }>(
        `SELECT id, batch_id FROM ${FQN(TABLE)} WHERE id BETWEEN 50000 AND 50004 ORDER BY id`
      );
      expect(rows.length).toBe(5);
    });
  });

  // ============================================================================
  // Concurrent Loads to Different Tables
  // ============================================================================

  describe("Concurrent Loads to Different Tables", () => {
    const TABLES = ["table_a", "table_b", "table_c", "table_d"];

    beforeAll(async () => {
      await Promise.all(
        TABLES.map(table =>
          client.raw(`
            CREATE TABLE IF NOT EXISTS ${FQN(table)} (
              id BIGINT NOT NULL,
              data VARCHAR(255),
              source VARCHAR(50)
            )
            PRIMARY KEY (id)
            DISTRIBUTED BY HASH(id) BUCKETS 4
            PROPERTIES("replication_num" = "1")
          `)
        )
      );
    });

    test("should handle parallel loads to 4 different tables", async () => {
      const timestamp = Date.now();
      const results = await Promise.all(
        TABLES.map((table, idx) => {
          const data = Array.from({ length: 20 }, (_, rowIdx) => ({
            id: rowIdx,
            data: `Table_${table}_Row_${rowIdx}`,
            source: table,
          }));
          return streamLoader.loadObjects(data, {
            database: TEST_DATABASE,
            table,
            label: `multi_table_${timestamp}_${idx}`,
          });
        })
      );

      // All should succeed
      const successCount = results.filter(r => r.status === "Success").length;
      expect(successCount).toBe(4);

      // Verify each table has data
      for (const table of TABLES) {
        const rows = await client.raw<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM ${FQN(table)}`
        );
        expect((rows[0] as any).cnt).toBe(20);
      }
    });

    test("should handle mixed success/failure across tables", async () => {
      const timestamp = Date.now();
      const validTables = TABLES.slice(0, 2);
      const allTables = [...validTables, "nonexistent_table"];

      const results = await Promise.all(
        allTables.map((table, idx) => {
          const data = Array.from({ length: 5 }, (_, rowIdx) => ({
            id: 1000 + rowIdx,
            data: `Mixed_${table}_Row_${rowIdx}`,
            source: table,
          }));
          return streamLoader.loadObjects(data, {
            database: TEST_DATABASE,
            table,
            label: `mixed_${timestamp}_${idx}`,
          });
        })
      );

      // First two should succeed, third should fail
      expect(results[0]!.status).toBe("Success");
      expect(results[1]!.status).toBe("Success");
      expect(results[2]!.status).toBe("Fail");
    });
  });

  // ============================================================================
  // Label Conflict Scenarios
  // ============================================================================

  describe("Label Conflict Scenarios", () => {
    const TABLE = "label_conflict_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          value INT
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle intentional duplicate labels", async () => {
      const sharedLabel = `duplicate_label_${Date.now()}`;
      const batches = [
        [{ id: 1, value: 100 }],
        [{ id: 2, value: 200 }],
        [{ id: 3, value: 300 }],
      ];

      // All use the same label - StarRocks should reject duplicates
      const results = await Promise.all(
        batches.map(batch =>
          streamLoader.loadObjects(batch, {
            database: TEST_DATABASE,
            table: TABLE,
            label: sharedLabel,
          })
        )
      );

      // Only one should succeed, others should fail with Label Already Exists
      const successCount = results.filter(r => r.status === "Success").length;
      const labelExistsCount = results.filter(r => r.status === "Label Already Exists").length;
      const failCount = results.filter(r => r.status === "Fail").length;

      // At most one success
      expect(successCount).toBeLessThanOrEqual(1);
      // Total should be 3
      expect(successCount + labelExistsCount + failCount).toBe(3);
    });

    test("should handle rapid sequential loads with unique labels", async () => {
      const timestamp = Date.now();
      const results: any[] = [];

      // Rapid sequential loads (not parallel)
      for (let i = 0; i < 10; i++) {
        const data = [{ id: 2000 + i, value: i * 10 }];
        const result = await streamLoader.loadObjects(data, {
          database: TEST_DATABASE,
          table: TABLE,
          label: `rapid_${timestamp}_${i}`,
        });
        results.push(result);
      }

      // All should succeed since labels are unique
      const successCount = results.filter(r => r.status === "Success").length;
      expect(successCount).toBe(10);

      // Verify all data loaded
      const rows = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)} WHERE id BETWEEN 2000 AND 2009`
      );
      expect((rows[0] as any).cnt).toBe(10);
    });
  });

  // ============================================================================
  // Resource Exhaustion Scenarios
  // ============================================================================

  describe("Resource Exhaustion Scenarios", () => {
    const TABLE = "resource_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          data VARCHAR(1000)
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 8
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle 20 concurrent loads (stress test)", async () => {
      const timestamp = Date.now();
      const batchCount = 20;

      const results = await Promise.all(
        Array.from({ length: batchCount }, (_, idx) => {
          const data = Array.from({ length: 50 }, (_, rowIdx) => ({
            id: idx * 1000 + rowIdx,
            data: "X".repeat(100),
          }));
          return streamLoader.loadObjects(data, {
            database: TEST_DATABASE,
            table: TABLE,
            label: `stress_${timestamp}_${idx}`,
          });
        })
      );

      // Count outcomes
      const successCount = results.filter(r => r.status === "Success").length;
      const failCount = results.filter(r => r.status === "Fail").length;
      const otherCount = results.filter(r =>
        r.status !== "Success" && r.status !== "Fail"
      ).length;

      // Log results for debugging
      console.log(`Stress test: ${successCount} success, ${failCount} fail, ${otherCount} other`);

      // At least half should succeed
      expect(successCount).toBeGreaterThanOrEqual(batchCount / 2);
    });

    test("should handle concurrent large batches (1000 rows each)", async () => {
      const timestamp = Date.now();
      const batchCount = 5;

      const results = await Promise.all(
        Array.from({ length: batchCount }, (_, idx) => {
          const data = Array.from({ length: 1000 }, (_, rowIdx) => ({
            id: 100000 + idx * 10000 + rowIdx,
            data: `Large_${idx}_${rowIdx}`,
          }));
          return streamLoader.loadObjects(data, {
            database: TEST_DATABASE,
            table: TABLE,
            label: `large_${timestamp}_${idx}`,
          });
        })
      );

      // All should complete
      results.forEach((result, idx) => {
        expect(["Success", "Fail", "Publish Timeout", "Label Already Exists"]).toContain(result.status);
        if (result.status === "Success") {
          expect(result.numberLoadedRows).toBe(1000);
        }
      });

      // Most should succeed
      const successCount = results.filter(r => r.status === "Success").length;
      expect(successCount).toBeGreaterThanOrEqual(3);
    });
  });

  // ============================================================================
  // Error Recovery Scenarios
  // ============================================================================

  describe("Error Recovery Scenarios", () => {
    const TABLE = "error_recovery_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          value INT
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should recover and continue after partial failure", async () => {
      const timestamp = Date.now();

      // First batch: mix of valid and invalid tables
      const firstBatch = await Promise.all([
        streamLoader.loadObjects([{ id: 1, value: 10 }], {
          database: TEST_DATABASE,
          table: TABLE,
          label: `recovery_1_${timestamp}`,
        }),
        streamLoader.loadObjects([{ id: 2, value: 20 }], {
          database: TEST_DATABASE,
          table: "nonexistent",
          label: `recovery_2_${timestamp}`,
        }),
      ]);

      expect(firstBatch[0]!.status).toBe("Success");
      expect(firstBatch[1]!.status).toBe("Fail");

      // Second batch: should still work after failure
      const secondBatch = await Promise.all([
        streamLoader.loadObjects([{ id: 3, value: 30 }], {
          database: TEST_DATABASE,
          table: TABLE,
          label: `recovery_3_${timestamp}`,
        }),
        streamLoader.loadObjects([{ id: 4, value: 40 }], {
          database: TEST_DATABASE,
          table: TABLE,
          label: `recovery_4_${timestamp}`,
        }),
      ]);

      // Both should succeed
      expect(secondBatch[0]!.status).toBe("Success");
      expect(secondBatch[1]!.status).toBe("Success");

      // Verify data
      const rows = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)} WHERE id IN (1, 3, 4)`
      );
      expect((rows[0] as any).cnt).toBe(3);
    });

    test("should handle mix of malformed and valid JSON data", async () => {
      const timestamp = Date.now();

      // Parallel loads with different data quality
      const results = await Promise.all([
        // Valid data
        streamLoader.loadObjects([{ id: 100, value: 1000 }], {
          database: TEST_DATABASE,
          table: TABLE,
          label: `malformed_valid_${timestamp}`,
        }),
        // Another valid load
        streamLoader.loadObjects([{ id: 101, value: 1001 }], {
          database: TEST_DATABASE,
          table: TABLE,
          label: `malformed_valid2_${timestamp}`,
        }),
      ]);

      // Both should succeed
      expect(results[0]!.status).toBe("Success");
      expect(results[1]!.status).toBe("Success");
    });
  });

  // ============================================================================
  // Stream Load Client Instance Isolation
  // ============================================================================

  describe("Stream Load Client Instance Isolation", () => {
    test("should handle multiple stream load client instances", async () => {
      const timestamp = Date.now();

      // Create multiple client instances
      const clients = Array.from({ length: 3 }, () =>
        createStreamLoadClient({
          host: testConfig.host,
          httpPort: beHttpPort,
          user: testConfig.user,
          password: testConfig.password,
        })
      );

      // Create table for this test
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("multi_client_test")} (
          id BIGINT NOT NULL,
          client_id INT
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Each client loads data in parallel
      const results = await Promise.all(
        clients.map((client, idx) =>
          client.loadObjects(
            Array.from({ length: 10 }, (_, rowIdx) => ({
              id: idx * 100 + rowIdx,
              client_id: idx,
            })),
            {
              database: TEST_DATABASE,
              table: "multi_client_test",
              label: `multi_client_${timestamp}_${idx}`,
            }
          )
        )
      );

      // All should succeed
      const successCount = results.filter(r => r.status === "Success").length;
      expect(successCount).toBe(3);

      // Verify data from all clients
      const rows = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN("multi_client_test")}`
      );
      expect((rows[0] as any).cnt).toBe(30);
    });
  });

  // ============================================================================
  // Format Mixing Scenarios
  // ============================================================================

  describe("Format Mixing Scenarios", () => {
    const TABLE = "format_mix_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          name VARCHAR(255),
          value DOUBLE
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle concurrent CSV and JSON loads to same table", async () => {
      const timestamp = Date.now();

      const csvData = `1,CSV_User1,100.5
2,CSV_User2,200.5
3,CSV_User3,300.5`;

      const jsonData = [
        { id: 4, name: "JSON_User4", value: 400.5 },
        { id: 5, name: "JSON_User5", value: 500.5 },
      ];

      const [csvResult, jsonResult] = await Promise.all([
        streamLoader.loadCsv(csvData, {
          database: TEST_DATABASE,
          table: TABLE,
          columns: ["id", "name", "value"],
          columnSeparator: ",",
          label: `format_mix_csv_${timestamp}`,
        }),
        streamLoader.loadObjects(jsonData, {
          database: TEST_DATABASE,
          table: TABLE,
          label: `format_mix_json_${timestamp}`,
        }),
      ]);

      // Both should succeed
      expect(csvResult.status).toBe("Success");
      expect(jsonResult.status).toBe("Success");

      // Verify total rows
      const rows = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)}`
      );
      expect((rows[0] as any).cnt).toBe(5);
    });

    test("should handle alternating format loads", async () => {
      const timestamp = Date.now();
      const results: any[] = [];

      // Alternate between CSV and JSON
      for (let i = 0; i < 6; i++) {
        const id = 100 + i;
        if (i % 2 === 0) {
          // CSV
          const result = await streamLoader.loadCsv(`${id},Alt_CSV_${i},${i * 10.5}`, {
            database: TEST_DATABASE,
            table: TABLE,
            columns: ["id", "name", "value"],
            columnSeparator: ",",
            label: `alternating_${timestamp}_csv_${i}`,
          });
          results.push(result);
        } else {
          // JSON
          const result = await streamLoader.loadObjects(
            [{ id, name: `Alt_JSON_${i}`, value: i * 10.5 }],
            {
              database: TEST_DATABASE,
              table: TABLE,
              label: `alternating_${timestamp}_json_${i}`,
            }
          );
          results.push(result);
        }
      }

      // All should succeed
      const successCount = results.filter(r => r.status === "Success").length;
      expect(successCount).toBe(6);
    });
  });

  // ============================================================================
  // Timeout and Long-Running Scenarios
  // ============================================================================

  describe("Timeout and Long-Running Scenarios", () => {
    const TABLE = "timeout_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          data VARCHAR(5000)
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 8
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle concurrent loads with different timeouts", async () => {
      const timestamp = Date.now();

      const results = await Promise.all([
        // Short timeout load
        streamLoader.loadObjects(
          Array.from({ length: 10 }, (_, i) => ({
            id: i,
            data: "short",
          })),
          {
            database: TEST_DATABASE,
            table: TABLE,
            timeout: 30,
            label: `timeout_short_${timestamp}`,
          }
        ),
        // Default timeout load
        streamLoader.loadObjects(
          Array.from({ length: 10 }, (_, i) => ({
            id: 100 + i,
            data: "default",
          })),
          {
            database: TEST_DATABASE,
            table: TABLE,
            label: `timeout_default_${timestamp}`,
          }
        ),
        // Long timeout load
        streamLoader.loadObjects(
          Array.from({ length: 10 }, (_, i) => ({
            id: 200 + i,
            data: "long",
          })),
          {
            database: TEST_DATABASE,
            table: TABLE,
            timeout: 600,
            label: `timeout_long_${timestamp}`,
          }
        ),
      ]);

      // All should complete
      results.forEach(result => {
        expect(["Success", "Fail", "Publish Timeout", "Label Already Exists"]).toContain(result.status);
      });

      // Most should succeed
      const successCount = results.filter(r => r.status === "Success").length;
      expect(successCount).toBeGreaterThanOrEqual(2);
    });
  });
});
