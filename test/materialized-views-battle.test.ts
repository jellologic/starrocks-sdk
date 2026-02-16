import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE, beHttpPort } from "../src/test-config";

/**
 * Battle Test: Materialized Views Edge Cases
 *
 * Tests StarRocks materialized view functionality:
 * - Create MVs with different refresh strategies
 * - Distribution and partitioning configurations
 * - Refresh operations (manual, async)
 * - Alter MV refresh strategy
 * - Query MVs directly
 * - MV with aggregations
 * - MV metadata and status
 *
 * IMPORTANT: Uses raw SQL with fully qualified table names (database.table)
 * because connection pooling makes USE DATABASE unreliable.
 */
describe("StarRocks Materialized Views Battle Test", () => {
  let client: StarRocksClient;
  let streamLoader: StreamLoadClient;

  const FQN = (name: string) => `${TEST_DATABASE}.${name}`;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);

    streamLoader = createStreamLoadClient({
      host: testConfig.host,
      httpPort: beHttpPort,
      user: testConfig.user,
      password: testConfig.password,
    });

    // Create base tables for MVs
    await client.raw(`
      CREATE TABLE IF NOT EXISTS ${FQN("events")} (
        event_id BIGINT NOT NULL,
        event_type VARCHAR(50),
        user_id BIGINT,
        venue_id BIGINT,
        event_date DATE,
        ticket_price DECIMAL(10, 2),
        tickets_sold INT,
        created_at DATETIME
      )
      DUPLICATE KEY (event_id)
      DISTRIBUTED BY HASH(event_id) BUCKETS 4
      PROPERTIES("replication_num" = "1")
    `);

    await client.raw(`
      CREATE TABLE IF NOT EXISTS ${FQN("venues")} (
        venue_id BIGINT NOT NULL,
        name VARCHAR(100),
        city VARCHAR(50),
        capacity INT
      )
      DUPLICATE KEY (venue_id)
      DISTRIBUTED BY HASH(venue_id) BUCKETS 4
      PROPERTIES("replication_num" = "1")
    `);

    // Load test data
    await streamLoader.loadObjects([
      { venue_id: 1, name: "Madison Square Garden", city: "New York", capacity: 20000 },
      { venue_id: 2, name: "Staples Center", city: "Los Angeles", capacity: 18000 },
      { venue_id: 3, name: "United Center", city: "Chicago", capacity: 21000 },
    ], { database: TEST_DATABASE, table: "venues" });

    await streamLoader.loadObjects([
      { event_id: 1, event_type: "concert", user_id: 100, venue_id: 1, event_date: "2024-01-15", ticket_price: 75.00, tickets_sold: 15000, created_at: "2024-01-01 10:00:00" },
      { event_id: 2, event_type: "concert", user_id: 100, venue_id: 1, event_date: "2024-01-20", ticket_price: 85.00, tickets_sold: 18000, created_at: "2024-01-05 11:00:00" },
      { event_id: 3, event_type: "sports", user_id: 101, venue_id: 2, event_date: "2024-01-22", ticket_price: 120.00, tickets_sold: 17000, created_at: "2024-01-10 12:00:00" },
      { event_id: 4, event_type: "concert", user_id: 102, venue_id: 3, event_date: "2024-02-01", ticket_price: 65.00, tickets_sold: 20000, created_at: "2024-01-15 13:00:00" },
      { event_id: 5, event_type: "sports", user_id: 101, venue_id: 1, event_date: "2024-02-10", ticket_price: 150.00, tickets_sold: 19000, created_at: "2024-01-20 14:00:00" },
      { event_id: 6, event_type: "theater", user_id: 103, venue_id: 2, event_date: "2024-02-15", ticket_price: 95.00, tickets_sold: 12000, created_at: "2024-01-25 15:00:00" },
    ], { database: TEST_DATABASE, table: "events" });
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  // ============================================================================
  // Basic MV Creation
  // ============================================================================

  describe("Basic MV Creation", () => {
    test("should create simple aggregation MV with MANUAL refresh", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_event_counts")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT
          event_type,
          COUNT(*) as event_count,
          SUM(tickets_sold) as total_tickets
        FROM ${FQN("events")}
        GROUP BY event_type
      `);

      // Trigger refresh
      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_event_counts")}`);

      // Wait for refresh to complete
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Query the MV
      const result = await client.raw<{ event_type: string; event_count: number; total_tickets: number }>(
        `SELECT * FROM ${FQN("mv_event_counts")} ORDER BY event_type`
      );

      expect(result.length).toBe(3); // concert, sports, theater
      const concerts = result.find((r: any) => r.event_type === "concert");
      expect((concerts as any).event_count).toBe(3);
    });

    test("should create MV with ASYNC refresh", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_venue_revenue")}
        DISTRIBUTED BY HASH(venue_id) BUCKETS 4
        REFRESH ASYNC EVERY(INTERVAL 1 HOUR)
        PROPERTIES("replication_num" = "1")
        AS
        SELECT
          venue_id,
          SUM(ticket_price * tickets_sold) as total_revenue
        FROM ${FQN("events")}
        GROUP BY venue_id
      `);

      // Manually refresh to get initial data
      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_venue_revenue")}`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result = await client.raw<{ venue_id: number; total_revenue: number }>(
        `SELECT * FROM ${FQN("mv_venue_revenue")} ORDER BY venue_id`
      );

      expect(result.length).toBe(3);
    });

    test("should create MV with COMMENT", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_with_comment")}
        COMMENT 'Daily event statistics by venue'
        DISTRIBUTED BY HASH(venue_id) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT venue_id, COUNT(*) as cnt FROM ${FQN("events")} GROUP BY venue_id
      `);

      const showCreate = await client.raw(`SHOW CREATE MATERIALIZED VIEW ${FQN("mv_with_comment")}`);
      const createStmt = (showCreate[0] as any)["Create Materialized View"] || (showCreate[0] as any)["Create Table"];
      expect(createStmt.toLowerCase()).toContain("comment");
    });
  });

  // ============================================================================
  // MV Distribution Strategies
  // ============================================================================

  describe("MV Distribution Strategies", () => {
    test("should create MV with HASH distribution", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_hash_dist")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 8
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT event_type, COUNT(*) as cnt FROM ${FQN("events")} GROUP BY event_type
      `);

      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_hash_dist")}`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result = await client.raw(`SELECT * FROM ${FQN("mv_hash_dist")}`);
      expect(result.length).toBe(3);
    });

    test("should create MV with RANDOM distribution", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_random_dist")}
        DISTRIBUTED BY RANDOM BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT event_type, SUM(tickets_sold) as total FROM ${FQN("events")} GROUP BY event_type
      `);

      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_random_dist")}`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result = await client.raw(`SELECT * FROM ${FQN("mv_random_dist")}`);
      expect(result.length).toBe(3);
    });

    test("should create MV with multi-column HASH", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_multi_hash")}
        DISTRIBUTED BY HASH(venue_id, event_type) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT venue_id, event_type, COUNT(*) as cnt
        FROM ${FQN("events")}
        GROUP BY venue_id, event_type
      `);

      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_multi_hash")}`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result = await client.raw(`SELECT * FROM ${FQN("mv_multi_hash")}`);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // MV with JOINs
  // ============================================================================

  describe("MV with JOINs", () => {
    test("should create MV with INNER JOIN", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_event_venue_join")}
        DISTRIBUTED BY HASH(venue_id) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT
          e.venue_id,
          v.name as venue_name,
          v.city,
          COUNT(*) as event_count,
          SUM(e.tickets_sold) as total_tickets
        FROM ${FQN("events")} e
        INNER JOIN ${FQN("venues")} v ON e.venue_id = v.venue_id
        GROUP BY e.venue_id, v.name, v.city
      `);

      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_event_venue_join")}`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result = await client.raw<{ venue_name: string; event_count: number }>(
        `SELECT * FROM ${FQN("mv_event_venue_join")} ORDER BY venue_name`
      );

      expect(result.length).toBe(3);
      const msg = result.find((r: any) => r.venue_name === "Madison Square Garden");
      expect((msg as any).event_count).toBe(3); // 3 events at MSG
    });
  });

  // ============================================================================
  // MV Refresh Operations
  // ============================================================================

  describe("MV Refresh Operations", () => {
    test("should manually refresh MV", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_refresh_test")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT event_type, SUM(tickets_sold) as total
        FROM ${FQN("events")}
        GROUP BY event_type
      `);

      // First refresh
      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_refresh_test")}`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result1 = await client.raw<{ total: number }>(
        `SELECT total FROM ${FQN("mv_refresh_test")} WHERE event_type = 'concert'`
      );
      const initialTotal = (result1[0] as any).total;

      // Add more data
      await streamLoader.loadObjects([
        { event_id: 100, event_type: "concert", user_id: 100, venue_id: 1, event_date: "2024-03-01", ticket_price: 100.00, tickets_sold: 5000, created_at: "2024-02-01 10:00:00" },
      ], { database: TEST_DATABASE, table: "events" });

      // Refresh again
      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_refresh_test")}`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result2 = await client.raw<{ total: number }>(
        `SELECT total FROM ${FQN("mv_refresh_test")} WHERE event_type = 'concert'`
      );

      expect((result2[0] as any).total).toBe(initialTotal + 5000);
    });

    test("should refresh MV with SYNC mode", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_sync_refresh")}
        DISTRIBUTED BY HASH(venue_id) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT venue_id, COUNT(*) as cnt FROM ${FQN("events")} GROUP BY venue_id
      `);

      // Sync refresh waits for completion
      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_sync_refresh")} WITH SYNC MODE`);

      // Should be immediately queryable
      const result = await client.raw(`SELECT * FROM ${FQN("mv_sync_refresh")}`);
      expect(result.length).toBe(3);
    });
  });

  // ============================================================================
  // Alter MV Refresh Strategy
  // ============================================================================

  describe("Alter MV Refresh Strategy", () => {
    test("should alter MV refresh from MANUAL to ASYNC", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_alter_refresh")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT event_type, COUNT(*) as cnt FROM ${FQN("events")} GROUP BY event_type
      `);

      // Alter to ASYNC
      await client.raw(`
        ALTER MATERIALIZED VIEW ${FQN("mv_alter_refresh")}
        REFRESH ASYNC EVERY(INTERVAL 2 HOUR)
      `);

      // Verify by checking metadata
      const showCreate = await client.raw(`SHOW CREATE MATERIALIZED VIEW ${FQN("mv_alter_refresh")}`);
      const createStmt = ((showCreate[0] as any)["Create Materialized View"] || (showCreate[0] as any)["Create Table"]).toLowerCase();
      expect(createStmt).toContain("async");
    });

    test("should alter MV refresh interval", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_alter_interval")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 4
        REFRESH ASYNC EVERY(INTERVAL 1 HOUR)
        PROPERTIES("replication_num" = "1")
        AS
        SELECT event_type, COUNT(*) as cnt FROM ${FQN("events")} GROUP BY event_type
      `);

      // Change interval
      await client.raw(`
        ALTER MATERIALIZED VIEW ${FQN("mv_alter_interval")}
        REFRESH ASYNC EVERY(INTERVAL 30 MINUTE)
      `);

      // Verify
      const showCreate = await client.raw(`SHOW CREATE MATERIALIZED VIEW ${FQN("mv_alter_interval")}`);
      const createStmt = (showCreate[0] as any)["Create Materialized View"] || (showCreate[0] as any)["Create Table"];
      expect(createStmt).toContain("30");
    });

    test("should alter MV to MANUAL refresh", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_to_manual")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 4
        REFRESH ASYNC EVERY(INTERVAL 1 HOUR)
        PROPERTIES("replication_num" = "1")
        AS
        SELECT event_type, SUM(tickets_sold) as total FROM ${FQN("events")} GROUP BY event_type
      `);

      // Change to manual
      await client.raw(`
        ALTER MATERIALIZED VIEW ${FQN("mv_to_manual")}
        REFRESH MANUAL
      `);

      const showCreate = await client.raw(`SHOW CREATE MATERIALIZED VIEW ${FQN("mv_to_manual")}`);
      const createStmt = ((showCreate[0] as any)["Create Materialized View"] || (showCreate[0] as any)["Create Table"]).toLowerCase();
      expect(createStmt).toContain("manual");
    });
  });

  // ============================================================================
  // MV Properties
  // ============================================================================

  describe("MV Properties", () => {
    test("should create MV with replication_num property", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_with_repl")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT event_type, COUNT(*) as cnt FROM ${FQN("events")} GROUP BY event_type
      `);

      const showCreate = await client.raw(`SHOW CREATE MATERIALIZED VIEW ${FQN("mv_with_repl")}`);
      expect(showCreate.length).toBe(1);
    });

    test("should create MV with query_rewrite property", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_query_rewrite")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES(
          "replication_num" = "1",
          "query_rewrite_consistency" = "loose"
        )
        AS
        SELECT event_type, SUM(tickets_sold) as total FROM ${FQN("events")} GROUP BY event_type
      `);

      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_query_rewrite")} WITH SYNC MODE`);

      const result = await client.raw(`SELECT * FROM ${FQN("mv_query_rewrite")}`);
      expect(result.length).toBe(3);
    });
  });

  // ============================================================================
  // MV Schema Operations
  // ============================================================================

  describe("MV Schema Operations", () => {
    test("should SHOW CREATE MATERIALIZED VIEW", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS ${FQN("mv_show_create")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT event_type, COUNT(*) as cnt FROM ${FQN("events")} GROUP BY event_type
      `);

      const result = await client.raw(`SHOW CREATE MATERIALIZED VIEW ${FQN("mv_show_create")}`);
      expect(result.length).toBe(1);
      const createStmt = (result[0] as any)["Create Materialized View"] || (result[0] as any)["Create Table"];
      expect(createStmt).toContain("MATERIALIZED VIEW");
    });

    test("should DESC materialized view", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS ${FQN("mv_describe")}
        DISTRIBUTED BY HASH(venue_id) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT venue_id, event_type, COUNT(*) as cnt
        FROM ${FQN("events")}
        GROUP BY venue_id, event_type
      `);

      const result = await client.raw(`DESC ${FQN("mv_describe")}`);
      const fields = result.map((r: any) => r.Field);

      expect(fields).toContain("venue_id");
      expect(fields).toContain("event_type");
      expect(fields).toContain("cnt");
    });

    test("should DROP MATERIALIZED VIEW IF EXISTS", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS ${FQN("mv_drop_test")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT event_type, COUNT(*) as cnt FROM ${FQN("events")} GROUP BY event_type
      `);

      // Drop should succeed
      await client.raw(`DROP MATERIALIZED VIEW IF EXISTS ${FQN("mv_drop_test")}`);

      // Second drop should not error
      await client.raw(`DROP MATERIALIZED VIEW IF EXISTS ${FQN("mv_drop_test")}`);

      // MV should not exist
      try {
        await client.raw(`SELECT * FROM ${FQN("mv_drop_test")}`);
        expect(true).toBe(false);
      } catch {
        // Expected
      }
    });
  });

  // ============================================================================
  // Complex MV Queries
  // ============================================================================

  describe("Complex MV Queries", () => {
    test("should create MV with window functions", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_with_window")}
        DISTRIBUTED BY HASH(venue_id) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT
          venue_id,
          event_type,
          tickets_sold,
          SUM(tickets_sold) OVER (PARTITION BY venue_id) as venue_total
        FROM ${FQN("events")}
      `);

      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_with_window")} WITH SYNC MODE`);

      const result = await client.raw<{ venue_id: number; venue_total: number }>(
        `SELECT DISTINCT venue_id, venue_total FROM ${FQN("mv_with_window")} ORDER BY venue_id`
      );

      expect(result.length).toBe(3);
    });

    test("should create MV with CASE expression", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_with_case")}
        DISTRIBUTED BY HASH(price_tier) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT
          CASE
            WHEN ticket_price > 100 THEN 'premium'
            WHEN ticket_price > 70 THEN 'standard'
            ELSE 'budget'
          END as price_tier,
          COUNT(*) as event_count,
          SUM(tickets_sold) as total_tickets
        FROM ${FQN("events")}
        GROUP BY
          CASE
            WHEN ticket_price > 100 THEN 'premium'
            WHEN ticket_price > 70 THEN 'standard'
            ELSE 'budget'
          END
      `);

      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_with_case")} WITH SYNC MODE`);

      const result = await client.raw<{ price_tier: string; event_count: number }>(
        `SELECT * FROM ${FQN("mv_with_case")} ORDER BY price_tier`
      );

      expect(result.length).toBe(3); // budget, premium, standard
    });

    test("should create MV with date truncation", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_monthly_stats")}
        DISTRIBUTED BY HASH(event_month) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT
          DATE_FORMAT(event_date, '%Y-%m') as event_month,
          COUNT(*) as event_count,
          SUM(ticket_price * tickets_sold) as total_revenue
        FROM ${FQN("events")}
        GROUP BY DATE_FORMAT(event_date, '%Y-%m')
      `);

      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_monthly_stats")} WITH SYNC MODE`);

      const result = await client.raw<{ event_month: string; event_count: number }>(
        `SELECT * FROM ${FQN("mv_monthly_stats")} ORDER BY event_month`
      );

      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    test("should handle MV with empty result initially", async () => {
      // Create a table that will be empty for the MV query
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("empty_source")} (
          id BIGINT NOT NULL,
          value INT
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_empty")}
        DISTRIBUTED BY HASH(id) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT id, SUM(value) as total FROM ${FQN("empty_source")} GROUP BY id
      `);

      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_empty")} WITH SYNC MODE`);

      const result = await client.raw(`SELECT * FROM ${FQN("mv_empty")}`);
      expect(result.length).toBe(0);
    });

    test("should handle MV with long column names", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_long_cols")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT
          event_type,
          COUNT(*) as total_number_of_events_in_category,
          SUM(tickets_sold) as cumulative_ticket_sales_volume
        FROM ${FQN("events")}
        GROUP BY event_type
      `);

      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_long_cols")} WITH SYNC MODE`);

      const result = await client.raw(`SELECT * FROM ${FQN("mv_long_cols")} LIMIT 1`);
      expect(Object.keys(result[0] as any)).toContain("total_number_of_events_in_category");
    });

    test("should handle MV with NULL handling", async () => {
      await client.raw(`
        CREATE MATERIALIZED VIEW ${FQN("mv_null_handling")}
        DISTRIBUTED BY HASH(event_type) BUCKETS 4
        REFRESH MANUAL
        PROPERTIES("replication_num" = "1")
        AS
        SELECT
          event_type,
          COUNT(*) as total,
          COUNT(venue_id) as with_venue,
          COALESCE(SUM(tickets_sold), 0) as ticket_sum
        FROM ${FQN("events")}
        GROUP BY event_type
      `);

      await client.raw(`REFRESH MATERIALIZED VIEW ${FQN("mv_null_handling")} WITH SYNC MODE`);

      const result = await client.raw(`SELECT * FROM ${FQN("mv_null_handling")}`);
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
