import { describe, test, expect } from "bun:test";
import {
  bigint,
  varchar,
  double,
  datetime,
  starrocksTable,
  primaryKey,
  hash,
  createView,
  createMaterializedView,
  defineSchema,
  schemaToIntrospected,
  count,
  sum,
  gt,
  sql,
} from "../src/schema/index";

const events = starrocksTable("events", {
  id: bigint("id").notNull(),
  title: varchar("title", { length: 255 }),
  venueId: bigint("venue_id"),
  price: double("price"),
  createdAt: datetime("created_at"),
}, (t) => ({
  pk: primaryKey(t.id),
  dist: hash(t.id, { buckets: 8 }),
}));

describe("View Snapshot", () => {
  test("converts view to IntrospectedView", () => {
    const recentEvents = createView("recent_events")
      .columns({
        id: bigint("id"),
        title: varchar("title", { length: 255 }),
      })
      .security("INVOKER")
      .comment("Recent events view")
      .as((qb) =>
        qb.select({ id: events.id, title: events.title })
          .from(events)
          .where(gt(events.createdAt, sql`NOW() - INTERVAL 7 DAY`))
      );

    const schema = defineSchema({
      tables: { events },
      views: { recentEvents },
    });

    const snapshot = schemaToIntrospected(schema, "testdb");

    expect(snapshot.views.length).toBe(1);
    const view = snapshot.views[0];
    expect(view.name).toBe("recent_events");
    expect(view.type).toBe("view");
    expect(view.columns.length).toBe(2);
    expect(view.columns[0].name).toBe("id");
    expect(view.columns[1].name).toBe("title");
    expect(view.definition).toContain("SELECT");
    expect(view.security).toBe("INVOKER");
    expect(view.comment).toBe("Recent events view");
  });

  test("view with no security has null security", () => {
    const simpleView = createView("simple_view")
      .columns({ id: bigint("id") })
      .as((qb) => qb.select({ id: events.id }).from(events));

    const schema = defineSchema({
      tables: { events },
      views: { simpleView },
    });

    const snapshot = schemaToIntrospected(schema, "testdb");
    expect(snapshot.views[0].security).toBeNull();
  });
});

describe("Materialized View Snapshot", () => {
  test("converts MV to IntrospectedMaterializedView", () => {
    const eventsByVenue = createMaterializedView("events_by_venue")
      .columns({
        venueId: bigint("venue_id"),
        eventCount: bigint("event_count"),
        totalRevenue: double("total_revenue"),
      })
      .distributed({ type: "HASH", columns: ["venue_id"], buckets: 4 })
      .refresh({
        type: "ASYNC",
        every: { value: 1, unit: "HOUR" },
      })
      .properties({ replication_num: 1 })
      .comment("Events by venue")
      .as((qb) =>
        qb.select({
          venueId: events.venueId,
          eventCount: count(events.id),
          totalRevenue: sum(events.price),
        })
        .from(events)
        .groupBy(events.venueId)
      );

    const schema = defineSchema({
      tables: { events },
      materializedViews: { eventsByVenue },
    });

    const snapshot = schemaToIntrospected(schema, "testdb");

    expect(snapshot.materializedViews.length).toBe(1);
    const mv = snapshot.materializedViews[0];
    expect(mv.name).toBe("events_by_venue");
    expect(mv.type).toBe("materialized_view");
    expect(mv.columns.length).toBe(3);
    expect(mv.distributionType).toBe("HASH");
    expect(mv.distributionColumns).toEqual(["venue_id"]);
    expect(mv.buckets).toBe(4);
    expect(mv.refreshType).toBe("ASYNC");
    expect(mv.refreshInterval).toBe("1 HOUR");
    expect(mv.isActive).toBe(true);
    expect(mv.properties["replication_num"]).toBe("1");
    expect(mv.comment).toBe("Events by venue");
    expect(mv.definition).toContain("SELECT");
  });

  test("MV with manual refresh", () => {
    const manualMV = createMaterializedView("manual_mv")
      .columns({ id: bigint("id") })
      .refresh({ type: "MANUAL" })
      .as((qb) => qb.select({ id: events.id }).from(events));

    const schema = defineSchema({
      tables: { events },
      materializedViews: { manualMV },
    });

    const snapshot = schemaToIntrospected(schema, "testdb");
    expect(snapshot.materializedViews[0].refreshType).toBe("MANUAL");
    expect(snapshot.materializedViews[0].refreshInterval).toBeNull();
  });
});

