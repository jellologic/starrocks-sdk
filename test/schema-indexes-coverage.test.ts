import { describe, test, expect } from "bun:test";
import {
  bigint,
  varchar,
  float as floatCol,
  starrocksTable,
  primaryKey,
  hash,
  bitmapIndex,
  ginIndex,
  vectorIndex,
  generateCreateIndexSQL,
  generateCreateTableSQL,
  defineSchema,
  schemaToIntrospected,
  emptyIntrospectedSchema,
  diffSchema,
  summarizeDiff,
  generateMigration,
} from "../src/schema/index";
import type { IntrospectedSchema } from "../src/schema/index";

const events = starrocksTable("events", {
  id: bigint("id").notNull(),
  title: varchar("title", { length: 255 }),
  status: varchar("status", { length: 50 }),
  embedding: floatCol("embedding"),
}, (t) => ({
  pk: primaryKey(t.id),
  dist: hash(t.id, { buckets: 8 }),
}));

describe("Index SQL generation with comments", () => {
  test("GIN index with comment", () => {
    const idx = ginIndex("idx_search", [events.title, events.status], {
      comment: "Full-text search index",
    });
    const sql = generateCreateIndexSQL("events", idx);
    expect(sql).toContain("USING GIN");
    expect(sql).toContain("COMMENT 'Full-text search index'");
  });

  test("GIN index comment with single quotes is escaped", () => {
    const idx = ginIndex("idx_search", [events.title], {
      comment: "Bob's index",
    });
    const sql = generateCreateIndexSQL("events", idx);
    expect(sql).toContain("COMMENT 'Bob''s index'");
  });

  test("VECTOR index with comment", () => {
    const idx = vectorIndex("idx_vec", events.embedding, {
      indexType: "HNSW",
      metric: "L2_DISTANCE",
      dimension: 128,
      comment: "Vector similarity search",
    });
    const sql = generateCreateIndexSQL("events", idx);
    expect(sql).toContain("USING VECTOR");
    expect(sql).toContain("COMMENT 'Vector similarity search'");
  });

  test("BITMAP index without comment has no COMMENT clause", () => {
    const idx = bitmapIndex("idx_status", events.status);
    const sql = generateCreateIndexSQL("events", idx);
    expect(sql).not.toContain("COMMENT");
  });
});

describe("Table without key config", () => {
  test("generateCreateTableSQL throws when no key is defined", () => {
    const noKeyTable = starrocksTable("no_key", {
      id: bigint("id").notNull(),
      title: varchar("title", { length: 255 }),
    });

    expect(() => generateCreateTableSQL(noKeyTable)).toThrow("has no key type defined");
  });
});

