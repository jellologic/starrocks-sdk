import { describe, test, expect } from "bun:test";
import {
  bigint,
  varchar,
  datetime,
  double,
  int,
  boolean,

  starrocksTable,
  primaryKey,
  duplicateKey,
  hash,

  bitmapIndex,
  ginIndex,

  createView,
  createMaterializedView,

  defineSchema,
  diffSchema,
  generateMigration,
  generateMigrationSQL,
  generateDryRunOutput,
  emptyIntrospectedSchema,

  count,
  sum,
  gt,
  sql,
} from "../src/schema/index";
import type { IntrospectedSchema, IntrospectedColumn } from "../src/schema/index";

// ============================================================================
// Helpers
// ============================================================================

function col(overrides: Partial<IntrospectedColumn> & { name: string }): IntrospectedColumn {
  return {
    dataType: "BIGINT",
    isNullable: true,
    defaultValue: null,
    columnKey: null,
    aggregateType: null,
    comment: null,
    ...overrides,
  };
}

function baseTable(name: string, columns: IntrospectedColumn[], overrides: Partial<IntrospectedSchema["tables"][0]> = {}): IntrospectedSchema {
  return {
    database: "testdb",
    tables: [{
      name,
      type: "table" as const,
      columns,
      keyType: "DUPLICATE",
      keyColumns: [columns[0]?.name ?? "id"],
      distributionType: "HASH",
      distributionColumns: [columns[0]?.name ?? "id"],
      buckets: 4,
      partitionType: null,
      partitionColumn: null,
      properties: {},
      indexes: [],
      comment: null,
      ...overrides,
    }],
    views: [],
    materializedViews: [],
  };
}

// ============================================================================
// Column ALTER Statements
// ============================================================================