describe("MV with RANDOM distribution", () => {
  test("RANDOM distribution has empty columns", () => {
    const mv = createMaterializedView("random_mv")
      .columns({ id: bigint("id"), total: double("total") })
      .distributed({ type: "RANDOM", buckets: 4 })
      .refresh({ type: "MANUAL" })
      .as((qb) =>
        qb.select({ id: events.id, total: sum(events.price) })
          .from(events)
          .groupBy(events.id)
      );

    const schema = defineSchema({
      tables: { events },
      materializedViews: { randomMv: mv },
    });

    const snapshot = schemaToIntrospected(schema, "testdb");
    const mvSnapshot = snapshot.materializedViews[0];
    expect(mvSnapshot.distributionType).toBe("RANDOM");
    expect(mvSnapshot.distributionColumns).toEqual([]);
    expect(mvSnapshot.buckets).toBe(4);
  });
});

describe("MV with partition config", () => {
  test("EXPRESSION partition is captured", () => {
    const mv = createMaterializedView("partitioned_mv")
      .columns({ id: bigint("id") })
      .partitionBy({ type: "EXPRESSION", expression: "date_trunc('day', created_at)" } as any)
      .refresh({ type: "ASYNC", every: { value: 1, unit: "HOUR" } })
      .as((qb) => qb.select({ id: events.id }).from(events));

    const schema = defineSchema({
      tables: { events },
      materializedViews: { partitionedMv: mv },
    });

    const snapshot = schemaToIntrospected(schema, "testdb");
    const mvSnapshot = snapshot.materializedViews[0];
    expect(mvSnapshot.partitionType).toBe("EXPRESSION");
    expect(mvSnapshot.partitionExpression).toBe("date_trunc('day', created_at)");
  });

  test("RANGE partition uses column", () => {
    const mv = createMaterializedView("range_mv")
      .columns({ id: bigint("id") })
      .partitionBy({ type: "RANGE", column: "created_at" } as any)
      .refresh({ type: "MANUAL" })
      .as((qb) => qb.select({ id: events.id }).from(events));

    const schema = defineSchema({
      tables: { events },
      materializedViews: { rangeMv: mv },
    });

    const snapshot = schemaToIntrospected(schema, "testdb");
    const mvSnapshot = snapshot.materializedViews[0];
    expect(mvSnapshot.partitionType).toBe("RANGE");
    expect(mvSnapshot.partitionExpression).toBe("created_at");
  });
});

describe("MV without refresh config", () => {
  test("MV with no refresh has null refresh fields", () => {
    const mv = createMaterializedView("no_refresh_mv")
      .columns({ id: bigint("id") })
      .as((qb) => qb.select({ id: events.id }).from(events));

    const schema = defineSchema({
      tables: { events },
      materializedViews: { noRefreshMv: mv },
    });

    const snapshot = schemaToIntrospected(schema, "testdb");
    const mvSnapshot = snapshot.materializedViews[0];
    expect(mvSnapshot.refreshType).toBeNull();
    expect(mvSnapshot.refreshInterval).toBeNull();
  });
});

describe("Full Schema Snapshot", () => {
  test("includes tables, views, and MVs", () => {
    const view = createView("v1")
      .columns({ id: bigint("id") })
      .as((qb) => qb.select({ id: events.id }).from(events));

    const mv = createMaterializedView("mv1")
      .columns({ id: bigint("id") })
      .refresh({ type: "MANUAL" })
      .as((qb) => qb.select({ id: events.id }).from(events));

    const schema = defineSchema({
      tables: { events },
      views: { view },
      materializedViews: { mv },
    });

    const snapshot = schemaToIntrospected(schema, "testdb");
    expect(snapshot.tables.length).toBe(1);
    expect(snapshot.views.length).toBe(1);
    expect(snapshot.materializedViews.length).toBe(1);
    expect(snapshot.database).toBe("testdb");
  });
});
