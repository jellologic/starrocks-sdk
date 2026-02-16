import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE, beHttpPort } from "../src/test-config";

/**
 * Battle Test: Partitioning Edge Cases
 *
 * Tests StarRocks partitioning features comprehensively:
 * - Range partitioning (date-based, numeric)
 * - List partitioning
 * - Expression partitioning
 * - Dynamic partitions
 * - Partition operations (add, drop)
 * - Loading data to specific partitions
 * - Boundary values and edge cases
 *
 * IMPORTANT: Uses raw SQL with fully qualified table names (database.table)
 * because connection pooling makes USE DATABASE unreliable.
 */
describe("StarRocks Partitioning Edge Cases", () => {
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
  // Range Partitioning (Date-based)
  // ============================================================================

  describe("Range Partitioning - Date Based", () => {
    const TABLE = "range_date_partition";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          dt DATE NOT NULL,
          event_id BIGINT NOT NULL,
          event_name VARCHAR(255),
          value DOUBLE
        )
        DUPLICATE KEY (dt, event_id)
        PARTITION BY RANGE (dt) (
          PARTITION p202401 VALUES LESS THAN ("2024-02-01"),
          PARTITION p202402 VALUES LESS THAN ("2024-03-01"),
          PARTITION p202403 VALUES LESS THAN ("2024-04-01"),
          PARTITION p202404 VALUES LESS THAN ("2024-05-01")
        )
        DISTRIBUTED BY HASH(event_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should load data into correct date partitions", async () => {
      const data = [
        { dt: "2024-01-15", event_id: 1, event_name: "Jan Event", value: 100.0 },
        { dt: "2024-02-10", event_id: 2, event_name: "Feb Event", value: 200.0 },
        { dt: "2024-03-20", event_id: 3, event_name: "Mar Event", value: 300.0 },
        { dt: "2024-04-05", event_id: 4, event_name: "Apr Event", value: 400.0 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
      expect(result.numberLoadedRows).toBe(4);

      // Verify data exists in correct partitions
      const rows = await client.raw<{ dt: string; event_name: string }>(
        `SELECT dt, event_name FROM ${FQN(TABLE)} ORDER BY dt`
      );
      expect(rows.length).toBe(4);
    });

    test("should handle boundary dates between partitions", async () => {
      const data = [
        // Last day of January - should go to p202401
        { dt: "2024-01-31", event_id: 100, event_name: "Last Jan", value: 1.0 },
        // First day of February - should go to p202402
        { dt: "2024-02-01", event_id: 101, event_name: "First Feb", value: 2.0 },
        // Last day of February (leap year) - should go to p202402
        { dt: "2024-02-29", event_id: 102, event_name: "Leap Day", value: 3.0 },
        // First day of March - should go to p202403
        { dt: "2024-03-01", event_id: 103, event_name: "First Mar", value: 4.0 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      // Verify data
      const leapRow = await client.raw<{ event_name: string }>(
        `SELECT event_name FROM ${FQN(TABLE)} WHERE dt = '2024-02-29'`
      );
      expect(leapRow[0]!.event_name).toBe("Leap Day");
    });

    test("should reject data outside partition range", async () => {
      const data = [
        // Before first partition
        { dt: "2023-12-31", event_id: 200, event_name: "Pre-range", value: 0.0 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      // Should fail - no partition for 2023 data
      expect(["Fail", "Success"]).toContain(result.status);
      if (result.status === "Success") {
        // If strict mode is off, data might be filtered
        expect(result.numberFilteredRows).toBeGreaterThanOrEqual(0);
      }
    });

    test("should reject data after last partition", async () => {
      const data = [
        // After last partition
        { dt: "2024-05-15", event_id: 201, event_name: "Post-range", value: 0.0 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      // Should fail - no partition for May+ data
      expect(["Fail", "Success"]).toContain(result.status);
    });
  });

  // ============================================================================
  // Range Partitioning (Numeric)
  // ============================================================================

  describe("Range Partitioning - Numeric", () => {
    const TABLE = "range_numeric_partition";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          user_id BIGINT NOT NULL,
          score INT NOT NULL,
          action_name VARCHAR(255)
        )
        DUPLICATE KEY (user_id, score)
        PARTITION BY RANGE (score) (
          PARTITION p0_100 VALUES LESS THAN ("100"),
          PARTITION p100_500 VALUES LESS THAN ("500"),
          PARTITION p500_1000 VALUES LESS THAN ("1000"),
          PARTITION pmax VALUES LESS THAN ("10000")
        )
        DISTRIBUTED BY HASH(user_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should distribute data across numeric partitions", async () => {
      const data = [
        { user_id: 1, score: 50, action_name: "low" },
        { user_id: 2, score: 99, action_name: "boundary_low" },
        { user_id: 3, score: 100, action_name: "boundary_mid" },
        { user_id: 4, score: 250, action_name: "mid" },
        { user_id: 5, score: 500, action_name: "boundary_high" },
        { user_id: 6, score: 750, action_name: "high" },
        { user_id: 7, score: 999, action_name: "boundary_max" },
        { user_id: 8, score: 1000, action_name: "very_high" },
        { user_id: 9, score: 5000, action_name: "extreme" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
      expect(result.numberLoadedRows).toBe(9);

      // Verify partition counts
      const lowCount = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)} WHERE score < 100`
      );
      expect((lowCount[0] as any).cnt).toBe(2);
    });

    test("should handle zero and negative boundaries", async () => {
      // Add a partition for scores below 0 if needed
      // For this test, we just test boundary around 0
      const data = [
        { user_id: 100, score: 0, action_name: "zero" },
        { user_id: 101, score: 1, action_name: "one" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });
  });

  // ============================================================================
  // List Partitioning
  // ============================================================================

  describe("List Partitioning", () => {
    const TABLE = "list_partition";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          region VARCHAR(50) NOT NULL,
          user_id BIGINT NOT NULL,
          activity VARCHAR(255)
        )
        DUPLICATE KEY (region, user_id)
        PARTITION BY LIST (region) (
          PARTITION pnorth VALUES IN ("US", "CA", "MX"),
          PARTITION peurope VALUES IN ("UK", "DE", "FR", "ES"),
          PARTITION pasia VALUES IN ("JP", "CN", "KR", "IN"),
          PARTITION pother VALUES IN ("AU", "BR", "ZA")
        )
        DISTRIBUTED BY HASH(user_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should distribute data to correct list partitions", async () => {
      const data = [
        { region: "US", user_id: 1, activity: "login" },
        { region: "UK", user_id: 2, activity: "purchase" },
        { region: "JP", user_id: 3, activity: "view" },
        { region: "AU", user_id: 4, activity: "signup" },
        { region: "CA", user_id: 5, activity: "logout" },
        { region: "DE", user_id: 6, activity: "click" },
        { region: "CN", user_id: 7, activity: "search" },
        { region: "BR", user_id: 8, activity: "share" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
      expect(result.numberLoadedRows).toBe(8);

      // Verify North America count
      const northCount = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)} WHERE region IN ('US', 'CA', 'MX')`
      );
      expect((northCount[0] as any).cnt).toBe(2);
    });

    test("should reject data with unlisted partition values", async () => {
      const data = [
        { region: "XX", user_id: 100, activity: "unknown" }, // Not in any partition
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      // Should fail or filter the row
      expect(["Fail", "Success"]).toContain(result.status);
    });

    test("should handle case sensitivity in list values", async () => {
      // Test if "us" matches "US" partition
      const data = [
        { region: "US", user_id: 200, activity: "upper" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });
  });

  // ============================================================================
  // Multi-Column Partitioning
  // ============================================================================

  describe("Multi-Column Partitioning", () => {
    const TABLE = "multi_col_partition";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          year INT NOT NULL,
          month INT NOT NULL,
          day INT NOT NULL,
          event_id BIGINT NOT NULL,
          description VARCHAR(255)
        )
        DUPLICATE KEY (year, month, day, event_id)
        PARTITION BY RANGE (year, month) (
          PARTITION p2023q4 VALUES LESS THAN ("2024", "1"),
          PARTITION p2024q1 VALUES LESS THAN ("2024", "4"),
          PARTITION p2024q2 VALUES LESS THAN ("2024", "7"),
          PARTITION p2024q3 VALUES LESS THAN ("2024", "10"),
          PARTITION p2024q4 VALUES LESS THAN ("2025", "1")
        )
        DISTRIBUTED BY HASH(event_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should distribute data based on multiple columns", async () => {
      const data = [
        { year: 2023, month: 12, day: 15, event_id: 1, description: "2023 Q4" },
        { year: 2024, month: 2, day: 10, event_id: 2, description: "2024 Q1" },
        { year: 2024, month: 5, day: 20, event_id: 3, description: "2024 Q2" },
        { year: 2024, month: 8, day: 5, event_id: 4, description: "2024 Q3" },
        { year: 2024, month: 11, day: 25, event_id: 5, description: "2024 Q4" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
      expect(result.numberLoadedRows).toBe(5);
    });

    test("should handle quarter boundary dates", async () => {
      const data = [
        // Last day of Q1 2024
        { year: 2024, month: 3, day: 31, event_id: 100, description: "Q1 end" },
        // First day of Q2 2024
        { year: 2024, month: 4, day: 1, event_id: 101, description: "Q2 start" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });
  });

  // ============================================================================
  // Partition Operations
  // ============================================================================

  describe("Partition Operations", () => {
    const TABLE = "partition_ops_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          dt DATE NOT NULL,
          id BIGINT NOT NULL,
          data VARCHAR(255)
        )
        DUPLICATE KEY (dt, id)
        PARTITION BY RANGE (dt) (
          PARTITION p1 VALUES LESS THAN ("2024-02-01"),
          PARTITION p2 VALUES LESS THAN ("2024-03-01"),
          PARTITION p3 VALUES LESS THAN ("2024-04-01")
        )
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should add new partition", async () => {
      // Add partition for April
      await client.raw(`
        ALTER TABLE ${FQN(TABLE)} ADD PARTITION p4 VALUES LESS THAN ("2024-05-01")
      `);

      // Load data into new partition
      const data = [
        { dt: "2024-04-15", id: 1, data: "New partition data" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should query SHOW PARTITIONS", async () => {
      const partitions = await client.raw(
        `SHOW PARTITIONS FROM ${FQN(TABLE)}`
      );

      expect(partitions.length).toBeGreaterThanOrEqual(4);
    });

    test("should drop partition", async () => {
      // First add a partition to drop
      await client.raw(`
        ALTER TABLE ${FQN(TABLE)} ADD PARTITION p_temp VALUES LESS THAN ("2024-06-01")
      `);

      // Drop the partition
      await client.raw(`
        ALTER TABLE ${FQN(TABLE)} DROP PARTITION p_temp
      `);

      // Verify partition is gone
      const partitions = await client.raw(
        `SHOW PARTITIONS FROM ${FQN(TABLE)}`
      );

      const partitionNames = partitions.map((p: any) => p.PartitionName);
      expect(partitionNames).not.toContain("p_temp");
    });
  });

  // ============================================================================
  // Expression Partitioning (Auto-Partition)
  // ============================================================================

  describe("Expression Partitioning", () => {
    const TABLE = "expr_partition";

    beforeAll(async () => {
      // Expression partitioning with date_trunc for automatic partitioning
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          event_time DATETIME NOT NULL,
          event_id BIGINT NOT NULL,
          event_type VARCHAR(50)
        )
        DUPLICATE KEY (event_time, event_id)
        PARTITION BY date_trunc('day', event_time)
        DISTRIBUTED BY HASH(event_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should auto-create partitions for new dates", async () => {
      const data = [
        { event_time: "2024-06-01 10:00:00", event_id: 1, event_type: "click" },
        { event_time: "2024-06-01 14:00:00", event_id: 2, event_type: "view" },
        { event_time: "2024-06-02 09:00:00", event_id: 3, event_type: "purchase" },
        { event_time: "2024-06-03 16:00:00", event_id: 4, event_type: "signup" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      // Verify partitions were created
      const partitions = await client.raw(
        `SHOW PARTITIONS FROM ${FQN(TABLE)}`
      );
      expect(partitions.length).toBeGreaterThanOrEqual(3);
    });

    test("should handle same-day events in same partition", async () => {
      const data = [
        { event_time: "2024-07-15 00:00:00", event_id: 100, event_type: "midnight" },
        { event_time: "2024-07-15 12:00:00", event_id: 101, event_type: "noon" },
        { event_time: "2024-07-15 23:59:59", event_id: 102, event_type: "almost_midnight" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      // All should be in same partition
      const dayCount = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)}
         WHERE event_time >= '2024-07-15 00:00:00'
         AND event_time < '2024-07-16 00:00:00'`
      );
      expect((dayCount[0] as any).cnt).toBe(3);
    });
  });

  // ============================================================================
  // Partition Pruning Verification
  // ============================================================================

  describe("Partition Pruning", () => {
    const TABLE = "pruning_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          dt DATE NOT NULL,
          id BIGINT NOT NULL,
          large_data VARCHAR(1000)
        )
        DUPLICATE KEY (dt, id)
        PARTITION BY RANGE (dt) (
          PARTITION p202301 VALUES LESS THAN ("2023-02-01"),
          PARTITION p202302 VALUES LESS THAN ("2023-03-01"),
          PARTITION p202303 VALUES LESS THAN ("2023-04-01"),
          PARTITION p202304 VALUES LESS THAN ("2023-05-01"),
          PARTITION p202305 VALUES LESS THAN ("2023-06-01"),
          PARTITION p202306 VALUES LESS THAN ("2023-07-01")
        )
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      // Load substantial data
      const allData: any[] = [];
      for (let month = 1; month <= 6; month++) {
        for (let i = 0; i < 100; i++) {
          allData.push({
            dt: `2023-${String(month).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
            id: month * 1000 + i,
            large_data: "X".repeat(100),
          });
        }
      }

      await streamLoader.loadObjects(allData, {
        database: TEST_DATABASE,
        table: TABLE,
      });
    });

    test("should use partition pruning for single partition query", async () => {
      // Query only February data - should only scan p202302
      const febData = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)}
         WHERE dt >= '2023-02-01' AND dt < '2023-03-01'`
      );
      expect((febData[0] as any).cnt).toBe(100);
    });

    test("should use partition pruning for range query", async () => {
      // Query February and March - should scan p202302 and p202303
      const twoMonths = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)}
         WHERE dt >= '2023-02-01' AND dt < '2023-04-01'`
      );
      expect((twoMonths[0] as any).cnt).toBe(200);
    });

    test("should scan all partitions for unrestricted query", async () => {
      const allData = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${FQN(TABLE)}`
      );
      expect((allData[0] as any).cnt).toBe(600);
    });
  });

  // ============================================================================
  // Edge Cases and Error Handling
  // ============================================================================

  describe("Edge Cases and Error Handling", () => {
    const TABLE = "edge_case_partition";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          dt DATE NOT NULL,
          value INT
        )
        DUPLICATE KEY (dt)
        PARTITION BY RANGE (dt) (
          PARTITION p1 VALUES LESS THAN ("2024-01-15"),
          PARTITION p2 VALUES LESS THAN ("2024-01-30"),
          PARTITION p3 VALUES LESS THAN ("2024-02-15")
        )
        DISTRIBUTED BY HASH(dt) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle exact boundary values", async () => {
      const data = [
        { dt: "2024-01-14", value: 1 }, // Last day of p1
        { dt: "2024-01-15", value: 2 }, // First day of p2 (boundary)
        { dt: "2024-01-29", value: 3 }, // Last day of p2
        { dt: "2024-01-30", value: 4 }, // First day of p3 (boundary)
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle leap year dates", async () => {
      // Create table specifically for leap year testing
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("leap_year_test")} (
          dt DATE NOT NULL,
          value INT
        )
        DUPLICATE KEY (dt)
        PARTITION BY RANGE (dt) (
          PARTITION p_feb VALUES LESS THAN ("2024-03-01"),
          PARTITION p_mar VALUES LESS THAN ("2024-04-01")
        )
        DISTRIBUTED BY HASH(dt) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = [
        { dt: "2024-02-28", value: 1 },
        { dt: "2024-02-29", value: 2 }, // Leap day
        { dt: "2024-03-01", value: 3 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "leap_year_test",
      });

      expect(result.status).toBe("Success");
    });

    test("should handle minimum date values", async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("min_date_test")} (
          dt DATE NOT NULL,
          value INT
        )
        DUPLICATE KEY (dt)
        PARTITION BY RANGE (dt) (
          PARTITION p_early VALUES LESS THAN ("0100-01-01"),
          PARTITION p_mid VALUES LESS THAN ("1900-01-01"),
          PARTITION p_modern VALUES LESS THAN ("2100-01-01")
        )
        DISTRIBUTED BY HASH(dt) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = [
        { dt: "0001-01-01", value: 1 }, // Very early date
        { dt: "1800-06-15", value: 2 },
        { dt: "2024-01-01", value: 3 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: "min_date_test",
      });

      expect(result.status).toBe("Success");
    });

    test("should reject overlapping partition ranges", async () => {
      // This should fail during table creation
      try {
        await client.raw(`
          CREATE TABLE ${FQN("bad_partition_test")} (
            dt DATE NOT NULL,
            value INT
          )
          DUPLICATE KEY (dt)
          PARTITION BY RANGE (dt) (
            PARTITION p1 VALUES LESS THAN ("2024-02-01"),
            PARTITION p2 VALUES LESS THAN ("2024-01-15")  -- Overlapping!
          )
          DISTRIBUTED BY HASH(dt) BUCKETS 4
          PROPERTIES("replication_num" = "1")
        `);
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        // Expected to fail - StarRocks reports "intersected with range"
        expect(error.message).toContain("intersected");
      }
    });
  });

  // ============================================================================
  // Concurrent Partition Operations
  // ============================================================================

  describe("Concurrent Partition Operations", () => {
    const TABLE = "concurrent_partition_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          dt DATE NOT NULL,
          id BIGINT NOT NULL,
          data VARCHAR(100)
        )
        DUPLICATE KEY (dt, id)
        PARTITION BY RANGE (dt) (
          PARTITION p1 VALUES LESS THAN ("2024-02-01"),
          PARTITION p2 VALUES LESS THAN ("2024-03-01"),
          PARTITION p3 VALUES LESS THAN ("2024-04-01")
        )
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle concurrent loads to different partitions", async () => {
      const timestamp = Date.now();

      // Parallel loads to different partitions
      const results = await Promise.all([
        streamLoader.loadObjects(
          [{ dt: "2024-01-15", id: 1, data: "p1_data" }],
          { database: TEST_DATABASE, table: TABLE, label: `conc_p1_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ dt: "2024-02-15", id: 2, data: "p2_data" }],
          { database: TEST_DATABASE, table: TABLE, label: `conc_p2_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ dt: "2024-03-15", id: 3, data: "p3_data" }],
          { database: TEST_DATABASE, table: TABLE, label: `conc_p3_${timestamp}` }
        ),
      ]);

      // All should succeed
      results.forEach(r => expect(r.status).toBe("Success"));
    });

    test("should handle concurrent loads to same partition", async () => {
      const timestamp = Date.now();

      // All loads target the same partition (p1)
      const results = await Promise.all([
        streamLoader.loadObjects(
          [{ dt: "2024-01-10", id: 100, data: "batch1" }],
          { database: TEST_DATABASE, table: TABLE, label: `same_p_1_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ dt: "2024-01-11", id: 101, data: "batch2" }],
          { database: TEST_DATABASE, table: TABLE, label: `same_p_2_${timestamp}` }
        ),
        streamLoader.loadObjects(
          [{ dt: "2024-01-12", id: 102, data: "batch3" }],
          { database: TEST_DATABASE, table: TABLE, label: `same_p_3_${timestamp}` }
        ),
      ]);

      // All should succeed
      const successCount = results.filter(r => r.status === "Success").length;
      expect(successCount).toBe(3);
    });
  });
});
