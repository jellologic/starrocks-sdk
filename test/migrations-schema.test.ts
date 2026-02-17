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
  duplicateKey,
  hash,

  // Views
  createView,
  createMaterializedView,

  // Schema
  defineSchema,
  diffSchema,
  summarizeDiff,
  generateMigration,
  generateMigrationSQL,
  generateDryRunOutput,

  // Expressions
  gt,
  sql,

  // Aggregates
  count,
  sum,

  // Types
  type IntrospectedSchema,
} from "../src/schema/index";

// ============================================================================
// Test Data
// ============================================================================

// Define test tables
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

// Define test views
const recentEvents = createView("recent_events")
  .columns({
    id: bigint("id"),
    name: varchar("name", { length: 255 }),
  })
  .comment("Events from the last 7 days")
  .as((qb) =>
    qb.select({
      id: events.id,
      name: events.name,
    })
    .from(events)
    .where(gt(events.createdAt, sql`NOW() - INTERVAL 7 DAY`))
  );

// Define test MVs
const eventStats = createMaterializedView("event_stats")
  .columns({
    venueId: bigint("venue_id"),
    eventCount: bigint("event_count"),
    totalRevenue: double("total_revenue"),
  })
  .distributed({ type: "HASH", columns: ["venue_id"], buckets: 4 })
  .refresh({ type: "ASYNC", every: { value: 1, unit: "HOUR" } })
  .as((qb) =>
    qb.select({
      venueId: events.venueId,
      eventCount: count(events.id),
      totalRevenue: sum(events.price),
    })
    .from(events)
    .groupBy(events.venueId)
  );

// ============================================================================
// Tests
// ============================================================================

describe("Schema Definition", () => {
  test("should create schema with tables", () => {
    const schema = defineSchema({
      tables: { events, venues },
    });

    expect(schema._type).toBe("schema");
    expect(schema.getTableNames()).toContain("events");
    expect(schema.getTableNames()).toContain("venues");
    expect(schema.getTableNames()).toHaveLength(2);
  });

  test("should create schema with views", () => {
    const schema = defineSchema({
      views: { recentEvents },
    });

    expect(schema.getViewNames()).toContain("recent_events");
    expect(schema.getViewNames()).toHaveLength(1);
  });

  test("should create schema with materialized views", () => {
    const schema = defineSchema({
      materializedViews: { eventStats },
    });

    expect(schema.getMaterializedViewNames()).toContain("event_stats");
    expect(schema.getMaterializedViewNames()).toHaveLength(1);
  });

  test("should create full schema with all object types", () => {
    const schema = defineSchema({
      tables: { events, venues },
      views: { recentEvents },
      materializedViews: { eventStats },
    });

    expect(schema.getTableNames()).toHaveLength(2);
    expect(schema.getViewNames()).toHaveLength(1);
    expect(schema.getMaterializedViewNames()).toHaveLength(1);
  });

  test("should get table by name", () => {
    const schema = defineSchema({
      tables: { events },
    });

    const table = schema.getTable("events");
    expect(table).toBeDefined();
    expect(table?.columns.id).toBeDefined();
  });

  test("should get view by name", () => {
    const schema = defineSchema({
      views: { recentEvents },
    });

    const view = schema.getView("recent_events");
    expect(view).toBeDefined();
    expect(view?._type).toBe("view");
  });

  test("should get MV by name", () => {
    const schema = defineSchema({
      materializedViews: { eventStats },
    });

    const mv = schema.getMaterializedView("event_stats");
    expect(mv).toBeDefined();
    expect(mv?._type).toBe("materialized_view");
  });

  test("should return undefined for non-existent objects", () => {
    const schema = defineSchema({
      tables: { events },
    });

    expect(schema.getTable("non_existent")).toBeUndefined();
    expect(schema.getView("non_existent")).toBeUndefined();
    expect(schema.getMaterializedView("non_existent")).toBeUndefined();
  });
});