describe("Index modification detection", () => {
  test("detects type change as modification", () => {
    const tableWithGin = starrocksTable("events", {
      id: bigint("id").notNull(),
      title: varchar("title", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
      idx: ginIndex("idx_title", [t.title]),
    }));

    const schema = defineSchema({ tables: { events: tableWithGin } });
    const definedSnapshot = schemaToIntrospected(schema, "testdb");

    // Existing: same index name but BITMAP type
    const existing: IntrospectedSchema = {
      database: "testdb",
      tables: [{
        ...definedSnapshot.tables[0]!,
        indexes: [{
          name: "idx_title",
          type: "BITMAP",
          columns: ["title"],
          properties: {},
          comment: null,
        }],
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, existing);
    const tableChange = diff.tables.modified.find((t) => t.name === "events");
    expect(tableChange).toBeDefined();
    expect(tableChange!.indexChanges).toBeDefined();
    expect(tableChange!.indexChanges!.length).toBe(1);
    expect(tableChange!.indexChanges![0]!.type).toBe("modify");
    expect(tableChange!.indexChanges![0]!.changes).toContain("type: BITMAP -> GIN");
  });

  test("detects column change as modification", () => {
    const tableWithIdx = starrocksTable("events", {
      id: bigint("id").notNull(),
      title: varchar("title", { length: 255 }),
      status: varchar("status", { length: 50 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
      idx: ginIndex("idx_search", [t.title, t.status]),
    }));

    const schema = defineSchema({ tables: { events: tableWithIdx } });
    const definedSnapshot = schemaToIntrospected(schema, "testdb");

    // Existing: same name but only one column
    const existing: IntrospectedSchema = {
      database: "testdb",
      tables: [{
        ...definedSnapshot.tables[0]!,
        indexes: [{
          name: "idx_search",
          type: "GIN",
          columns: ["title"],
          properties: {},
          comment: null,
        }],
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, existing);
    const tableChange = diff.tables.modified.find((t) => t.name === "events");
    expect(tableChange!.indexChanges!.length).toBe(1);
    expect(tableChange!.indexChanges![0]!.type).toBe("modify");
    expect(tableChange!.indexChanges![0]!.changes!.some((c: string) => c.includes("columns:"))).toBe(true);
  });

  test("detects VECTOR property changes as modification", () => {
    const tableWithVec = starrocksTable("events", {
      id: bigint("id").notNull(),
      embedding: floatCol("embedding"),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
      idx: vectorIndex("idx_vec", t.embedding, {
        indexType: "HNSW",
        metric: "COSINE_SIMILARITY",
        dimension: 256,
        params: { M: 32 },
      }),
    }));

    const schema = defineSchema({ tables: { events: tableWithVec } });
    const definedSnapshot = schemaToIntrospected(schema, "testdb");

    // Existing: same name but different dimension
    const existing: IntrospectedSchema = {
      database: "testdb",
      tables: [{
        ...definedSnapshot.tables[0]!,
        indexes: [{
          name: "idx_vec",
          type: "VECTOR",
          columns: ["embedding"],
          properties: {
            index_type: "HNSW",
            dim: "128",
            metric_type: "COSINE_SIMILARITY",
            M: "32",
          },
          comment: null,
        }],
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, existing);
    const tableChange = diff.tables.modified.find((t) => t.name === "events");
    expect(tableChange!.indexChanges!.length).toBe(1);
    expect(tableChange!.indexChanges![0]!.type).toBe("modify");
    expect(tableChange!.indexChanges![0]!.changes!.some((c: string) => c.includes("dim:"))).toBe(true);
  });

  test("summarizeDiff includes index modifications", () => {
    const tableWithIdx = starrocksTable("events", {
      id: bigint("id").notNull(),
      title: varchar("title", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
      idx: ginIndex("idx_title", [t.title]),
    }));

    const schema = defineSchema({ tables: { events: tableWithIdx } });
    const definedSnapshot = schemaToIntrospected(schema, "testdb");

    const existing: IntrospectedSchema = {
      database: "testdb",
      tables: [{
        ...definedSnapshot.tables[0]!,
        indexes: [{
          name: "idx_title",
          type: "BITMAP",
          columns: ["title"],
          properties: {},
          comment: null,
        }],
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, existing);
    const summary = summarizeDiff(diff);
    // summarizeDiff returns a single string, not an array
    expect(summary).toContain("modify indexes");
    expect(summary).toContain("idx_title");
  });
});

describe("Index modify migration", () => {
  test("generates DROP + CREATE for modified index", () => {
    const tableWithGin = starrocksTable("events", {
      id: bigint("id").notNull(),
      title: varchar("title", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
      idx: ginIndex("idx_title", [t.title]),
    }));

    const schema = defineSchema({ tables: { events: tableWithGin } });
    const definedSnapshot = schemaToIntrospected(schema, "testdb");

    const existing: IntrospectedSchema = {
      database: "testdb",
      tables: [{
        ...definedSnapshot.tables[0]!,
        indexes: [{
          name: "idx_title",
          type: "BITMAP",
          columns: ["title"],
          properties: {},
          comment: null,
        }],
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, existing);
    // generateMigration takes (schema, diff, introspected, options)
    const { migration } = generateMigration(schema, diff, existing);
    const upSqls = migration.up.map((s) => s.sql);

    const hasDropIdx = upSqls.some((s) => s.includes("DROP INDEX") && s.includes("idx_title"));
    const hasCreateIdx = upSqls.some((s) => s.includes("CREATE INDEX") && s.includes("idx_title") && s.includes("GIN"));

    expect(hasDropIdx).toBe(true);
    expect(hasCreateIdx).toBe(true);
  });

  test("generates VECTOR CREATE INDEX with full properties from introspected", () => {
    const tableWithVec = starrocksTable("events", {
      id: bigint("id").notNull(),
      embedding: floatCol("embedding"),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
      idx: vectorIndex("idx_vec", t.embedding, {
        indexType: "HNSW",
        metric: "L2_DISTANCE",
        dimension: 128,
        params: { M: 16, efConstruction: 200 },
      }),
    }));

    const schema = defineSchema({ tables: { events: tableWithVec } });

    // existing: no indexes
    const existing: IntrospectedSchema = emptyIntrospectedSchema("testdb");
    existing.tables.push({
      name: "events",
      type: "table",
      columns: [
        { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
        { name: "embedding", dataType: "FLOAT", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
      ],
      keyType: "PRIMARY",
      keyColumns: ["id"],
      distributionType: "HASH",
      distributionColumns: ["id"],
      buckets: 8,
      partitionType: null,
      partitionColumn: null,
      properties: {},
      indexes: [],
      comment: null,
    });

    const diff = diffSchema(schema, existing);
    const { migration } = generateMigration(schema, diff, existing);

    const createIdxSql = migration.up.find((s) => s.sql.includes("CREATE INDEX") && s.sql.includes("idx_vec"));
    expect(createIdxSql).toBeDefined();
    expect(createIdxSql!.sql).toContain("USING VECTOR");
    expect(createIdxSql!.sql).toContain('"index_type" = "HNSW"');
    expect(createIdxSql!.sql).toContain('"dim" = "128"');
    expect(createIdxSql!.sql).toContain('"M" = "16"');
    expect(createIdxSql!.sql).toContain('"efconstruction" = "200"');
  });
});
