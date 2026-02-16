import { describe, test, expect } from "bun:test";
import {
  // Column types
  bigint,
  varchar,
  datetime,
  double,

  // Table
  starrocksTable,
  primaryKey,
  hash,

  // Views
  createView,
  generateCreateViewSQL,
  generateDropViewSQL,
  generateReplaceViewSQL,

  // Materialized Views
  createMaterializedView,
  generateCreateMaterializedViewSQL,
  generateDropMaterializedViewSQL,
  generateAlterRefreshSQL,

  // Expressions
  eq,
  gt,
  sql,

  // Aggregates
  count,
  sum,
  max,
} from "../src/schema/index";

// Test tables for view definitions
const events = starrocksTable("events", {
  id: bigint("id").notNull(),
  name: varchar("name", { length: 255 }),
  createdAt: datetime("created_at"),
  venueId: bigint("venue_id"),
  price: double("price"),
}, (t) => ({
  key: primaryKey(t.id),
  distribution: hash(t.id, { buckets: 8 }),
}));

const venues = starrocksTable("venues", {
  id: bigint("id").notNull(),
  name: varchar("name", { length: 255 }),
  city: varchar("city", { length: 100 }),
}, (t) => ({
  key: primaryKey(t.id),
  distribution: hash(t.id, { buckets: 4 }),
}));