describe("Schema Diffing", () => {
  // Mock introspected schema representing empty database
  const emptyIntrospected: IntrospectedSchema = {
    database: "test_db",
    tables: [],
    views: [],
    materializedViews: [],
  };

  test("should detect added tables", () => {
    const schema = defineSchema({
      tables: { events },
    });

    const diff = diffSchema(schema, emptyIntrospected);

    expect(diff.tables.added).toContain("events");
    expect(diff.hasChanges).toBe(true);
  });

  test("should detect removed tables", () => {
    const schema = defineSchema({
      tables: {},
    });

    const introspected: IntrospectedSchema = {
      database: "test_db",
      tables: [{
        name: "old_table",
        type: "table",
        columns: [{ name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null }],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 4,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);

    expect(diff.tables.removed).toContain("old_table");
    expect(diff.hasChanges).toBe(true);
  });

  test("should detect added columns", () => {
    const schema = defineSchema({
      tables: { events },
    });

    // Introspected table missing the 'price' column
    const introspected: IntrospectedSchema = {
      database: "test_db",
      tables: [{
        name: "events",
        type: "table",
        columns: [
          { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          { name: "name", dataType: "VARCHAR(255)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          { name: "created_at", dataType: "DATETIME", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          { name: "venue_id", dataType: "BIGINT", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          // price column is missing
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 8,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);

    expect(diff.tables.modified).toHaveLength(1);
    expect(diff.tables.modified[0]!.columnChanges).toBeDefined();
    const addedCols = diff.tables.modified[0]!.columnChanges!.filter(c => c.type === "add");
    expect(addedCols.some(c => c.columnName === "price")).toBe(true);
  });

  test("should detect removed columns", () => {
    // Schema without venue_id
    const tableWithoutVenueId = starrocksTable("events", {
      id: bigint("id").notNull(),
      name: varchar("name", { length: 255 }),
    }, (t) => ({
      key: primaryKey(t.id),
      distribution: hash(t.id, { buckets: 8 }),
    }));

    const schema = defineSchema({
      tables: { events: tableWithoutVenueId },
    });

    const introspected: IntrospectedSchema = {
      database: "test_db",
      tables: [{
        name: "events",
        type: "table",
        columns: [
          { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          { name: "name", dataType: "VARCHAR(255)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          { name: "venue_id", dataType: "BIGINT", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 8,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);

    expect(diff.tables.modified).toHaveLength(1);
    const removedCols = diff.tables.modified[0]!.columnChanges!.filter(c => c.type === "remove");
    expect(removedCols.some(c => c.columnName === "venue_id")).toBe(true);
  });

  test("should detect added views", () => {
    const schema = defineSchema({
      views: { recentEvents },
    });

    const diff = diffSchema(schema, emptyIntrospected);

    expect(diff.views.added).toContain("recent_events");
    expect(diff.hasChanges).toBe(true);
  });

  test("should detect added materialized views", () => {
    const schema = defineSchema({
      materializedViews: { eventStats },
    });

    const diff = diffSchema(schema, emptyIntrospected);

    expect(diff.materializedViews.added).toContain("event_stats");
    expect(diff.hasChanges).toBe(true);
  });

  test("should detect no changes when schema matches", () => {
    const schema = defineSchema({
      tables: {},
      views: {},
      materializedViews: {},
    });

    const diff = diffSchema(schema, emptyIntrospected);

    expect(diff.hasChanges).toBe(false);
    expect(diff.tables.added).toHaveLength(0);
    expect(diff.tables.removed).toHaveLength(0);
    expect(diff.tables.modified).toHaveLength(0);
  });

  test("should summarize diff", () => {
    const schema = defineSchema({
      tables: { events },
      views: { recentEvents },
    });

    const diff = diffSchema(schema, emptyIntrospected);
    const summary = summarizeDiff(diff);

    expect(summary).toContain("Tables to create: events");
    expect(summary).toContain("Views to create: recent_events");
  });
});

describe("Type Normalization", () => {
  // Test that BOOLEAN and TINYINT(1) are considered equivalent
  test("should treat BOOLEAN and TINYINT(1) as equivalent", () => {
    const booleanTable = starrocksTable("test_bool", {
      id: bigint("id").notNull(),
      active: {
        _type: "column",
        name: "active",
        dataType: "BOOLEAN",
        isNotNull: false
      } as any,
    }, (t) => ({
      key: primaryKey(t.id),
      distribution: hash(t.id, { buckets: 4 }),
    }));

    const schema = defineSchema({
      tables: { test_bool: booleanTable },
    });

    // StarRocks stores BOOLEAN as TINYINT(1)
    const introspected: IntrospectedSchema = {
      database: "test_db",
      tables: [{
        name: "test_bool",
        type: "table",
        columns: [
          { name: "id", dataType: "bigint(20)", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          { name: "active", dataType: "tinyint(1)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 4,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);

    // Should NOT detect any type changes - BOOLEAN and TINYINT(1) are equivalent
    const modifiedTables = diff.tables.modified;
    const typeChanges = modifiedTables.flatMap(t =>
      t.columnChanges?.filter(c => c.type === "modify" && c.changes?.some(ch => ch.startsWith("type:"))) || []
    );
    expect(typeChanges).toHaveLength(0);
  });

  // Test that INT(11) and INT are considered equivalent
  test("should treat INT(11) and INT as equivalent", () => {
    const intTable = starrocksTable("test_int", {
      id: bigint("id").notNull(),
      count: {
        _type: "column",
        name: "count",
        dataType: "INT",
        isNotNull: false
      } as any,
    }, (t) => ({
      key: primaryKey(t.id),
      distribution: hash(t.id, { buckets: 4 }),
    }));

    const schema = defineSchema({
      tables: { test_int: intTable },
    });

    // StarRocks adds display width to INT
    const introspected: IntrospectedSchema = {
      database: "test_db",
      tables: [{
        name: "test_int",
        type: "table",
        columns: [
          { name: "id", dataType: "bigint(20)", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          { name: "count", dataType: "int(11)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 4,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);

    // Should NOT detect any type changes - INT and INT(11) are equivalent
    const modifiedTables = diff.tables.modified;
    const typeChanges = modifiedTables.flatMap(t =>
      t.columnChanges?.filter(c => c.type === "modify" && c.changes?.some(ch => ch.startsWith("type:"))) || []
    );
    expect(typeChanges).toHaveLength(0);
  });

  // Test that BIGINT(20) and BIGINT are considered equivalent
  test("should treat BIGINT(20) and BIGINT as equivalent", () => {
    const bigintTable = starrocksTable("test_bigint", {
      id: bigint("id").notNull(),
      big_num: bigint("big_num"),
    }, (t) => ({
      key: primaryKey(t.id),
      distribution: hash(t.id, { buckets: 4 }),
    }));

    const schema = defineSchema({
      tables: { test_bigint: bigintTable },
    });

    // StarRocks adds display width to BIGINT
    const introspected: IntrospectedSchema = {
      database: "test_db",
      tables: [{
        name: "test_bigint",
        type: "table",
        columns: [
          { name: "id", dataType: "bigint(20)", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          { name: "big_num", dataType: "bigint(20)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 4,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);

    // Should NOT detect any type changes
    const modifiedTables = diff.tables.modified;
    const typeChanges = modifiedTables.flatMap(t =>
      t.columnChanges?.filter(c => c.type === "modify" && c.changes?.some(ch => ch.startsWith("type:"))) || []
    );
    expect(typeChanges).toHaveLength(0);
  });

  // Test that VARCHAR(255) comparison works correctly
  test("should detect VARCHAR length differences", () => {
    const varcharTable = starrocksTable("test_varchar", {
      id: bigint("id").notNull(),
      name: varchar("name", { length: 255 }),
    }, (t) => ({
      key: primaryKey(t.id),
      distribution: hash(t.id, { buckets: 4 }),
    }));

    const schema = defineSchema({
      tables: { test_varchar: varcharTable },
    });

    // Database has different VARCHAR length
    const introspected: IntrospectedSchema = {
      database: "test_db",
      tables: [{
        name: "test_varchar",
        type: "table",
        columns: [
          { name: "id", dataType: "bigint(20)", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          { name: "name", dataType: "varchar(100)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 4,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);

    // SHOULD detect type change - VARCHAR(255) vs VARCHAR(100)
    const modifiedTables = diff.tables.modified;
    const typeChanges = modifiedTables.flatMap(t =>
      t.columnChanges?.filter(c => c.type === "modify" && c.changes?.some(ch => ch.startsWith("type:"))) || []
    );
    expect(typeChanges).toHaveLength(1);
    expect(typeChanges[0]?.columnName).toBe("name");
  });

  // Test that DECIMAL precision is preserved in comparison
  test("should detect DECIMAL precision differences", () => {
    const decimalTable = starrocksTable("test_decimal", {
      id: bigint("id").notNull(),
      price: {
        _type: "column",
        name: "price",
        dataType: "DECIMAL(12,2)",
        isNotNull: false
      } as any,
    }, (t) => ({
      key: primaryKey(t.id),
      distribution: hash(t.id, { buckets: 4 }),
    }));

    const schema = defineSchema({
      tables: { test_decimal: decimalTable },
    });

    // Database has different DECIMAL precision
    const introspected: IntrospectedSchema = {
      database: "test_db",
      tables: [{
        name: "test_decimal",
        type: "table",
        columns: [
          { name: "id", dataType: "bigint(20)", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          { name: "price", dataType: "decimal(10, 4)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 4,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);

    // SHOULD detect type change - DECIMAL(12,2) vs DECIMAL(10,4)
    const modifiedTables = diff.tables.modified;
    const typeChanges = modifiedTables.flatMap(t =>
      t.columnChanges?.filter(c => c.type === "modify" && c.changes?.some(ch => ch.startsWith("type:"))) || []
    );
    expect(typeChanges).toHaveLength(1);
    expect(typeChanges[0]?.columnName).toBe("price");
  });

  // Test that matching DECIMAL precision is not flagged
  test("should not flag matching DECIMAL precision", () => {
    const decimalTable = starrocksTable("test_decimal_match", {
      id: bigint("id").notNull(),
      price: {
        _type: "column",
        name: "price",
        dataType: "DECIMAL(12,2)",
        isNotNull: false
      } as any,
    }, (t) => ({
      key: primaryKey(t.id),
      distribution: hash(t.id, { buckets: 4 }),
    }));

    const schema = defineSchema({
      tables: { test_decimal_match: decimalTable },
    });

    // Database has same DECIMAL precision (with different whitespace formatting)
    const introspected: IntrospectedSchema = {
      database: "test_db",
      tables: [{
        name: "test_decimal_match",
        type: "table",
        columns: [
          { name: "id", dataType: "bigint(20)", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          { name: "price", dataType: "decimal(12, 2)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 4,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);

    // Should NOT detect any type changes
    const modifiedTables = diff.tables.modified;
    const typeChanges = modifiedTables.flatMap(t =>
      t.columnChanges?.filter(c => c.type === "modify" && c.changes?.some(ch => ch.startsWith("type:"))) || []
    );
    expect(typeChanges).toHaveLength(0);
  });
});

describe("Migration Generation", () => {
  const emptyIntrospected: IntrospectedSchema = {
    database: "test_db",
    tables: [],
    views: [],
    materializedViews: [],
  };

  test("should generate migration for new table", () => {
    const schema = defineSchema({
      tables: { events },
    });

    const diff = diffSchema(schema, emptyIntrospected);
    const { migration } = generateMigration(schema, diff, emptyIntrospected);

    expect(migration.up).toHaveLength(1);
    expect(migration.up[0]!.type).toBe("create");
    expect(migration.up[0]!.object).toBe("table");
    expect(migration.up[0]!.sql).toContain("CREATE TABLE");
    expect(migration.up[0]!.sql).toContain("events");

    expect(migration.down).toHaveLength(1);
    expect(migration.down[0]!.sql).toContain("DROP TABLE");
  });

  test("should generate migration for new view", () => {
    const schema = defineSchema({
      views: { recentEvents },
    });

    const diff = diffSchema(schema, emptyIntrospected);
    const { migration } = generateMigration(schema, diff, emptyIntrospected);

    expect(migration.up.some(s => s.object === "view" && s.type === "create")).toBe(true);
    expect(migration.down.some(s => s.object === "view" && s.type === "drop")).toBe(true);
  });

  test("should generate migration for new MV", () => {
    const schema = defineSchema({
      materializedViews: { eventStats },
    });

    const diff = diffSchema(schema, emptyIntrospected);
    const { migration } = generateMigration(schema, diff, emptyIntrospected);

    expect(migration.up.some(s => s.object === "materialized_view" && s.type === "create")).toBe(true);
    expect(migration.up.some(s => s.sql.includes("REFRESH ASYNC"))).toBe(true);
  });

  test("should generate migration for added column", () => {
    const schema = defineSchema({
      tables: { events },
    });

    const introspected: IntrospectedSchema = {
      database: "test_db",
      tables: [{
        name: "events",
        type: "table",
        columns: [
          { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          { name: "name", dataType: "VARCHAR(255)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          { name: "created_at", dataType: "DATETIME", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          { name: "venue_id", dataType: "BIGINT", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          // price column is missing
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 8,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);
    const { migration } = generateMigration(schema, diff, introspected);

    const addColumnStmt = migration.up.find(s => s.sql.includes("ADD COLUMN") && s.sql.includes("price"));
    expect(addColumnStmt).toBeDefined();
    expect(addColumnStmt?.sql).toContain("DOUBLE");
  });

  test("should generate migration file content", () => {
    const schema = defineSchema({
      tables: { events },
    });

    const diff = diffSchema(schema, emptyIntrospected);
    const { fileContent } = generateMigration(schema, diff, emptyIntrospected, {
      name: "create_events_table",
    });

    expect(fileContent).toContain("import type { Migration } from \"@jellologic/starrocks-sdk\"");
    expect(fileContent).toContain("id: \"create_events_table\"");
    expect(fileContent).toContain("description: \"create_events_table\"");
    expect(fileContent).toContain("up: [");
    expect(fileContent).toContain("down: [");
    expect(fileContent).toContain("export default migration;");
  });

  test("should generate SQL-only migration", () => {
    const schema = defineSchema({
      tables: { events },
    });

    const diff = diffSchema(schema, emptyIntrospected);
    const { up, down } = generateMigrationSQL(schema, diff, emptyIntrospected);

    expect(up).toContain("CREATE TABLE");
    expect(up).toContain("events");
    expect(down).toContain("DROP TABLE");
  });

  test("should generate dry-run output", () => {
    const schema = defineSchema({
      tables: { events },
    });

    const diff = diffSchema(schema, emptyIntrospected);
    const output = generateDryRunOutput(schema, diff, emptyIntrospected);

    expect(output).toContain("DRY RUN");
    expect(output).toContain("CREATE TABLE");
  });

  test("should generate migration with custom name and timestamp", () => {
    const schema = defineSchema({
      tables: { events },
    });

    const diff = diffSchema(schema, emptyIntrospected);
    const { migration } = generateMigration(schema, diff, emptyIntrospected, {
      name: "001_initial_schema",
      timestamp: 1704067200000, // 2024-01-01 00:00:00 UTC
    });

    expect(migration.name).toBe("001_initial_schema");
    expect(migration.timestamp).toBe(1704067200000);
  });
});

describe("Complex Migration Scenarios", () => {
  test("should handle full schema migration", () => {
    const schema = defineSchema({
      tables: { events, venues },
      views: { recentEvents },
      materializedViews: { eventStats },
    });

    const emptyIntrospected: IntrospectedSchema = {
      database: "test_db",
      tables: [],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, emptyIntrospected);
    const { migration } = generateMigration(schema, diff, emptyIntrospected);

    // Should have creates for 2 tables, 1 view, 1 MV
    const tableCreates = migration.up.filter(s => s.object === "table" && s.type === "create");
    const viewCreates = migration.up.filter(s => s.object === "view" && s.type === "create");
    const mvCreates = migration.up.filter(s => s.object === "materialized_view" && s.type === "create");

    expect(tableCreates).toHaveLength(2);
    expect(viewCreates).toHaveLength(1);
    expect(mvCreates).toHaveLength(1);

    // Down should have corresponding drops
    const tableDrops = migration.down.filter(s => s.object === "table" && s.type === "drop");
    const viewDrops = migration.down.filter(s => s.object === "view" && s.type === "drop");
    const mvDrops = migration.down.filter(s => s.object === "materialized_view" && s.type === "drop");

    expect(tableDrops).toHaveLength(2);
    expect(viewDrops).toHaveLength(1);
    expect(mvDrops).toHaveLength(1);
  });

  test("should handle mixed add and remove operations", () => {
    // New schema has events table but not old_table
    const schema = defineSchema({
      tables: { events },
    });

    const introspected: IntrospectedSchema = {
      database: "test_db",
      tables: [{
        name: "old_table",
        type: "table",
        columns: [{ name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: null, aggregateType: null, comment: null }],
        keyType: null,
        keyColumns: [],
        distributionType: null,
        distributionColumns: [],
        buckets: null,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, introspected);

    expect(diff.tables.added).toContain("events");
    expect(diff.tables.removed).toContain("old_table");

    const { migration } = generateMigration(schema, diff, introspected);

    expect(migration.up.some(s => s.sql.includes("CREATE TABLE") && s.objectName === "events")).toBe(true);
    expect(migration.up.some(s => s.sql.includes("DROP TABLE") && s.objectName === "old_table")).toBe(true);
  });
});

// ============================================================================
// Differ Edge Cases
// ============================================================================

describe("Differ Edge Cases", () => {
  describe("Empty Schema Handling", () => {
    const emptyIntrospected: IntrospectedSchema = {
      database: "test_db",
      tables: [],
      views: [],
      materializedViews: [],
    };

    test("should handle empty defined schema vs empty database", () => {
      const schema = defineSchema({});
      const diff = diffSchema(schema, emptyIntrospected);

      expect(diff.hasChanges).toBe(false);
      expect(diff.tables.added).toHaveLength(0);
      expect(diff.tables.removed).toHaveLength(0);
      expect(diff.views.added).toHaveLength(0);
      expect(diff.materializedViews.added).toHaveLength(0);
    });

    test("should handle schema with only views", () => {
      const schema = defineSchema({
        tables: {},
        views: { recentEvents },
        materializedViews: {},
      });

      const diff = diffSchema(schema, emptyIntrospected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables.added).toHaveLength(0);
      expect(diff.views.added).toContain("recent_events");
      expect(diff.materializedViews.added).toHaveLength(0);
    });

    test("should handle schema with only MVs", () => {
      const schema = defineSchema({
        tables: {},
        views: {},
        materializedViews: { eventStats },
      });

      const diff = diffSchema(schema, emptyIntrospected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables.added).toHaveLength(0);
      expect(diff.views.added).toHaveLength(0);
      expect(diff.materializedViews.added).toContain("event_stats");
    });
  });

  describe("Column Default Value Edge Cases", () => {
    test("should detect default value change from null to value", () => {
      // Use DUPLICATE KEY — the differ intentionally skips default comparison
      // for PRIMARY KEY tables since StarRocks ignores DEFAULT on non-key columns.
      const tableWithDefault = starrocksTable("test_defaults", {
        id: bigint("id").notNull(),
        status: varchar("status", { length: 50 }).default("active"),
      }, (t) => ({
        key: duplicateKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const schema = defineSchema({
        tables: { test_defaults: tableWithDefault },
      });

      const introspected: IntrospectedSchema = {
        database: "test_db",
        tables: [{
          name: "test_defaults",
          type: "table",
          columns: [
            { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "DUP", aggregateType: null, comment: null },
            { name: "status", dataType: "VARCHAR(50)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          ],
          keyType: "DUPLICATE",
          keyColumns: ["id"],
          distributionType: "HASH",
          distributionColumns: ["id"],
          buckets: 4,
          partitionType: null,
          partitionColumn: null,
          properties: {},
          comment: null,
        }],
        views: [],
        materializedViews: [],
      };

      const diff = diffSchema(schema, introspected);

      const defaultChanges = diff.tables.modified.flatMap(t =>
        t.columnChanges?.filter(c => c.type === "modify" && c.changes?.some(ch => ch.startsWith("default:"))) || []
      );
      expect(defaultChanges).toHaveLength(1);
    });

    test("should detect nullability change", () => {
      const tableWithNotNull = starrocksTable("test_nullability", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 100 }).notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const schema = defineSchema({
        tables: { test_nullability: tableWithNotNull },
      });

      const introspected: IntrospectedSchema = {
        database: "test_db",
        tables: [{
          name: "test_nullability",
          type: "table",
          columns: [
            { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
            { name: "name", dataType: "VARCHAR(100)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          ],
          keyType: "PRIMARY",
          keyColumns: ["id"],
          distributionType: "HASH",
          distributionColumns: ["id"],
          buckets: 4,
          partitionType: null,
          partitionColumn: null,
          properties: {},
          comment: null,
        }],
        views: [],
        materializedViews: [],
      };

      const diff = diffSchema(schema, introspected);

      const nullableChanges = diff.tables.modified.flatMap(t =>
        t.columnChanges?.filter(c => c.type === "modify" && c.changes?.some(ch => ch.startsWith("nullable:"))) || []
      );
      expect(nullableChanges).toHaveLength(1);
    });
  });

  describe("Key Type Change Detection", () => {
    test("should detect key type change from PRIMARY to DUPLICATE", () => {
      const duplicateTable = starrocksTable("test_key_change", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 100 }),
      }, (t) => ({
        key: duplicateKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const schema = defineSchema({
        tables: { test_key_change: duplicateTable },
      });

      const introspected: IntrospectedSchema = {
        database: "test_db",
        tables: [{
          name: "test_key_change",
          type: "table",
          columns: [
            { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
            { name: "name", dataType: "VARCHAR(100)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          ],
          keyType: "PRIMARY",
          keyColumns: ["id"],
          distributionType: "HASH",
          distributionColumns: ["id"],
          buckets: 4,
          partitionType: null,
          partitionColumn: null,
          properties: {},
          comment: null,
        }],
        views: [],
        materializedViews: [],
      };

      const diff = diffSchema(schema, introspected);

      const keyChanges = diff.tables.modified.filter(t => t.keyChange !== undefined);
      expect(keyChanges).toHaveLength(1);
      expect(keyChanges[0]?.keyChange?.old).toBe("PRIMARY");
      expect(keyChanges[0]?.keyChange?.new).toBe("DUPLICATE");
    });
  });

  describe("Distribution Change Detection", () => {
    test("should detect distribution bucket change", () => {
      const table8Buckets = starrocksTable("test_dist_change", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 8 }),
      }));

      const schema = defineSchema({
        tables: { test_dist_change: table8Buckets },
      });

      const introspected: IntrospectedSchema = {
        database: "test_db",
        tables: [{
          name: "test_dist_change",
          type: "table",
          columns: [
            { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          ],
          keyType: "PRIMARY",
          keyColumns: ["id"],
          distributionType: "HASH",
          distributionColumns: ["id"],
          buckets: 4, // Different bucket count
          partitionType: null,
          partitionColumn: null,
          properties: {},
          comment: null,
        }],
        views: [],
        materializedViews: [],
      };

      const diff = diffSchema(schema, introspected);

      const distChanges = diff.tables.modified.filter(t => t.distributionChange === true);
      expect(distChanges).toHaveLength(1);
    });

    test("should detect distribution column change", () => {
      const tableDistById = starrocksTable("test_dist_col", {
        id: bigint("id").notNull(),
        tenantId: bigint("tenant_id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.tenantId, { buckets: 4 }),
      }));

      const schema = defineSchema({
        tables: { test_dist_col: tableDistById },
      });

      const introspected: IntrospectedSchema = {
        database: "test_db",
        tables: [{
          name: "test_dist_col",
          type: "table",
          columns: [
            { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
            { name: "tenant_id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          ],
          keyType: "PRIMARY",
          keyColumns: ["id"],
          distributionType: "HASH",
          distributionColumns: ["id"], // Different distribution column
          buckets: 4,
          partitionType: null,
          partitionColumn: null,
          properties: {},
          comment: null,
        }],
        views: [],
        materializedViews: [],
      };

      const diff = diffSchema(schema, introspected);

      const distChanges = diff.tables.modified.filter(t => t.distributionChange === true);
      expect(distChanges).toHaveLength(1);
    });
  });

  describe("DATETIME Precision Normalization", () => {
    test("should treat DATETIME and DATETIME(0) as equivalent", () => {
      const datetimeTable = starrocksTable("test_datetime", {
        id: bigint("id").notNull(),
        createdAt: datetime("created_at"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const schema = defineSchema({
        tables: { test_datetime: datetimeTable },
      });

      const introspected: IntrospectedSchema = {
        database: "test_db",
        tables: [{
          name: "test_datetime",
          type: "table",
          columns: [
            { name: "id", dataType: "bigint(20)", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
            { name: "created_at", dataType: "datetime(0)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          ],
          keyType: "PRIMARY",
          keyColumns: ["id"],
          distributionType: "HASH",
          distributionColumns: ["id"],
          buckets: 4,
          partitionType: null,
          partitionColumn: null,
          properties: {},
          comment: null,
        }],
        views: [],
        materializedViews: [],
      };

      const diff = diffSchema(schema, introspected);

      // Should NOT detect any type changes
      const typeChanges = diff.tables.modified.flatMap(t =>
        t.columnChanges?.filter(c => c.type === "modify" && c.changes?.some(ch => ch.startsWith("type:"))) || []
      );
      expect(typeChanges).toHaveLength(0);
    });
  });

  describe("View Modification Detection", () => {
    test("should detect view column structure change", () => {
      // View with 3 columns
      const expandedView = createView("test_view")
        .columns({
          id: bigint("id"),
          name: varchar("name", { length: 255 }),
          price: double("price"),
        })
        .as((qb) =>
          qb.select({
            id: events.id,
            name: events.name,
            price: events.price,
          }).from(events)
        );

      const schema = defineSchema({
        views: { test_view: expandedView },
      });

      // Existing view has only 2 columns
      const introspected: IntrospectedSchema = {
        database: "test_db",
        tables: [],
        views: [{
          name: "test_view",
          type: "view",
          columns: [
            { name: "id", dataType: "BIGINT", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
            { name: "name", dataType: "VARCHAR(255)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          ],
          definition: "SELECT id, name FROM events",
          security: null,
          comment: null,
        }],
        materializedViews: [],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.views.modified).toHaveLength(1);
      expect(diff.views.modified[0]?.type).toBe("recreate");
      expect(diff.views.modified[0]?.reason).toBe("Column structure changed");
    });
  });

  describe("Materialized View Modification Detection", () => {
    test("should detect MV refresh type change", () => {
      // MV with MANUAL refresh
      const manualMV = createMaterializedView("test_mv")
        .columns({
          venueId: bigint("venue_id"),
          eventCount: bigint("event_count"),
        })
        .distributed({ type: "HASH", columns: ["venue_id"], buckets: 4 })
        .refresh({ type: "MANUAL" })
        .as((qb) =>
          qb.select({
            venueId: events.venueId,
            eventCount: count(events.id),
          })
          .from(events)
          .groupBy(events.venueId)
        );

      const schema = defineSchema({
        materializedViews: { test_mv: manualMV },
      });

      // Existing MV has ASYNC refresh
      const introspected: IntrospectedSchema = {
        database: "test_db",
        tables: [],
        views: [],
        materializedViews: [{
          name: "test_mv",
          type: "materialized_view",
          columns: [
            { name: "venue_id", dataType: "BIGINT", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
            { name: "event_count", dataType: "BIGINT", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          ],
          definition: "SELECT venue_id, COUNT(*) FROM events GROUP BY venue_id",
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

      expect(diff.materializedViews.modified).toHaveLength(1);
      expect(diff.materializedViews.modified[0]?.type).toBe("alter_refresh");
      expect(diff.materializedViews.modified[0]?.refreshChange?.old).toBe("ASYNC");
      expect(diff.materializedViews.modified[0]?.refreshChange?.new).toBe("MANUAL");
    });

    test("should detect MV distribution change requiring recreate", () => {
      // MV with RANDOM distribution
      const randomDistMV = createMaterializedView("test_mv_dist")
        .columns({
          venueId: bigint("venue_id"),
          total: double("total"),
        })
        .distributed({ type: "RANDOM", buckets: 8 })
        .refresh({ type: "MANUAL" })
        .as((qb) =>
          qb.select({
            venueId: events.venueId,
            total: sum(events.price),
          })
          .from(events)
          .groupBy(events.venueId)
        );

      const schema = defineSchema({
        materializedViews: { test_mv_dist: randomDistMV },
      });

      // Existing MV has HASH distribution
      const introspected: IntrospectedSchema = {
        database: "test_db",
        tables: [],
        views: [],
        materializedViews: [{
          name: "test_mv_dist",
          type: "materialized_view",
          columns: [
            { name: "venue_id", dataType: "BIGINT", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
            { name: "total", dataType: "DOUBLE", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          ],
          definition: "SELECT venue_id, SUM(price) FROM events GROUP BY venue_id",
          distributionType: "HASH",
          distributionColumns: ["venue_id"],
          buckets: 4,
          partitionType: null,
          partitionExpression: null,
          refreshType: "MANUAL",
          refreshInterval: null,
          isActive: true,
          properties: {},
          comment: null,
        }],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.materializedViews.modified).toHaveLength(1);
      expect(diff.materializedViews.modified[0]?.type).toBe("recreate");
      expect(diff.materializedViews.modified[0]?.reason).toBe("Distribution changed");
    });
  });

  describe("Case Sensitivity", () => {
    test("should match tables case-sensitively", () => {
      const upperTable = starrocksTable("EVENTS", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const schema = defineSchema({
        tables: { EVENTS: upperTable },
      });

      // Database has lowercase table
      const introspected: IntrospectedSchema = {
        database: "test_db",
        tables: [{
          name: "events", // lowercase
          type: "table",
          columns: [
            { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          ],
          keyType: "PRIMARY",
          keyColumns: ["id"],
          distributionType: "HASH",
          distributionColumns: ["id"],
          buckets: 4,
          partitionType: null,
          partitionColumn: null,
          properties: {},
          comment: null,
        }],
        views: [],
        materializedViews: [],
      };

      const diff = diffSchema(schema, introspected);

      // Should treat as different tables (case-sensitive)
      expect(diff.tables.added).toContain("EVENTS");
      expect(diff.tables.removed).toContain("events");
    });
  });

  describe("Multiple Column Changes", () => {
    test("should detect multiple column changes in single table", () => {
      const modifiedTable = starrocksTable("multi_changes", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 500 }), // Changed from 255
        status: varchar("status", { length: 50 }).notNull(), // Changed nullability
        newCol: bigint("new_col"), // New column
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const schema = defineSchema({
        tables: { multi_changes: modifiedTable },
      });

      const introspected: IntrospectedSchema = {
        database: "test_db",
        tables: [{
          name: "multi_changes",
          type: "table",
          columns: [
            { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
            { name: "name", dataType: "VARCHAR(255)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
            { name: "status", dataType: "VARCHAR(50)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
            { name: "old_col", dataType: "BIGINT", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
          ],
          keyType: "PRIMARY",
          keyColumns: ["id"],
          distributionType: "HASH",
          distributionColumns: ["id"],
          buckets: 4,
          partitionType: null,
          partitionColumn: null,
          properties: {},
          comment: null,
        }],
        views: [],
        materializedViews: [],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.tables.modified).toHaveLength(1);
      const changes = diff.tables.modified[0]?.columnChanges || [];

      // Added column
      const added = changes.filter(c => c.type === "add");
      expect(added).toHaveLength(1);
      expect(added[0]?.columnName).toBe("new_col");

      // Removed column
      const removed = changes.filter(c => c.type === "remove");
      expect(removed).toHaveLength(1);
      expect(removed[0]?.columnName).toBe("old_col");

      // Modified columns (name type change, status nullability change)
      const modified = changes.filter(c => c.type === "modify");
      expect(modified.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Summary Generation Edge Cases", () => {
    test("should generate summary for no changes", () => {
      const diff = {
        tables: { added: [], removed: [], modified: [] },
        views: { added: [], removed: [], modified: [] },
        materializedViews: { added: [], removed: [], modified: [] },
        hasChanges: false,
      };

      const summary = summarizeDiff(diff);
      expect(summary).toBe("No changes detected");
    });

    test("should generate summary with all change types", () => {
      const diff = {
        tables: {
          added: ["new_table"],
          removed: ["old_table"],
          modified: [{
            name: "modified_table",
            type: "alter" as const,
            columnChanges: [
              { type: "add" as const, columnName: "new_col" },
              { type: "remove" as const, columnName: "old_col" },
              { type: "modify" as const, columnName: "changed_col", changes: ["type: INT -> BIGINT"] },
            ],
          }],
        },
        views: {
          added: ["new_view"],
          removed: ["old_view"],
          modified: [{ name: "changed_view", type: "recreate" as const, reason: "Column structure changed" }],
        },
        materializedViews: {
          added: ["new_mv"],
          removed: ["old_mv"],
          modified: [{ name: "changed_mv", type: "alter_refresh" as const, refreshChange: { old: "ASYNC", new: "MANUAL" } }],
        },
        hasChanges: true,
      };

      const summary = summarizeDiff(diff);

      expect(summary).toContain("Tables to create: new_table");
      expect(summary).toContain("Tables to drop: old_table");
      expect(summary).toContain("Table 'modified_table'");
      expect(summary).toContain("add columns: new_col");
      expect(summary).toContain("remove columns: old_col");
      expect(summary).toContain("modify columns: changed_col");
      expect(summary).toContain("Views to create: new_view");
      expect(summary).toContain("Views to drop: old_view");
      expect(summary).toContain("View 'changed_view': recreate");
      expect(summary).toContain("Materialized views to create: new_mv");
      expect(summary).toContain("Materialized views to drop: old_mv");
      expect(summary).toContain("MV 'changed_mv': refresh ASYNC -> MANUAL");
    });
  });
});