describe("Column migrations", () => {
  test("ADD COLUMN generates correct SQL", () => {
    const t = starrocksTable("events", {
      id: bigint("id").notNull(),
      title: varchar("title", { length: 255 }),
    }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

    const schema = defineSchema({ tables: { events: t } });
    const existing = baseTable("events", [
      col({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
    ], { keyType: "DUPLICATE" });

    const diff = diffSchema(schema, existing);
    const { migration } = generateMigration(schema, diff, existing);

    const addSql = migration.up.find(s => s.sql.includes("ADD COLUMN"));
    expect(addSql).toBeDefined();
    expect(addSql!.sql).toContain("ALTER TABLE `events` ADD COLUMN title VARCHAR(255)");
    expect(addSql!.object).toBe("column");
  });

  test("ADD COLUMN with NOT NULL and DEFAULT", () => {
    const t = starrocksTable("events", {
      id: bigint("id").notNull(),
      status: varchar("status", { length: 50 }).notNull().default("active"),
    }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

    const schema = defineSchema({ tables: { events: t } });
    const existing = baseTable("events", [
      col({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
    ], { keyType: "DUPLICATE" });

    const diff = diffSchema(schema, existing);
    const { migration } = generateMigration(schema, diff, existing);

    const addSql = migration.up.find(s => s.sql.includes("ADD COLUMN"));
    expect(addSql!.sql).toContain("NOT NULL");
    expect(addSql!.sql).toContain("DEFAULT");
  });

  test("DROP COLUMN generates correct SQL and down migration", () => {
    const t = starrocksTable("events", {
      id: bigint("id").notNull(),
    }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

    const schema = defineSchema({ tables: { events: t } });
    const existing = baseTable("events", [
      col({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
      col({ name: "old_col", dataType: "VARCHAR(100)", isNullable: true }),
    ], { keyType: "DUPLICATE" });

    const diff = diffSchema(schema, existing);
    const { migration } = generateMigration(schema, diff, existing);

    const dropSql = migration.up.find(s => s.sql.includes("DROP COLUMN"));
    expect(dropSql).toBeDefined();
    expect(dropSql!.sql).toContain("DROP COLUMN old_col");

    // Down migration should re-add the column
    const downAdd = migration.down.find(s => s.sql.includes("ADD COLUMN") && s.sql.includes("old_col"));
    expect(downAdd).toBeDefined();
  });

  test("MODIFY COLUMN generates correct SQL for type change", () => {
    const t = starrocksTable("events", {
      id: bigint("id").notNull(),
      count: bigint("count"),
    }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

    const schema = defineSchema({ tables: { events: t } });
    const existing = baseTable("events", [
      col({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
      col({ name: "count", dataType: "INT" }),
    ], { keyType: "DUPLICATE" });

    const diff = diffSchema(schema, existing);
    const { migration } = generateMigration(schema, diff, existing);

    const modifySql = migration.up.find(s => s.sql.includes("MODIFY COLUMN"));
    expect(modifySql).toBeDefined();
    expect(modifySql!.sql).toContain("count BIGINT");

    // Down should revert to INT
    const downModify = migration.down.find(s => s.sql.includes("MODIFY COLUMN"));
    expect(downModify).toBeDefined();
    expect(downModify!.sql).toContain("count INT");
  });
});

// ============================================================================
// Index Migrations
// ============================================================================

describe("Index migrations", () => {
  test("ADD INDEX generates CREATE INDEX SQL", () => {
    const t = starrocksTable("events", {
      id: bigint("id").notNull(),
      status: varchar("status", { length: 50 }),
    }, (t) => ({
      key: duplicateKey(t.id),
      distribution: hash(t.id, { buckets: 4 }),
      indexes: [bitmapIndex("idx_status", t.status)],
    }));

    const schema = defineSchema({ tables: { events: t } });
    const existing = baseTable("events", [
      col({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
      col({ name: "status", dataType: "VARCHAR(50)" }),
    ], { keyType: "DUPLICATE", indexes: [] });

    const diff = diffSchema(schema, existing);
    const { migration } = generateMigration(schema, diff, existing);

    const createIdx = migration.up.find(s => s.sql.includes("CREATE INDEX") || s.sql.includes("ADD INDEX"));
    expect(createIdx).toBeDefined();
    expect(createIdx!.sql).toContain("idx_status");
    expect(createIdx!.object).toBe("index");

    // Down should drop the index
    const dropIdx = migration.down.find(s => s.sql.includes("DROP INDEX") && s.sql.includes("idx_status"));
    expect(dropIdx).toBeDefined();
  });

  test("REMOVE INDEX generates DROP INDEX SQL", () => {
    const t = starrocksTable("events", {
      id: bigint("id").notNull(),
      status: varchar("status", { length: 50 }),
    }, (t) => ({
      key: duplicateKey(t.id),
      distribution: hash(t.id, { buckets: 4 }),
    }));

    const schema = defineSchema({ tables: { events: t } });
    const existing = baseTable("events", [
      col({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
      col({ name: "status", dataType: "VARCHAR(50)" }),
    ], {
      keyType: "DUPLICATE",
      indexes: [{ name: "idx_status", type: "BITMAP", columns: ["status"], properties: {}, comment: null }],
    });

    const diff = diffSchema(schema, existing);
    const { migration } = generateMigration(schema, diff, existing);

    const dropIdx = migration.up.find(s => s.sql.includes("DROP INDEX") && s.sql.includes("idx_status"));
    expect(dropIdx).toBeDefined();
  });

  test("MODIFY INDEX generates DROP + CREATE", () => {
    const t = starrocksTable("events", {
      id: bigint("id").notNull(),
      tags: varchar("tags", { length: 255 }),
    }, (t) => ({
      key: duplicateKey(t.id),
      distribution: hash(t.id, { buckets: 4 }),
      indexes: [ginIndex("idx_tags", [t.tags])],
    }));

    const schema = defineSchema({ tables: { events: t } });
    const existing = baseTable("events", [
      col({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
      col({ name: "tags", dataType: "VARCHAR(255)" }),
    ], {
      keyType: "DUPLICATE",
      indexes: [{ name: "idx_tags", type: "BITMAP", columns: ["tags"], properties: {}, comment: null }],
    });

    const diff = diffSchema(schema, existing);
    const { migration } = generateMigration(schema, diff, existing);
    const upSqls = migration.up.map(s => s.sql);

    // Should drop then recreate
    expect(upSqls.some(s => s.includes("DROP INDEX") && s.includes("idx_tags"))).toBe(true);
    expect(upSqls.some(s => (s.includes("CREATE INDEX") || s.includes("ADD INDEX")) && s.includes("idx_tags"))).toBe(true);
  });
});

// ============================================================================
// View Migrations
// ============================================================================

describe("View migrations", () => {
  const events = starrocksTable("events", {
    id: bigint("id").notNull(),
    title: varchar("title", { length: 255 }),
    createdAt: datetime("created_at"),
  }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

  test("CREATE VIEW for new view", () => {
    const v = createView("recent_events")
      .columns({
        id: bigint("id"),
        title: varchar("title", { length: 255 }),
      })
      .as((qb) =>
        qb.select({ id: events.id, title: events.title })
          .from(events)
      );

    const schema = defineSchema({ views: { recent_events: v } });
    const diff = diffSchema(schema, emptyIntrospectedSchema("testdb"));
    const { migration } = generateMigration(schema, diff, emptyIntrospectedSchema("testdb"));

    const createSql = migration.up.find(s => s.sql.includes("CREATE") && s.sql.includes("VIEW"));
    expect(createSql).toBeDefined();
    expect(createSql!.sql).toContain("recent_events");
    expect(createSql!.object).toBe("view");
  });

  test("DROP VIEW for removed view", () => {
    const schema = defineSchema({});
    const introspected: IntrospectedSchema = {
      database: "testdb",
      tables: [],
      views: [{
        name: "old_view",
        type: "view",
        columns: [col({ name: "id" })],
        definition: "SELECT 1",
        security: null,
        comment: null,
      }],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);
    const { migration } = generateMigration(schema, diff, introspected);

    const dropSql = migration.up.find(s => s.sql.includes("DROP") && s.sql.includes("VIEW") && s.sql.includes("old_view"));
    expect(dropSql).toBeDefined();
  });

  test("RECREATE VIEW for modified view", () => {
    const v = createView("my_view")
      .columns({
        id: bigint("id"),
        title: varchar("title", { length: 255 }),
        extra: varchar("extra", { length: 100 }),
      })
      .as((qb) =>
        qb.select({ id: events.id, title: events.title, extra: sql`'x'` })
          .from(events)
      );

    const schema = defineSchema({ views: { my_view: v } });
    const introspected: IntrospectedSchema = {
      database: "testdb",
      tables: [],
      views: [{
        name: "my_view",
        type: "view",
        columns: [col({ name: "id" }), col({ name: "title", dataType: "VARCHAR(255)" })],
        definition: "SELECT id, title FROM events",
        security: null,
        comment: null,
      }],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);
    const { migration } = generateMigration(schema, diff, introspected);

    // Should use CREATE OR REPLACE VIEW
    const replaceSql = migration.up.find(s => s.sql.includes("VIEW") && s.sql.includes("my_view"));
    expect(replaceSql).toBeDefined();
  });
});

// ============================================================================
// Materialized View Migrations
// ============================================================================

describe("Materialized view migrations", () => {
  const events = starrocksTable("events", {
    id: bigint("id").notNull(),
    venueId: bigint("venue_id"),
    price: double("price"),
  }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

  test("CREATE MATERIALIZED VIEW for new MV", () => {
    const mv = createMaterializedView("event_stats")
      .columns({ venueId: bigint("venue_id"), total: double("total") })
      .distributed({ type: "HASH", columns: ["venue_id"], buckets: 4 })
      .refresh({ type: "ASYNC", every: { value: 1, unit: "HOUR" } })
      .as((qb) =>
        qb.select({ venueId: events.venueId, total: sum(events.price) })
          .from(events)
          .groupBy(events.venueId)
      );

    const schema = defineSchema({ materializedViews: { event_stats: mv } });
    const empty = emptyIntrospectedSchema("testdb");
    const diff = diffSchema(schema, empty);
    const { migration } = generateMigration(schema, diff, empty);

    const createSql = migration.up.find(s => s.sql.includes("CREATE MATERIALIZED VIEW"));
    expect(createSql).toBeDefined();
    expect(createSql!.sql).toContain("event_stats");
    expect(createSql!.object).toBe("materialized_view");
  });

  test("DROP MATERIALIZED VIEW for removed MV", () => {
    const schema = defineSchema({});
    const introspected: IntrospectedSchema = {
      database: "testdb",
      tables: [],
      views: [],
      materializedViews: [{
        name: "old_mv",
        type: "materialized_view",
        columns: [col({ name: "id" })],
        definition: "SELECT 1",
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 4,
        partitionType: null,
        partitionExpression: null,
        refreshType: "ASYNC",
        refreshInterval: null,
        isActive: true,
        properties: {},
        comment: null,
      }],
    };

    const diff = diffSchema(schema, introspected);
    const { migration } = generateMigration(schema, diff, introspected);

    const dropSql = migration.up.find(s => s.sql.includes("DROP MATERIALIZED VIEW") && s.sql.includes("old_mv"));
    expect(dropSql).toBeDefined();
  });

  test("ALTER REFRESH for MV refresh type change", () => {
    const mv = createMaterializedView("stats")
      .columns({ venueId: bigint("venue_id"), total: double("total") })
      .distributed({ type: "HASH", columns: ["venue_id"], buckets: 4 })
      .refresh({ type: "MANUAL" })
      .as((qb) =>
        qb.select({ venueId: events.venueId, total: sum(events.price) })
          .from(events)
          .groupBy(events.venueId)
      );

    const schema = defineSchema({ materializedViews: { stats: mv } });
    const introspected: IntrospectedSchema = {
      database: "testdb",
      tables: [],
      views: [],
      materializedViews: [{
        name: "stats",
        type: "materialized_view",
        columns: [
          col({ name: "venue_id" }),
          col({ name: "total", dataType: "DOUBLE" }),
        ],
        definition: "SELECT venue_id, SUM(price) FROM events GROUP BY venue_id",
        distributionType: "HASH",
        distributionColumns: ["venue_id"],
        buckets: 4,
        partitionType: null,
        partitionExpression: null,
        refreshType: "ASYNC",
        refreshInterval: null,
        isActive: true,
        properties: {},
        comment: null,
      }],
    };

    const diff = diffSchema(schema, introspected);
    const { migration } = generateMigration(schema, diff, introspected);

    const alterSql = migration.up.find(s => s.sql.includes("ALTER MATERIALIZED VIEW"));
    expect(alterSql).toBeDefined();
    expect(alterSql!.sql).toContain("REFRESH");
  });
});

// ============================================================================
// Migration file content
// ============================================================================

describe("Migration file generation", () => {
  test("fileContent contains valid TypeScript", () => {
    const t = starrocksTable("events", {
      id: bigint("id").notNull(),
    }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

    const schema = defineSchema({ tables: { events: t } });
    const empty = emptyIntrospectedSchema("testdb");
    const diff = diffSchema(schema, empty);
    const result = generateMigration(schema, diff, empty);

    expect(result.fileContent).toContain("const migration: Migration");
    expect(result.fileContent).toContain("export default migration");
    expect(result.fileContent).toContain("up:");
    expect(result.fileContent).toContain("down:");
    expect(result.fileContent).toContain("CREATE TABLE");
  });

  test("migration has name and timestamp", () => {
    const t = starrocksTable("events", {
      id: bigint("id").notNull(),
    }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

    const schema = defineSchema({ tables: { events: t } });
    const empty = emptyIntrospectedSchema("testdb");
    const diff = diffSchema(schema, empty);
    const result = generateMigration(schema, diff, empty, {
      name: "add_events_table",
      timestamp: 1700000000000,
    });

    expect(result.migration.name).toContain("add_events_table");
    expect(result.migration.timestamp).toBe(1700000000000);
  });
});

// ============================================================================
// Output Formats
// ============================================================================

describe("Output format coverage", () => {
  test("generateMigrationSQL includes DOWN migration", () => {
    const t = starrocksTable("events", {
      id: bigint("id").notNull(),
      title: varchar("title", { length: 255 }),
    }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

    const schema = defineSchema({ tables: { events: t } });
    const existing = baseTable("events", [
      col({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
    ], { keyType: "DUPLICATE" });

    const diff = diffSchema(schema, existing);
    const { up, down } = generateMigrationSQL(schema, diff, existing);

    expect(up).toContain("ADD COLUMN");
    expect(down).toContain("DROP COLUMN");
  });

  test("generateDryRunOutput shows warnings for destructive operations", () => {
    const schema = defineSchema({});
    const existing: IntrospectedSchema = {
      database: "testdb",
      tables: [{
        name: "to_drop",
        type: "table",
        columns: [col({ name: "id" })],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 4,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        indexes: [],
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, existing);
    const dryRun = generateDryRunOutput(schema, diff, existing);

    expect(dryRun).toContain("DRY RUN");
    expect(dryRun).toContain("to_drop");
  });

  test("empty diff produces no migration statements", () => {
    const t = starrocksTable("events", {
      id: bigint("id").notNull(),
    }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

    const schema = defineSchema({ tables: { events: t } });
    const existing = baseTable("events", [
      col({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
    ], { keyType: "DUPLICATE" });

    const diff = diffSchema(schema, existing);
    const { migration } = generateMigration(schema, diff, existing);

    expect(migration.up).toHaveLength(0);
    expect(migration.down).toHaveLength(0);
  });
});