describe("View Definitions", () => {
  describe("View Builder", () => {
    test("should create basic view", () => {
      const recentEvents = createView("recent_events")
        .columns({
          id: bigint("id"),
          name: varchar("name", { length: 255 }),
        })
        .as((qb) =>
          qb.select({
            id: events.id,
            name: events.name,
          })
          .from(events)
        );

      expect(recentEvents._type).toBe("view");
      expect(recentEvents.getViewName()).toBe("recent_events");
      expect(recentEvents.query.sql).toContain("SELECT");
      expect(recentEvents.query.sql).toContain("FROM `events`");
    });

    test("should create view with security mode", () => {
      const secureView = createView("secure_events")
        .columns({
          id: bigint("id"),
        })
        .security("INVOKER")
        .as((qb) =>
          qb.select({ id: events.id })
          .from(events)
        );

      expect(secureView.config.security).toBe("INVOKER");
    });

    test("should create view with comment", () => {
      const commentedView = createView("commented_events")
        .columns({
          id: bigint("id"),
        })
        .comment("Events with comments")
        .as((qb) =>
          qb.select({ id: events.id })
          .from(events)
        );

      expect(commentedView.config.comment).toBe("Events with comments");
    });

    test("should create view with WHERE clause", () => {
      const filteredView = createView("filtered_events")
        .columns({
          id: bigint("id"),
          name: varchar("name", { length: 255 }),
        })
        .as((qb) =>
          qb.select({
            id: events.id,
            name: events.name,
          })
          .from(events)
          .where(gt(events.createdAt, sql`NOW() - INTERVAL 7 DAY`))
        );

      expect(filteredView.query.sql).toContain("WHERE");
      expect(filteredView.query.sql).toContain("events.created_at > NOW() - INTERVAL 7 DAY");
    });

    test("should create view with JOIN", () => {
      const joinedView = createView("events_with_venues")
        .columns({
          eventName: varchar("event_name", { length: 255 }),
          venueName: varchar("venue_name", { length: 255 }),
          city: varchar("city", { length: 100 }),
        })
        .as((qb) =>
          qb.select({
            eventName: events.name,
            venueName: venues.name,
            city: venues.city,
          })
          .from(events)
          .innerJoin(venues, eq(events.venueId, venues.id))
        );

      expect(joinedView.query.sql).toContain("INNER JOIN `venues`");
      expect(joinedView.query.sql).toContain("events.venue_id = venues.id");
    });
  });

  describe("View SQL Generation", () => {
    test("should generate CREATE VIEW SQL", () => {
      const view = createView("test_view")
        .columns({
          id: bigint("id"),
          name: varchar("name", { length: 255 }),
        })
        .as((qb) =>
          qb.select({
            id: events.id,
            name: events.name,
          })
          .from(events)
        );

      const sql = generateCreateViewSQL(view);

      // All identifiers are quoted with backticks for safety
      expect(sql).toContain("CREATE VIEW `test_view`");
      expect(sql).toContain("(`id`, `name`)");
      expect(sql).toContain("AS");
      expect(sql).toContain("SELECT");
    });

    test("should generate CREATE VIEW with comment", () => {
      const view = createView("commented_view")
        .columns({
          id: bigint("id"),
        })
        .comment("Test view with comment")
        .as((qb) =>
          qb.select({ id: events.id })
          .from(events)
        );

      const sql = generateCreateViewSQL(view);

      expect(sql).toContain("COMMENT 'Test view with comment'");
    });

    test("should generate CREATE VIEW with security", () => {
      const view = createView("secure_view")
        .columns({
          id: bigint("id"),
        })
        .security("INVOKER")
        .as((qb) =>
          qb.select({ id: events.id })
          .from(events)
        );

      const sql = generateCreateViewSQL(view);

      expect(sql).toContain("SECURITY INVOKER");
    });

    test("should escape single quotes in comment", () => {
      const view = createView("quoted_view")
        .columns({
          id: bigint("id"),
        })
        .comment("View with 'quotes'")
        .as((qb) =>
          qb.select({ id: events.id })
          .from(events)
        );

      const sql = generateCreateViewSQL(view);

      expect(sql).toContain("COMMENT 'View with ''quotes'''");
    });

    test("should generate DROP VIEW SQL", () => {
      const view = createView("drop_test")
        .columns({ id: bigint("id") })
        .as((qb) => qb.select({ id: events.id }).from(events));

      const sqlIfExists = generateDropViewSQL(view);
      const sqlForce = generateDropViewSQL(view, false);

      expect(sqlIfExists).toBe("DROP VIEW IF EXISTS `drop_test`");
      expect(sqlForce).toBe("DROP VIEW `drop_test`");
    });

    test("should generate CREATE OR REPLACE VIEW SQL", () => {
      const view = createView("replace_test")
        .columns({ id: bigint("id"), name: varchar("name", { length: 255 }) })
        .comment("Replaceable view")
        .as((qb) => qb.select({ id: events.id, name: events.name }).from(events));

      const sql = generateReplaceViewSQL(view);

      expect(sql).toContain("CREATE OR REPLACE VIEW `replace_test`");
      expect(sql).toContain("(`id`, `name`)");
      expect(sql).toContain("COMMENT 'Replaceable view'");
      expect(sql).toContain("AS");
      expect(sql).toContain("SELECT");
    });

    test("should generate CREATE OR REPLACE VIEW SQL with security", () => {
      const view = createView("secure_replace_test")
        .columns({ id: bigint("id") })
        .security("INVOKER")
        .as((qb) => qb.select({ id: events.id }).from(events));

      const sql = generateReplaceViewSQL(view);

      expect(sql).toContain("CREATE OR REPLACE VIEW `secure_replace_test`");
      expect(sql).toContain("SECURITY INVOKER");
    });
  });
});

