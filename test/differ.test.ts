import { describe, test, expect } from "bun:test";
import {
  // Column types
  bigint,
  varchar,
  datetime,
  double,
  int,
  boolean,
  smallint,
  tinyint,
  decimal,
  json,

  // Table
  starrocksTable,
  primaryKey,
  duplicateKey,
  aggregateKey,
  uniqueKey,
  hash,
  random,

  // Indexes
  bitmapIndex,
  ginIndex,
  vectorIndex,

  // Views
  createView,
  createMaterializedView,

  // Schema
  defineSchema,
  diffSchema,
  summarizeDiff,

  // Expressions
  gt,
  sql,

  // Aggregates
  count,
  sum,

  // Types
  type IntrospectedSchema,
  type IntrospectedTable,
  type IntrospectedView,
  type IntrospectedMaterializedView,
  type IntrospectedColumn,
  type IntrospectedIndex,
} from "../src/schema/index";

// ============================================================================
// Helpers
// ============================================================================

function makeColumn(overrides: Partial<IntrospectedColumn> & { name: string }): IntrospectedColumn {
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

function makeTable(
  name: string,
  columns: IntrospectedColumn[],
  overrides: Partial<IntrospectedTable> = {}
): IntrospectedTable {
  return {
    name,
    type: "table",
    columns,
    keyType: "PRIMARY",
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
  };
}

function makeView(
  name: string,
  columns: IntrospectedColumn[],
  overrides: Partial<IntrospectedView> = {}
): IntrospectedView {
  return {
    name,
    type: "view",
    columns,
    definition: "SELECT 1",
    security: null,
    comment: null,
    ...overrides,
  };
}

function makeMV(
  name: string,
  columns: IntrospectedColumn[],
  overrides: Partial<IntrospectedMaterializedView> = {}
): IntrospectedMaterializedView {
  return {
    name,
    type: "materialized_view",
    columns,
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
    ...overrides,
  };
}

function emptyIntrospected(): IntrospectedSchema {
  return { database: "test", tables: [], views: [], materializedViews: [] };
}

// ============================================================================
// Table Diffing
// ============================================================================

describe("Differ", () => {
  describe("Table Detection", () => {
    test("should detect added tables", () => {
      const t = starrocksTable("users", {
        id: bigint("id").notNull(),
      }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { users: t } });
      const diff = diffSchema(schema, emptyIntrospected());

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables.added).toEqual(["users"]);
      expect(diff.tables.removed).toHaveLength(0);
      expect(diff.tables.modified).toHaveLength(0);
    });

    test("should detect removed tables", () => {
      const schema = defineSchema({});
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("old_table", [makeColumn({ name: "id" })])],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables.removed).toEqual(["old_table"]);
    });

    test("should detect no changes when schemas match", () => {
      const t = starrocksTable("users", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
      }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { users: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("users", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "PRI" }),
          makeColumn({ name: "name", dataType: "VARCHAR(255)", isNullable: true }),
        ])],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(false);
      expect(diff.tables.added).toHaveLength(0);
      expect(diff.tables.removed).toHaveLength(0);
      expect(diff.tables.modified).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Column Changes
  // ==========================================================================

  describe("Column Changes", () => {
    test("should detect added column", () => {
      const t = starrocksTable("users", {
        id: bigint("id").notNull(),
        email: varchar("email", { length: 255 }),
      }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { users: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("users", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "PRI" }),
        ])],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      const mod = diff.tables.modified[0]!;
      expect(mod.name).toBe("users");
      const added = mod.columnChanges!.filter(c => c.type === "add");
      expect(added).toHaveLength(1);
      expect(added[0]!.columnName).toBe("email");
    });

    test("should detect removed column", () => {
      const t = starrocksTable("users", {
        id: bigint("id").notNull(),
      }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { users: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("users", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "PRI" }),
          makeColumn({ name: "old_col", dataType: "VARCHAR(100)" }),
        ])],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      const removed = diff.tables.modified[0]!.columnChanges!.filter(c => c.type === "remove");
      expect(removed).toHaveLength(1);
      expect(removed[0]!.columnName).toBe("old_col");
    });

    test("should detect nullability change", () => {
      const t = starrocksTable("users", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 100 }).notNull(),
      }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { users: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("users", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "name", dataType: "VARCHAR(100)", isNullable: true }),
        ], { keyType: "DUPLICATE" })],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      const modified = diff.tables.modified[0]!.columnChanges!.filter(c => c.type === "modify");
      expect(modified).toHaveLength(1);
      expect(modified[0]!.changes).toContainEqual(expect.stringContaining("nullable:"));
    });

    test("should detect type change", () => {
      const t = starrocksTable("users", {
        id: bigint("id").notNull(),
        age: int("age"),
      }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { users: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("users", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "age", dataType: "SMALLINT" }),
        ], { keyType: "DUPLICATE" })],
      };

      const diff = diffSchema(schema, introspected);

      const modified = diff.tables.modified[0]!.columnChanges!.filter(c => c.type === "modify");
      expect(modified).toHaveLength(1);
      expect(modified[0]!.changes).toContainEqual(expect.stringContaining("type:"));
    });

    test("should detect default value change on non-PRIMARY KEY tables", () => {
      const t = starrocksTable("logs", {
        id: bigint("id").notNull(),
        status: varchar("status", { length: 50 }).default("active"),
      }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { logs: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("logs", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "status", dataType: "VARCHAR(50)", defaultValue: null }),
        ], { keyType: "DUPLICATE" })],
      };

      const diff = diffSchema(schema, introspected);

      const modified = diff.tables.modified[0]!.columnChanges!.filter(c => c.type === "modify");
      expect(modified).toHaveLength(1);
      expect(modified[0]!.changes).toContainEqual(expect.stringContaining("default:"));
    });

    test("should skip default comparison for PRIMARY KEY tables", () => {
      const t = starrocksTable("users", {
        id: bigint("id").notNull(),
        status: varchar("status", { length: 50 }).default("active"),
      }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { users: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("users", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "PRI" }),
          makeColumn({ name: "status", dataType: "VARCHAR(50)", defaultValue: null }),
        ], { keyType: "PRIMARY" })],
      };

      const diff = diffSchema(schema, introspected);

      // Should NOT detect default change for PRIMARY KEY tables
      const defaultChanges = diff.tables.modified.flatMap(t =>
        t.columnChanges?.filter(c => c.type === "modify" && c.changes?.some(ch => ch.startsWith("default:"))) || []
      );
      expect(defaultChanges).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Type Normalization
  // ==========================================================================

  describe("Type Normalization", () => {
    test("should treat BOOLEAN and TINYINT(1) as equivalent", () => {
      const t = starrocksTable("flags", {
        id: bigint("id").notNull(),
        active: boolean("active"),
      }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { flags: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("flags", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "active", dataType: "TINYINT(1)" }),
        ], { keyType: "DUPLICATE" })],
      };

      const diff = diffSchema(schema, introspected);

      // BOOLEAN and TINYINT(1) should be treated the same
      const typeChanges = diff.tables.modified.flatMap(t =>
        t.columnChanges?.filter(c => c.changes?.some(ch => ch.startsWith("type:"))) || []
      );
      expect(typeChanges).toHaveLength(0);
    });

    test("should ignore integer display widths (INT(11) = INT)", () => {
      const t = starrocksTable("nums", {
        id: bigint("id").notNull(),
        count: int("count"),
      }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { nums: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("nums", [
          makeColumn({ name: "id", dataType: "BIGINT(20)", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "count", dataType: "INT(11)" }),
        ], { keyType: "DUPLICATE" })],
      };

      const diff = diffSchema(schema, introspected);

      const typeChanges = diff.tables.modified.flatMap(t =>
        t.columnChanges?.filter(c => c.changes?.some(ch => ch.startsWith("type:"))) || []
      );
      expect(typeChanges).toHaveLength(0);
    });

    test("should ignore SMALLINT and TINYINT display widths", () => {
      const t = starrocksTable("nums", {
        id: bigint("id").notNull(),
        small: smallint("small"),
        tiny: tinyint("tiny"),
      }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { nums: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("nums", [
          makeColumn({ name: "id", dataType: "BIGINT(20)", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "small", dataType: "SMALLINT(6)" }),
          makeColumn({ name: "tiny", dataType: "TINYINT(4)" }),
        ], { keyType: "DUPLICATE" })],
      };

      const diff = diffSchema(schema, introspected);

      const typeChanges = diff.tables.modified.flatMap(t =>
        t.columnChanges?.filter(c => c.changes?.some(ch => ch.startsWith("type:"))) || []
      );
      expect(typeChanges).toHaveLength(0);
    });

    test("should normalize DATETIME(0) to DATETIME", () => {
      const t = starrocksTable("events", {
        id: bigint("id").notNull(),
        ts: datetime("ts"),
      }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { events: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("events", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "ts", dataType: "DATETIME(0)" }),
        ], { keyType: "DUPLICATE" })],
      };

      const diff = diffSchema(schema, introspected);

      const typeChanges = diff.tables.modified.flatMap(t =>
        t.columnChanges?.filter(c => c.changes?.some(ch => ch.startsWith("type:"))) || []
      );
      expect(typeChanges).toHaveLength(0);
    });

    test("should normalize DECIMAL spacing", () => {
      const t = starrocksTable("prices", {
        id: bigint("id").notNull(),
        amount: decimal("amount", { precision: 12, scale: 2 }),
      }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { prices: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("prices", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "amount", dataType: "DECIMAL(12, 2)" }),
        ], { keyType: "DUPLICATE" })],
      };

      const diff = diffSchema(schema, introspected);

      const typeChanges = diff.tables.modified.flatMap(t =>
        t.columnChanges?.filter(c => c.changes?.some(ch => ch.startsWith("type:"))) || []
      );
      expect(typeChanges).toHaveLength(0);
    });

    test("should detect actual type change (INT to BIGINT)", () => {
      const t = starrocksTable("data", {
        id: bigint("id").notNull(),
        val: bigint("val"),
      }, (t) => ({ key: duplicateKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { data: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("data", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "val", dataType: "INT" }),
        ], { keyType: "DUPLICATE" })],
      };

      const diff = diffSchema(schema, introspected);

      const typeChanges = diff.tables.modified.flatMap(t =>
        t.columnChanges?.filter(c => c.changes?.some(ch => ch.startsWith("type:"))) || []
      );
      expect(typeChanges).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Key Type Changes
  // ==========================================================================

  describe("Key Type Changes", () => {
    test("should detect key type change", () => {
      const t = starrocksTable("data", {
        id: bigint("id").notNull(),
      }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { data: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("data", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
        ], { keyType: "DUPLICATE" })],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      const mod = diff.tables.modified[0]!;
      expect(mod.keyChange).toBeDefined();
      expect(mod.keyChange!.old).toBe("DUPLICATE");
      expect(mod.keyChange!.new).toBe("PRIMARY");
    });
  });

  // ==========================================================================
  // Distribution Changes
  // ==========================================================================

  describe("Distribution Changes", () => {
    test("should detect distribution type change", () => {
      const t = starrocksTable("data", {
        id: bigint("id").notNull(),
      }, (t) => ({ key: duplicateKey(t.id), distribution: random({ buckets: 4 }) }));

      const schema = defineSchema({ tables: { data: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("data", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
        ], { keyType: "DUPLICATE", distributionType: "HASH", distributionColumns: ["id"] })],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables.modified[0]!.distributionChange).toBe(true);
    });

    test("should detect distribution column change", () => {
      const t = starrocksTable("data", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 100 }),
      }, (t) => ({ key: duplicateKey(t.id), distribution: hash((t as any).name, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { data: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("data", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "name", dataType: "VARCHAR(100)" }),
        ], { keyType: "DUPLICATE", distributionType: "HASH", distributionColumns: ["id"] })],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables.modified[0]!.distributionChange).toBe(true);
    });
  });

  // ==========================================================================
  // Property Changes
  // ==========================================================================

  describe("Property Changes", () => {
    test("should detect property change", () => {
      const t = starrocksTable("data", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: duplicateKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: 3 },
      }));

      const schema = defineSchema({ tables: { data: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("data", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
        ], { keyType: "DUPLICATE", properties: { replication_num: "1" } })],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables.modified[0]!.propertyChanges).toBeDefined();
      expect(diff.tables.modified[0]!.propertyChanges!.length).toBeGreaterThan(0);
    });

    test("should not flag matching properties", () => {
      const t = starrocksTable("data", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: duplicateKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: 1 },
      }));

      const schema = defineSchema({ tables: { data: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("data", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
        ], { keyType: "DUPLICATE", properties: { replication_num: "1" } })],
      };

      const diff = diffSchema(schema, introspected);

      // Properties match, but no changes expected from property comparison
      const propChanges = diff.tables.modified.flatMap(t => t.propertyChanges ?? []);
      expect(propChanges).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Index Changes
  // ==========================================================================

  describe("Index Changes", () => {
    test("should detect added BITMAP index", () => {
      const t = starrocksTable("data", {
        id: bigint("id").notNull(),
        status: varchar("status", { length: 50 }),
      }, (t) => ({
        key: duplicateKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        indexes: [bitmapIndex("idx_status", t.status)],
      }));

      const schema = defineSchema({ tables: { data: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("data", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "status", dataType: "VARCHAR(50)" }),
        ], { keyType: "DUPLICATE", indexes: [] })],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      const indexChanges = diff.tables.modified[0]!.indexChanges!;
      const added = indexChanges.filter(i => i.type === "add");
      expect(added).toHaveLength(1);
      expect(added[0]!.indexName).toBe("idx_status");
      expect(added[0]!.indexType).toBe("BITMAP");
    });

    test("should detect removed index", () => {
      const t = starrocksTable("data", {
        id: bigint("id").notNull(),
        status: varchar("status", { length: 50 }),
      }, (t) => ({
        key: duplicateKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const schema = defineSchema({ tables: { data: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("data", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "status", dataType: "VARCHAR(50)" }),
        ], {
          keyType: "DUPLICATE",
          indexes: [{ name: "idx_status", type: "BITMAP", columns: ["status"], properties: {}, comment: null }],
        })],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      const removed = diff.tables.modified[0]!.indexChanges!.filter(i => i.type === "remove");
      expect(removed).toHaveLength(1);
      expect(removed[0]!.indexName).toBe("idx_status");
    });

    test("should detect modified index (type change)", () => {
      const t = starrocksTable("data", {
        id: bigint("id").notNull(),
        tags: varchar("tags", { length: 255 }),
      }, (t) => ({
        key: duplicateKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        indexes: [ginIndex("idx_tags", [t.tags])],
      }));

      const schema = defineSchema({ tables: { data: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("data", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "DUP" }),
          makeColumn({ name: "tags", dataType: "VARCHAR(255)" }),
        ], {
          keyType: "DUPLICATE",
          indexes: [{ name: "idx_tags", type: "BITMAP", columns: ["tags"], properties: {}, comment: null }],
        })],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      const modified = diff.tables.modified[0]!.indexChanges!.filter(i => i.type === "modify");
      expect(modified).toHaveLength(1);
      expect(modified[0]!.changes).toContainEqual(expect.stringContaining("type:"));
    });
  });

  // ==========================================================================
  // View Changes
  // ==========================================================================

  describe("View Changes", () => {
    const events = starrocksTable("events", {
      id: bigint("id").notNull(),
      title: varchar("title", { length: 255 }),
      createdAt: datetime("created_at"),
    }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

    test("should detect added view", () => {
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
      const diff = diffSchema(schema, emptyIntrospected());

      expect(diff.hasChanges).toBe(true);
      expect(diff.views.added).toEqual(["recent_events"]);
    });

    test("should detect removed view", () => {
      const schema = defineSchema({});
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        views: [makeView("old_view", [makeColumn({ name: "id" })])],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.views.removed).toEqual(["old_view"]);
    });

    test("should detect modified view (column change)", () => {
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
        ...emptyIntrospected(),
        views: [makeView("my_view", [
          makeColumn({ name: "id" }),
          makeColumn({ name: "title", dataType: "VARCHAR(255)" }),
        ])],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.views.modified).toHaveLength(1);
      expect(diff.views.modified[0]!.type).toBe("recreate");
      expect(diff.views.modified[0]!.reason).toContain("Column");
    });

    test("should not flag unchanged view", () => {
      const v = createView("my_view")
        .columns({
          id: bigint("id"),
          title: varchar("title", { length: 255 }),
        })
        .as((qb) =>
          qb.select({ id: events.id, title: events.title })
            .from(events)
        );

      const schema = defineSchema({ views: { my_view: v } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        views: [makeView("my_view", [
          makeColumn({ name: "id" }),
          makeColumn({ name: "title", dataType: "VARCHAR(255)" }),
        ])],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.views.modified).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Materialized View Changes
  // ==========================================================================

  describe("Materialized View Changes", () => {
    const events = starrocksTable("events", {
      id: bigint("id").notNull(),
      venueId: bigint("venue_id"),
      price: double("price"),
    }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

    test("should detect added MV", () => {
      const mv = createMaterializedView("stats")
        .columns({ venueId: bigint("venue_id"), total: double("total") })
        .distributed({ type: "HASH", columns: ["venue_id"], buckets: 4 })
        .refresh({ type: "ASYNC", every: { value: 1, unit: "HOUR" } })
        .as((qb) =>
          qb.select({ venueId: events.venueId, total: sum(events.price) })
            .from(events)
            .groupBy(events.venueId)
        );

      const schema = defineSchema({ materializedViews: { stats: mv } });
      const diff = diffSchema(schema, emptyIntrospected());

      expect(diff.hasChanges).toBe(true);
      expect(diff.materializedViews.added).toEqual(["stats"]);
    });

    test("should detect removed MV", () => {
      const schema = defineSchema({});
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        materializedViews: [makeMV("old_mv", [makeColumn({ name: "id" })])],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.materializedViews.removed).toEqual(["old_mv"]);
    });

    test("should detect MV refresh type change", () => {
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
        ...emptyIntrospected(),
        materializedViews: [makeMV("stats", [
          makeColumn({ name: "venue_id" }),
          makeColumn({ name: "total", dataType: "DOUBLE" }),
        ], { refreshType: "ASYNC", distributionColumns: ["venue_id"] })],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.materializedViews.modified).toHaveLength(1);
      expect(diff.materializedViews.modified[0]!.type).toBe("alter_refresh");
      expect(diff.materializedViews.modified[0]!.refreshChange!.old).toBe("ASYNC");
      expect(diff.materializedViews.modified[0]!.refreshChange!.new).toBe("MANUAL");
    });

    test("should detect MV column structure change (requires recreate)", () => {
      const mv = createMaterializedView("stats")
        .columns({
          venueId: bigint("venue_id"),
          total: double("total"),
          cnt: bigint("cnt"),
        })
        .distributed({ type: "HASH", columns: ["venue_id"], buckets: 4 })
        .refresh({ type: "ASYNC", every: { value: 1, unit: "HOUR" } })
        .as((qb) =>
          qb.select({
            venueId: events.venueId,
            total: sum(events.price),
            cnt: count(events.id),
          })
            .from(events)
            .groupBy(events.venueId)
        );

      const schema = defineSchema({ materializedViews: { stats: mv } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        materializedViews: [makeMV("stats", [
          makeColumn({ name: "venue_id" }),
          makeColumn({ name: "total", dataType: "DOUBLE" }),
        ], { refreshType: "ASYNC", distributionColumns: ["venue_id"] })],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.materializedViews.modified).toHaveLength(1);
      expect(diff.materializedViews.modified[0]!.type).toBe("recreate");
    });

    test("should detect MV distribution change (requires recreate)", () => {
      const mv = createMaterializedView("stats")
        .columns({ venueId: bigint("venue_id"), total: double("total") })
        .distributed({ type: "RANDOM", buckets: 8 })
        .refresh({ type: "ASYNC", every: { value: 1, unit: "HOUR" } })
        .as((qb) =>
          qb.select({ venueId: events.venueId, total: sum(events.price) })
            .from(events)
            .groupBy(events.venueId)
        );

      const schema = defineSchema({ materializedViews: { stats: mv } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        materializedViews: [makeMV("stats", [
          makeColumn({ name: "venue_id" }),
          makeColumn({ name: "total", dataType: "DOUBLE" }),
        ], { refreshType: "ASYNC", distributionType: "HASH", distributionColumns: ["venue_id"] })],
      };

      const diff = diffSchema(schema, introspected);

      expect(diff.hasChanges).toBe(true);
      expect(diff.materializedViews.modified).toHaveLength(1);
      expect(diff.materializedViews.modified[0]!.type).toBe("recreate");
      expect(diff.materializedViews.modified[0]!.reason).toContain("Distribution");
    });
  });

  // ==========================================================================
  // summarizeDiff
  // ==========================================================================

  describe("summarizeDiff", () => {
    test("should return 'No changes' for empty diff", () => {
      const t = starrocksTable("data", {
        id: bigint("id").notNull(),
      }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { data: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("data", [
          makeColumn({ name: "id", dataType: "BIGINT", isNullable: false, columnKey: "PRI" }),
        ])],
      };

      const diff = diffSchema(schema, introspected);
      const summary = summarizeDiff(diff);

      expect(summary).toContain("No changes");
    });

    test("should list added and removed tables", () => {
      const t = starrocksTable("new_table", {
        id: bigint("id").notNull(),
      }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { new_table: t } });
      const introspected: IntrospectedSchema = {
        ...emptyIntrospected(),
        tables: [makeTable("old_table", [makeColumn({ name: "id" })])],
      };

      const diff = diffSchema(schema, introspected);
      const summary = summarizeDiff(diff);

      expect(summary).toContain("new_table");
      expect(summary).toContain("old_table");
    });
  });

  // ==========================================================================
  // hasChanges flag
  // ==========================================================================

  describe("hasChanges flag", () => {
    test("should be false when everything matches", () => {
      const schema = defineSchema({});
      const diff = diffSchema(schema, emptyIntrospected());
      expect(diff.hasChanges).toBe(false);
    });

    test("should be true for any table change", () => {
      const t = starrocksTable("t", {
        id: bigint("id").notNull(),
      }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const schema = defineSchema({ tables: { t } });
      const diff = diffSchema(schema, emptyIntrospected());
      expect(diff.hasChanges).toBe(true);
    });

    test("should be true for any view change", () => {
      const events = starrocksTable("events", {
        id: bigint("id").notNull(),
      }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const v = createView("v")
        .columns({ id: bigint("id") })
        .as((qb) => qb.select({ id: events.id }).from(events));

      const schema = defineSchema({ views: { v } });
      const diff = diffSchema(schema, emptyIntrospected());
      expect(diff.hasChanges).toBe(true);
    });

    test("should be true for any MV change", () => {
      const events = starrocksTable("events", {
        id: bigint("id").notNull(),
        price: double("price"),
      }, (t) => ({ key: primaryKey(t.id), distribution: hash(t.id, { buckets: 4 }) }));

      const mv = createMaterializedView("mv")
        .columns({ total: double("total") })
        .distributed({ type: "HASH", columns: ["total"], buckets: 4 })
        .refresh({ type: "MANUAL" })
        .as((qb) => qb.select({ total: sum(events.price) }).from(events));

      const schema = defineSchema({ materializedViews: { mv } });
      const diff = diffSchema(schema, emptyIntrospected());
      expect(diff.hasChanges).toBe(true);
    });
  });
});
