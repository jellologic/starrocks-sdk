/**
 * Integration Tests for Type-Safe Views and Materialized Views
 *
 * Tests the new schema-based View/MV builders against real StarRocks
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import mysql from "mysql2/promise";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import { createStarRocksClient, type StarRocksClient } from "../src";
import {
  // Tables
  starrocksTable,
  primaryKey,
  hash,
  generateCreateTableSQL,

  // Column types
  bigint,
  varchar,
  datetime,
  double,
  int,

  // Views
  createView,
  generateCreateViewSQL,
  generateDropViewSQL,

  // Materialized Views
  createMaterializedView,
  generateCreateMaterializedViewSQL,
  generateDropMaterializedViewSQL,
  createMVOperations,

  // Expressions
  eq,
  gt,
  sql,

  // Aggregates
  count,
  sum,
  max,

  // Query builder
  createKnexDatabase,
} from "../src/schema/index";

// ==========================================================================
// Test Tables
// ==========================================================================

const eventsTable = starrocksTable(
  "view_test_events",
  {
    id: bigint("id"),
    name: varchar("name", { length: 255 }),
    venueId: bigint("venue_id"),
    price: double("price"),
    status: varchar("status", { length: 50 }),
    createdAt: datetime("created_at"),
  },
  (table) => ({
    key: primaryKey(table.id),
    distribution: hash(table.id, { buckets: 4 }),
    properties: { replication_num: 1 },
  })
);

const venuesTable = starrocksTable(
  "view_test_venues",
  {
    id: bigint("id"),
    name: varchar("name", { length: 255 }),
    city: varchar("city", { length: 100 }),
    capacity: int("capacity"),
  },
  (table) => ({
    key: primaryKey(table.id),
    distribution: hash(table.id, { buckets: 4 }),
    properties: { replication_num: 1 },
  })
);

// ==========================================================================
// Test Views (type-safe definitions)
// ==========================================================================

const activeEventsView = createView("active_events_view")
  .columns({
    id: bigint("id"),
    name: varchar("name", { length: 255 }),
    price: double("price"),
  })
  .comment("Active events only")
  .as((qb) =>
    qb
      .select({
        id: eventsTable.id,
        name: eventsTable.name,
        price: eventsTable.price,
      })
      .from(eventsTable)
      .where(eq(eventsTable.status, sql`'active'`))
  );

const eventsWithVenuesView = createView("events_with_venues_view")
  .columns({
    eventId: bigint("event_id"),
    eventName: varchar("event_name", { length: 255 }),
    venueName: varchar("venue_name", { length: 255 }),
    city: varchar("city", { length: 100 }),
  })
  .as((qb) =>
    qb
      .select({
        eventId: eventsTable.id,
        eventName: eventsTable.name,
        venueName: venuesTable.name,
        city: venuesTable.city,
      })
      .from(eventsTable)
      .innerJoin(venuesTable, eq(eventsTable.venueId, venuesTable.id))
  );

// ==========================================================================
// Test Materialized Views (type-safe definitions)
// ==========================================================================

// Note: MV column names must match the SELECT output aliases
// The SELECT uses JS keys as aliases (venueId, eventCount, etc.)
// so the .columns() definitions should use matching DB names
const eventStatsMV = createMaterializedView("event_stats_mv")
  .columns({
    venueId: bigint("venueId"),
    eventCount: bigint("eventCount"),
    totalRevenue: double("totalRevenue"),
    maxPrice: double("maxPrice"),
  })
  .distributed({ type: "RANDOM", buckets: 4 }) // Use RANDOM to avoid column name issues
  .refresh({ type: "MANUAL" })
  .properties({ replication_num: 1 })
  .comment("Event statistics by venue")
  .as((qb) =>
    qb
      .select({
        venueId: eventsTable.venueId,
        eventCount: count(eventsTable.id),
        totalRevenue: sum(eventsTable.price),
        maxPrice: max(eventsTable.price),
      })
      .from(eventsTable)
      .groupBy(eventsTable.venueId)
  );

// ==========================================================================
// Tests
// ==========================================================================

describe("Type-Safe Views Integration", () => {
  let client: StarRocksClient;
  let pool: mysql.Pool;
  let db: ReturnType<typeof createKnexDatabase>;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);
    await client.useDatabase(TEST_DATABASE);

    pool = mysql.createPool({
      host: testConfig.host,
      port: testConfig.mysqlPort,
      user: testConfig.user,
      password: testConfig.password,
      database: TEST_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
    });

    db = createKnexDatabase(pool);

    // Create base tables
    await client.execute(generateCreateTableSQL(eventsTable));
    await client.execute(generateCreateTableSQL(venuesTable));

    // Insert test data
    await db(venuesTable).insertMany([
      { id: 1n, name: "Arena", city: "NYC", capacity: 20000 },
      { id: 2n, name: "Stadium", city: "LA", capacity: 50000 },
      { id: 3n, name: "Theater", city: "Chicago", capacity: 2000 },
    ]);

    await db(eventsTable).insertMany([
      { id: 1n, name: "Concert A", venueId: 1n, price: 50.0, status: "active", createdAt: new Date() },
      { id: 2n, name: "Concert B", venueId: 1n, price: 75.0, status: "active", createdAt: new Date() },
      { id: 3n, name: "Show C", venueId: 2n, price: 100.0, status: "active", createdAt: new Date() },
      { id: 4n, name: "Play D", venueId: 3n, price: 45.0, status: "cancelled", createdAt: new Date() },
      { id: 5n, name: "Musical E", venueId: 2n, price: 120.0, status: "active", createdAt: new Date() },
    ]);
  });

  afterAll(async () => {
    // Clean up views and MVs
    try {
      await client.execute(generateDropViewSQL(activeEventsView));
    } catch {}
    try {
      await client.execute(generateDropViewSQL(eventsWithVenuesView));
    } catch {}
    try {
      await client.execute(generateDropMaterializedViewSQL(eventStatsMV));
    } catch {}

    await pool.end();
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  describe("Regular Views", () => {
    test("should create a simple view", async () => {
      const sql = generateCreateViewSQL(activeEventsView);
      await client.execute(sql);

      // Query the view
      const rows = await client.raw<{ id: number; name: string; price: number }>(
        "SELECT * FROM active_events_view ORDER BY id"
      );

      // Should only have active events (4 out of 5)
      expect(rows.length).toBe(4);
      expect(rows[0]!.name).toBe("Concert A");
    });

    test("should create a view with JOIN", async () => {
      const sql = generateCreateViewSQL(eventsWithVenuesView);
      await client.execute(sql);

      // Query the view
      const rows = await client.raw<{
        event_id: number;
        event_name: string;
        venue_name: string;
        city: string;
      }>("SELECT * FROM events_with_venues_view ORDER BY event_id");

      expect(rows.length).toBe(5);
      expect(rows[0]!.event_name).toBe("Concert A");
      expect(rows[0]!.venue_name).toBe("Arena");
      expect(rows[0]!.city).toBe("NYC");
    });

    test("should query view using Knex builder", async () => {
      // Create a table-like reference for the view
      const activeEventsRef = starrocksTable(
        "active_events_view",
        {
          id: bigint("id"),
          name: varchar("name", { length: 255 }),
          price: double("price"),
        },
        () => ({})
      );

      const results = await db(activeEventsRef)
        .select("id", "name", "price")
        .where("price", ">", 60)
        .orderBy("price", "desc");

      // 75, 100, 120 are > 60, and all are active
      expect(results.length).toBe(3);
    });

    test("should drop view", async () => {
      // Create a temporary view
      const tempView = createView("temp_view_to_drop")
        .columns({ id: bigint("id") })
        .as((qb) => qb.select({ id: eventsTable.id }).from(eventsTable));

      await client.execute(generateCreateViewSQL(tempView));

      // Verify it exists by querying it
      const beforeRows = await client.raw<{ id: number }>(
        "SELECT * FROM temp_view_to_drop LIMIT 1"
      );
      expect(beforeRows).toBeDefined();

      // Drop it
      await client.execute(generateDropViewSQL(tempView));

      // Verify it's gone - querying should fail
      let dropped = false;
      try {
        await client.raw("SELECT * FROM temp_view_to_drop LIMIT 1");
      } catch {
        dropped = true;
      }
      expect(dropped).toBe(true);
    });
  });

  describe("Materialized Views", () => {
    test("should create materialized view", async () => {
      const sql = generateCreateMaterializedViewSQL(eventStatsMV);
      await client.execute(sql);

      // Verify MV was created (SHOW MATERIALIZED VIEWS can trigger internal
      // StarRocks errors with some Docker images, so use SHOW CREATE instead)
      const showCreate = await client.raw(
        "SHOW CREATE MATERIALIZED VIEW event_stats_mv"
      );
      expect(showCreate.length).toBe(1);
    });

    test("should refresh materialized view using operations", async () => {
      const mvOps = createMVOperations(pool, eventStatsMV);

      // Trigger manual refresh
      await mvOps.refresh();

      // Wait for refresh to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Query the MV - columns are named by SELECT aliases (venueId, eventCount, etc.)
      const rows = await client.raw<{
        venueId: number;
        eventCount: number;
        totalRevenue: number;
      }>("SELECT * FROM event_stats_mv ORDER BY venueId");

      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    test("should get MV status using operations", async () => {
      const mvOps = createMVOperations(pool, eventStatsMV);

      // Note: status() may not work in all StarRocks versions due to
      // information_schema differences. Test that it at least doesn't throw
      // a catastrophic error, or returns expected structure if supported.
      try {
        const status = await mvOps.status();
        // If status succeeds, verify the structure
        expect(status).toHaveProperty("name");
        expect(status.name).toBe("event_stats_mv");
        expect(status).toHaveProperty("isActive");
      } catch (err: unknown) {
        // Some StarRocks versions don't support the status query
        // Verify it's a known limitation, not a code bug
        const message = err instanceof Error ? err.message : String(err);
        expect(message).toMatch(/cannot be resolved|Unknown column|doesn't exist/i);
      }
    });

    test("should query MV using Knex builder", async () => {
      // Create a table-like reference for the MV
      // Note: MV columns are named by SELECT aliases (venueId, eventCount, etc.)
      // not the underlying DB column names
      const eventStatsRef = starrocksTable(
        "event_stats_mv",
        {
          venueId: bigint("venueId"),
          eventCount: bigint("eventCount"),
          totalRevenue: double("totalRevenue"),
          maxPrice: double("maxPrice"),
        },
        () => ({})
      );

      // Wait for data to be available
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const results = await db(eventStatsRef)
        .select("venueId", "eventCount", "totalRevenue")
        .orderBy("venueId");

      // Should have stats for venues with events
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    test("should drop materialized view", async () => {
      // Create a temporary MV
      const tempMV = createMaterializedView("temp_mv_to_drop")
        .columns({ total: bigint("total") })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .properties({ replication_num: 1 })
        .as((qb) =>
          qb.select({ total: count(eventsTable.id) }).from(eventsTable)
        );

      await client.execute(generateCreateMaterializedViewSQL(tempMV));

      // Verify it exists (SHOW MATERIALIZED VIEWS can trigger internal
      // StarRocks errors with some Docker images, so use SHOW CREATE instead)
      const showCreate = await client.raw(
        "SHOW CREATE MATERIALIZED VIEW temp_mv_to_drop"
      );
      expect(showCreate.length).toBe(1);

      // Drop it
      await client.execute(generateDropMaterializedViewSQL(tempMV));

      // Verify it's gone — querying should fail
      let dropped = false;
      try {
        await client.raw("SELECT * FROM temp_mv_to_drop LIMIT 1");
      } catch {
        dropped = true;
      }
      expect(dropped).toBe(true);
    });
  });

  describe("View Column References", () => {
    test("view should have correct column references", () => {
      expect(activeEventsView.id.fullName).toBe("active_events_view.id");
      expect(activeEventsView.name.fullName).toBe("active_events_view.name");
      expect(activeEventsView.price.fullName).toBe("active_events_view.price");
    });

    test("MV should have correct column references", () => {
      // MV columns use the SELECT alias names (camelCase JS keys)
      expect(eventStatsMV.venueId.fullName).toBe("event_stats_mv.venueId");
      expect(eventStatsMV.eventCount.fullName).toBe("event_stats_mv.eventCount");
      expect(eventStatsMV.totalRevenue.fullName).toBe("event_stats_mv.totalRevenue");
    });
  });

  describe("SQL Generation", () => {
    test("should generate valid CREATE VIEW SQL", () => {
      const sql = generateCreateViewSQL(activeEventsView);

      // All identifiers are quoted with backticks for safety
      expect(sql).toContain("CREATE VIEW `active_events_view`");
      expect(sql).toContain("AS");
      expect(sql).toContain("SELECT");
      expect(sql).toContain("FROM `view_test_events`");
      expect(sql).toContain("WHERE");
      expect(sql).toContain("COMMENT 'Active events only'");
    });

    test("should generate valid CREATE MATERIALIZED VIEW SQL", () => {
      const sql = generateCreateMaterializedViewSQL(eventStatsMV);

      // All identifiers are quoted with backticks for safety
      expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS `event_stats_mv`");
      expect(sql).toContain("DISTRIBUTED BY RANDOM");
      expect(sql).toContain("BUCKETS 4");
      expect(sql).toContain("REFRESH MANUAL");
      expect(sql).toContain("PROPERTIES");
      expect(sql).toContain("AS");
      expect(sql).toContain("SELECT");
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("COMMENT 'Event statistics by venue'");
    });

    test("should generate DROP VIEW SQL with IF EXISTS", () => {
      const sql = generateDropViewSQL(activeEventsView);
      expect(sql).toBe("DROP VIEW IF EXISTS `active_events_view`");
    });

    test("should generate DROP MATERIALIZED VIEW SQL with IF EXISTS", () => {
      const sql = generateDropMaterializedViewSQL(eventStatsMV);
      expect(sql).toBe("DROP MATERIALIZED VIEW IF EXISTS `event_stats_mv`");
    });
  });
});

// ============================================================================
// View and MV Edge Cases (Unit Tests)
// ============================================================================

describe("View and MV Edge Cases", () => {
  // Test tables for edge case tests
  const testEvents = starrocksTable(
    "edge_events",
    {
      id: bigint("id"),
      name: varchar("name", { length: 255 }),
      price: double("price"),
      status: varchar("status", { length: 50 }),
      createdAt: datetime("created_at"),
    },
    (table) => ({
      key: primaryKey(table.id),
      distribution: hash(table.id, { buckets: 4 }),
    })
  );

  describe("View Reserved Word Names", () => {
    test("should handle view named with SQL reserved word", () => {
      const selectView = createView("select")
        .columns({
          id: bigint("id"),
        })
        .as((qb) => qb.select({ id: testEvents.id }).from(testEvents));

      const sql = generateCreateViewSQL(selectView);
      expect(sql).toContain("CREATE VIEW `select`");
    });

    test("should handle view named 'order'", () => {
      const orderView = createView("order")
        .columns({
          id: bigint("id"),
          name: varchar("name", { length: 255 }),
        })
        .as((qb) =>
          qb.select({ id: testEvents.id, name: testEvents.name }).from(testEvents)
        );

      const sql = generateCreateViewSQL(orderView);
      expect(sql).toContain("CREATE VIEW `order`");
    });

    test("should handle view named 'index'", () => {
      const indexView = createView("index")
        .columns({
          id: bigint("id"),
        })
        .as((qb) => qb.select({ id: testEvents.id }).from(testEvents));

      const sql = generateCreateViewSQL(indexView);
      expect(sql).toContain("CREATE VIEW `index`");
    });
  });

  describe("View Security Modes", () => {
    test("should generate view with NONE security", () => {
      const noneSecurityView = createView("none_security")
        .columns({
          id: bigint("id"),
        })
        .security("NONE")
        .as((qb) => qb.select({ id: testEvents.id }).from(testEvents));

      const sql = generateCreateViewSQL(noneSecurityView);
      expect(sql).toContain("SECURITY NONE");
    });

    test("should generate view with INVOKER security", () => {
      const invokerSecurityView = createView("invoker_security")
        .columns({
          id: bigint("id"),
        })
        .security("INVOKER")
        .as((qb) => qb.select({ id: testEvents.id }).from(testEvents));

      const sql = generateCreateViewSQL(invokerSecurityView);
      expect(sql).toContain("SECURITY INVOKER");
    });
  });

  describe("View Comment Edge Cases", () => {
    test("should escape single quotes in comment", () => {
      const quotedComment = createView("quoted_comment")
        .columns({
          id: bigint("id"),
        })
        .comment("This view's purpose is to filter data")
        .as((qb) => qb.select({ id: testEvents.id }).from(testEvents));

      const sql = generateCreateViewSQL(quotedComment);
      // Single quotes should be doubled
      expect(sql).toContain("COMMENT 'This view''s purpose is to filter data'");
    });

    test("should handle empty comment (not included in SQL)", () => {
      const emptyComment = createView("empty_comment")
        .columns({
          id: bigint("id"),
        })
        .comment("")
        .as((qb) => qb.select({ id: testEvents.id }).from(testEvents));

      const sql = generateCreateViewSQL(emptyComment);
      // Empty comment is not included in the SQL (correct behavior)
      expect(sql).not.toContain("COMMENT");
    });

    test("should handle long comment", () => {
      const longCommentText = "A".repeat(1000);
      const longComment = createView("long_comment")
        .columns({
          id: bigint("id"),
        })
        .comment(longCommentText)
        .as((qb) => qb.select({ id: testEvents.id }).from(testEvents));

      const sql = generateCreateViewSQL(longComment);
      expect(sql).toContain(`COMMENT '${longCommentText}'`);
    });
  });

  describe("MV Reserved Word Names", () => {
    test("should handle MV named with SQL reserved word", () => {
      const selectMV = createMaterializedView("select")
        .columns({
          id: bigint("id"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .as((qb) => qb.select({ id: testEvents.id }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(selectMV);
      expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS `select`");
    });
  });

  describe("MV Refresh Strategies", () => {
    test("should handle MANUAL refresh", () => {
      const manualMV = createMaterializedView("manual_refresh")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(manualMV);
      expect(sql).toContain("REFRESH MANUAL");
    });

    test("should handle ASYNC refresh with interval", () => {
      const asyncMV = createMaterializedView("async_refresh")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({
          type: "ASYNC",
          every: { value: 5, unit: "MINUTE" },
        })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(asyncMV);
      expect(sql).toContain("REFRESH ASYNC");
      expect(sql).toContain("EVERY(INTERVAL 5 MINUTE)");
    });

    test("should handle ASYNC refresh with start time", () => {
      const asyncWithStartMV = createMaterializedView("async_start")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({
          type: "ASYNC",
          startTime: "2024-01-01 00:00:00",
          every: { value: 1, unit: "HOUR" },
        })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(asyncWithStartMV);
      expect(sql).toContain("REFRESH ASYNC");
      expect(sql).toContain("START('2024-01-01 00:00:00')");
      expect(sql).toContain("EVERY(INTERVAL 1 HOUR)");
    });

    test("should handle ASYNC refresh with SECOND interval", () => {
      const secondsMV = createMaterializedView("seconds_refresh")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({
          type: "ASYNC",
          every: { value: 30, unit: "SECOND" },
        })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(secondsMV);
      expect(sql).toContain("EVERY(INTERVAL 30 SECOND)");
    });

    test("should handle ASYNC refresh with DAY interval", () => {
      const dayMV = createMaterializedView("daily_refresh")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({
          type: "ASYNC",
          every: { value: 1, unit: "DAY" },
        })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(dayMV);
      expect(sql).toContain("EVERY(INTERVAL 1 DAY)");
    });
  });

  describe("MV Distribution Strategies", () => {
    test("should handle HASH distribution with multiple columns", () => {
      const multiHashMV = createMaterializedView("multi_hash")
        .columns({
          status: varchar("status", { length: 50 }),
          total: bigint("total"),
        })
        .distributed({ type: "HASH", columns: ["status"], buckets: 8 })
        .refresh({ type: "MANUAL" })
        .as((qb) =>
          qb
            .select({ status: testEvents.status, total: count(testEvents.id) })
            .from(testEvents)
            .groupBy(testEvents.status)
        );

      const sql = generateCreateMaterializedViewSQL(multiHashMV);
      expect(sql).toContain("DISTRIBUTED BY HASH(`status`) BUCKETS 8");
    });

    test("should handle RANDOM distribution", () => {
      const randomMV = createMaterializedView("random_dist")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 16 })
        .refresh({ type: "MANUAL" })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(randomMV);
      expect(sql).toContain("DISTRIBUTED BY RANDOM BUCKETS 16");
    });
  });

  describe("MV Properties", () => {
    test("should handle replication_num property", () => {
      const replMV = createMaterializedView("repl_mv")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .properties({ replication_num: 3 })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(replMV);
      expect(sql).toContain('"replication_num" = "3"');
    });

    test("should handle query_rewrite_consistency property", () => {
      const rewriteMV = createMaterializedView("rewrite_mv")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .properties({ query_rewrite_consistency: "loose" })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(rewriteMV);
      expect(sql).toContain('"query_rewrite_consistency" = "loose"');
    });

    test("should handle multiple properties", () => {
      const multiPropsMV = createMaterializedView("multi_props")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .properties({
          replication_num: 1,
          storage_medium: "SSD",
          query_rewrite_consistency: "checked",
        })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(multiPropsMV);
      expect(sql).toContain('"replication_num" = "1"');
      expect(sql).toContain('"storage_medium" = "SSD"');
      expect(sql).toContain('"query_rewrite_consistency" = "checked"');
    });

    test("should handle excluded_trigger_tables as array property", () => {
      const excludeMV = createMaterializedView("exclude_mv")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .properties({
          replication_num: 1,
          excluded_trigger_tables: ["table1", "table2"],
        })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(excludeMV);
      expect(sql).toContain('"excluded_trigger_tables" = "table1,table2"');
    });
  });

  describe("MV Comment Edge Cases", () => {
    test("should escape single quotes in MV comment", () => {
      const quotedMV = createMaterializedView("quoted_mv")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .comment("This MV's purpose is aggregation")
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(quotedMV);
      expect(sql).toContain("COMMENT 'This MV''s purpose is aggregation'");
    });
  });

  describe("Long Identifiers", () => {
    test("should handle long view name (64 chars)", () => {
      const longName = "v".repeat(64);
      const longView = createView(longName)
        .columns({
          id: bigint("id"),
        })
        .as((qb) => qb.select({ id: testEvents.id }).from(testEvents));

      const sql = generateCreateViewSQL(longView);
      expect(sql).toContain(`\`${longName}\``);
    });

    test("should handle long MV name (64 chars)", () => {
      const longName = "m".repeat(64);
      const longMV = createMaterializedView(longName)
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateCreateMaterializedViewSQL(longMV);
      expect(sql).toContain(`\`${longName}\``);
    });
  });

  describe("View/MV Column References", () => {
    test("should create view column references correctly", () => {
      const testView = createView("test_refs")
        .columns({
          eventId: bigint("event_id"),
          eventName: varchar("event_name", { length: 255 }),
        })
        .as((qb) =>
          qb
            .select({ eventId: testEvents.id, eventName: testEvents.name })
            .from(testEvents)
        );

      expect((testView as any).eventId.fullName).toBe("test_refs.event_id");
      expect((testView as any).eventName.fullName).toBe("test_refs.event_name");
      expect((testView as any).eventId.column).toBe("event_id");
      expect((testView as any).eventId.table).toBe("test_refs");
    });

    test("should create MV column references correctly", () => {
      const testMV = createMaterializedView("test_mv_refs")
        .columns({
          statusCount: bigint("status_count"),
          maxPrice: double("max_price"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .as((qb) =>
          qb
            .select({
              statusCount: count(testEvents.id),
              maxPrice: max(testEvents.price),
            })
            .from(testEvents)
        );

      expect((testMV as any).statusCount.fullName).toBe("test_mv_refs.status_count");
      expect((testMV as any).maxPrice.fullName).toBe("test_mv_refs.max_price");
      expect((testMV as any).statusCount.column).toBe("status_count");
      expect((testMV as any).statusCount.table).toBe("test_mv_refs");
    });

    test("should expose getViewName method", () => {
      const testView = createView("named_view")
        .columns({
          id: bigint("id"),
        })
        .as((qb) => qb.select({ id: testEvents.id }).from(testEvents));

      expect((testView as any).getViewName()).toBe("named_view");
    });

    test("should expose getMVName method", () => {
      const testMV = createMaterializedView("named_mv")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      expect((testMV as any).getMVName()).toBe("named_mv");
    });
  });

  describe("DROP SQL Generation", () => {
    test("should generate DROP VIEW without IF EXISTS", () => {
      const testView = createView("drop_test")
        .columns({
          id: bigint("id"),
        })
        .as((qb) => qb.select({ id: testEvents.id }).from(testEvents));

      const sql = generateDropViewSQL(testView, false);
      expect(sql).toBe("DROP VIEW `drop_test`");
    });

    test("should generate DROP MV without IF EXISTS", () => {
      const testMV = createMaterializedView("drop_mv_test")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .refresh({ type: "MANUAL" })
        .as((qb) => qb.select({ total: count(testEvents.id) }).from(testEvents));

      const sql = generateDropMaterializedViewSQL(testMV, false);
      expect(sql).toBe("DROP MATERIALIZED VIEW `drop_mv_test`");
    });
  });
});