describe("Materialized View Definitions", () => {
  describe("MV Builder", () => {
    test("should create basic materialized view", () => {
      const eventStats = createMaterializedView("event_stats")
        .columns({
          venueId: bigint("venue_id"),
          eventCount: bigint("event_count"),
        })
        .as((qb) =>
          qb.select({
            venueId: events.venueId,
            eventCount: count(events.id),
          })
          .from(events)
          .groupBy(events.venueId)
        );

      expect(eventStats._type).toBe("materialized_view");
      expect(eventStats.getMVName()).toBe("event_stats");
      expect(eventStats.query.sql).toContain("GROUP BY");
    });

    test("should create MV with distribution", () => {
      const mv = createMaterializedView("distributed_mv")
        .columns({
          venueId: bigint("venue_id"),
          total: bigint("total"),
        })
        .distributed({ type: "HASH", columns: ["venue_id"], buckets: 8 })
        .as((qb) =>
          qb.select({
            venueId: events.venueId,
            total: count(events.id),
          })
          .from(events)
          .groupBy(events.venueId)
        );

      expect(mv.config.distribution).toEqual({
        type: "HASH",
        columns: ["venue_id"],
        buckets: 8,
      });
    });

    test("should create MV with partition", () => {
      const mv = createMaterializedView("partitioned_mv")
        .columns({
          createdAt: datetime("created_at"),
          eventCount: bigint("event_count"),
        })
        .partitionBy({
          type: "RANGE",
          column: "created_at",
          interval: "DAY",
        })
        .as((qb) =>
          qb.select({
            createdAt: events.createdAt,
            eventCount: count(events.id),
          })
          .from(events)
          .groupBy(events.createdAt)
        );

      expect(mv.config.partition?.type).toBe("RANGE");
    });

    test("should create MV with manual refresh", () => {
      const mv = createMaterializedView("manual_mv")
        .columns({
          total: bigint("total"),
        })
        .refresh({ type: "MANUAL" })
        .as((qb) =>
          qb.select({ total: count(events.id) })
          .from(events)
        );

      expect(mv.config.refresh?.type).toBe("MANUAL");
    });

    test("should create MV with async refresh", () => {
      const mv = createMaterializedView("async_mv")
        .columns({
          total: bigint("total"),
        })
        .refresh({
          type: "ASYNC",
          startTime: "2024-01-01 00:00:00",
          every: { value: 1, unit: "HOUR" },
        })
        .as((qb) =>
          qb.select({ total: count(events.id) })
          .from(events)
        );

      expect(mv.config.refresh?.type).toBe("ASYNC");
      expect(mv.config.refresh?.startTime).toBe("2024-01-01 00:00:00");
      expect(mv.config.refresh?.every).toEqual({ value: 1, unit: "HOUR" });
    });

    test("should create MV with properties", () => {
      const mv = createMaterializedView("props_mv")
        .columns({
          total: bigint("total"),
        })
        .properties({
          replication_num: 1,
          query_rewrite_consistency: "loose",
          partition_refresh_number: 3,
        })
        .as((qb) =>
          qb.select({ total: count(events.id) })
          .from(events)
        );

      expect(mv.config.properties?.replication_num).toBe(1);
      expect(mv.config.properties?.query_rewrite_consistency).toBe("loose");
      expect(mv.config.properties?.partition_refresh_number).toBe(3);
    });

    test("should create MV with comment", () => {
      const mv = createMaterializedView("commented_mv")
        .columns({
          total: bigint("total"),
        })
        .comment("Test MV comment")
        .as((qb) =>
          qb.select({ total: count(events.id) })
          .from(events)
        );

      expect(mv.config.comment).toBe("Test MV comment");
    });

    test("should create full MV with all options", () => {
      const eventsByVenue = createMaterializedView("events_by_venue")
        .columns({
          venueId: bigint("venue_id"),
          venueName: varchar("venue_name", { length: 255 }),
          eventCount: bigint("event_count"),
          totalRevenue: double("total_revenue"),
          lastEvent: datetime("last_event"),
        })
        .distributed({ type: "HASH", columns: ["venue_id"], buckets: 8 })
        .partitionBy({
          type: "RANGE",
          column: "last_event",
          interval: "MONTH",
        })
        .refresh({
          type: "ASYNC",
          startTime: "2024-01-01 00:00:00",
          every: { value: 1, unit: "HOUR" },
        })
        .properties({
          replication_num: 1,
          query_rewrite_consistency: "loose",
        })
        .comment("Aggregated event statistics by venue")
        .as((qb) =>
          qb.select({
            venueId: events.venueId,
            venueName: venues.name,
            eventCount: count(events.id),
            totalRevenue: sum(events.price),
            lastEvent: max(events.createdAt),
          })
          .from(events)
          .innerJoin(venues, eq(events.venueId, venues.id))
          .groupBy(events.venueId, venues.name)
        );

      expect(eventsByVenue._type).toBe("materialized_view");
      expect(eventsByVenue.getMVName()).toBe("events_by_venue");
      expect(eventsByVenue.config.distribution?.type).toBe("HASH");
      expect(eventsByVenue.config.partition?.type).toBe("RANGE");
      expect(eventsByVenue.config.refresh?.type).toBe("ASYNC");
      expect(eventsByVenue.config.properties?.replication_num).toBe(1);
      expect(eventsByVenue.config.comment).toBe("Aggregated event statistics by venue");
    });
  });

  describe("MV SQL Generation", () => {
    test("should generate CREATE MATERIALIZED VIEW SQL", () => {
      const mv = createMaterializedView("test_mv")
        .columns({
          venueId: bigint("venue_id"),
          total: bigint("total"),
        })
        .as((qb) =>
          qb.select({
            venueId: events.venueId,
            total: count(events.id),
          })
          .from(events)
          .groupBy(events.venueId)
        );

      const sql = generateCreateMaterializedViewSQL(mv);

      expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS `test_mv`");
      expect(sql).toContain("AS");
      expect(sql).toContain("SELECT");
      expect(sql).toContain("GROUP BY");
    });

    test("should generate MV with distribution", () => {
      const mv = createMaterializedView("hash_mv")
        .columns({
          venueId: bigint("venue_id"),
          total: bigint("total"),
        })
        .distributed({ type: "HASH", columns: ["venue_id"], buckets: 8 })
        .as((qb) =>
          qb.select({
            venueId: events.venueId,
            total: count(events.id),
          })
          .from(events)
          .groupBy(events.venueId)
        );

      const sql = generateCreateMaterializedViewSQL(mv);

      // Column names in distribution are quoted
      expect(sql).toContain("DISTRIBUTED BY HASH(`venue_id`) BUCKETS 8");
    });

    test("should generate MV with random distribution", () => {
      const mv = createMaterializedView("random_mv")
        .columns({
          total: bigint("total"),
        })
        .distributed({ type: "RANDOM", buckets: 4 })
        .as((qb) =>
          qb.select({ total: count(events.id) })
          .from(events)
        );

      const sql = generateCreateMaterializedViewSQL(mv);

      expect(sql).toContain("DISTRIBUTED BY RANDOM BUCKETS 4");
    });

    test("should generate MV with range partition", () => {
      const mv = createMaterializedView("partitioned_mv")
        .columns({
          createdAt: datetime("created_at"),
          total: bigint("total"),
        })
        .partitionBy({
          type: "RANGE",
          column: "created_at",
          interval: "DAY",
        })
        .as((qb) =>
          qb.select({
            createdAt: events.createdAt,
            total: count(events.id),
          })
          .from(events)
          .groupBy(events.createdAt)
        );

      const sql = generateCreateMaterializedViewSQL(mv);

      // Column names in partition are quoted
      expect(sql).toContain("PARTITION BY date_trunc('day', `created_at`)");
    });

    test("should generate MV with expression partition", () => {
      const mv = createMaterializedView("expr_partitioned_mv")
        .columns({
          total: bigint("total"),
        })
        .partitionBy({
          type: "EXPRESSION",
          expression: "date_trunc('week', created_at)",
        })
        .as((qb) =>
          qb.select({ total: count(events.id) })
          .from(events)
        );

      const sql = generateCreateMaterializedViewSQL(mv);

      expect(sql).toContain("PARTITION BY (date_trunc('week', created_at))");
    });

    test("should generate MV with manual refresh", () => {
      const mv = createMaterializedView("manual_mv")
        .columns({
          total: bigint("total"),
        })
        .refresh({ type: "MANUAL" })
        .as((qb) =>
          qb.select({ total: count(events.id) })
          .from(events)
        );

      const sql = generateCreateMaterializedViewSQL(mv);

      expect(sql).toContain("REFRESH MANUAL");
    });

    test("should generate MV with async refresh", () => {
      const mv = createMaterializedView("async_mv")
        .columns({
          total: bigint("total"),
        })
        .refresh({
          type: "ASYNC",
          startTime: "2024-01-01 00:00:00",
          every: { value: 30, unit: "MINUTE" },
        })
        .as((qb) =>
          qb.select({ total: count(events.id) })
          .from(events)
        );

      const sql = generateCreateMaterializedViewSQL(mv);

      expect(sql).toContain("REFRESH ASYNC START('2024-01-01 00:00:00') EVERY(INTERVAL 30 MINUTE)");
    });

    test("should generate MV with properties", () => {
      const mv = createMaterializedView("props_mv")
        .columns({
          total: bigint("total"),
        })
        .properties({
          replication_num: 1,
          query_rewrite_consistency: "loose",
        })
        .as((qb) =>
          qb.select({ total: count(events.id) })
          .from(events)
        );

      const sql = generateCreateMaterializedViewSQL(mv);

      expect(sql).toContain("PROPERTIES");
      expect(sql).toContain('"replication_num" = "1"');
      expect(sql).toContain('"query_rewrite_consistency" = "loose"');
    });

    test("should generate MV with comment", () => {
      const mv = createMaterializedView("commented_mv")
        .columns({
          total: bigint("total"),
        })
        .comment("Test MV comment")
        .as((qb) =>
          qb.select({ total: count(events.id) })
          .from(events)
        );

      const sql = generateCreateMaterializedViewSQL(mv);

      expect(sql).toContain("COMMENT 'Test MV comment'");
    });

    test("should generate DROP MATERIALIZED VIEW SQL", () => {
      const mv = createMaterializedView("drop_test")
        .columns({ total: bigint("total") })
        .as((qb) => qb.select({ total: count(events.id) }).from(events));

      const sqlIfExists = generateDropMaterializedViewSQL(mv);
      const sqlForce = generateDropMaterializedViewSQL(mv, false);

      // All identifiers are quoted with backticks for safety
      expect(sqlIfExists).toBe("DROP MATERIALIZED VIEW IF EXISTS `drop_test`");
      expect(sqlForce).toBe("DROP MATERIALIZED VIEW `drop_test`");
    });

    test("should generate ALTER REFRESH SQL for manual", () => {
      const mv = createMaterializedView("alter_test")
        .columns({ total: bigint("total") })
        .as((qb) => qb.select({ total: count(events.id) }).from(events));

      const sql = generateAlterRefreshSQL(mv, { type: "MANUAL" });

      // All identifiers are quoted with backticks for safety
      expect(sql).toBe("ALTER MATERIALIZED VIEW `alter_test` REFRESH MANUAL");
    });

    test("should generate ALTER REFRESH SQL for async", () => {
      const mv = createMaterializedView("alter_test")
        .columns({ total: bigint("total") })
        .as((qb) => qb.select({ total: count(events.id) }).from(events));

      const sql = generateAlterRefreshSQL(mv, {
        type: "ASYNC",
        startTime: "2024-06-01 00:00:00",
        every: { value: 2, unit: "HOUR" },
      });

      // All identifiers are quoted with backticks for safety
      expect(sql).toBe(
        "ALTER MATERIALIZED VIEW `alter_test` REFRESH ASYNC START('2024-06-01 00:00:00') EVERY(INTERVAL 2 HOUR)"
      );
    });
  });

  describe("MV Column References", () => {
    test("should provide column references for queries", () => {
      const eventStats = createMaterializedView("event_stats")
        .columns({
          venueId: bigint("venue_id"),
          eventCount: bigint("event_count"),
        })
        .as((qb) =>
          qb.select({
            venueId: events.venueId,
            eventCount: count(events.id),
          })
          .from(events)
          .groupBy(events.venueId)
        );

      // Column references should be available
      expect(eventStats.venueId).toBeDefined();
      expect(eventStats.venueId.fullName).toBe("event_stats.venue_id");
      expect(eventStats.eventCount).toBeDefined();
      expect(eventStats.eventCount.fullName).toBe("event_stats.event_count");
    });
  });
});

describe("View Column References", () => {
  test("should provide column references for queries", () => {
    const recentEvents = createView("recent_events")
      .columns({
        id: bigint("id"),
        name: varchar("name", { length: 255 }),
      })
      .as((qb) =>
        qb.select({
          id: events.id,
          name: events.name,
        })
        .from(events)
      );

    // Column references should be available
    expect(recentEvents.id).toBeDefined();
    expect(recentEvents.id.fullName).toBe("recent_events.id");
    expect(recentEvents.name).toBeDefined();
    expect(recentEvents.name.fullName).toBe("recent_events.name");
  });
});
