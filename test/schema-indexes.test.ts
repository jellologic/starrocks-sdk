import { describe, test, expect } from "bun:test";
import {
  bigint,
  varchar,
  starrocksTable,
  primaryKey,
  hash,
  bitmapIndex,
  ginIndex,
  vectorIndex,
  generateCreateIndexSQL,
  generateDropIndexSQL,
  defineSchema,
  schemaToIntrospected,
  emptyIntrospectedSchema,
  diffSchema,
  summarizeDiff,
  generateMigration,
} from "../src/schema/index";

// Helper table for tests
const events = starrocksTable("events", {
  id: bigint("id").notNull(),
  name: varchar("name", { length: 255 }),
  status: varchar("status", { length: 50 }),
  description: varchar("description", { length: 1000 }),
}, (t) => ({
  pk: primaryKey(t.id),
  dist: hash(t.id, { buckets: 8 }),
  bitmapIdx: bitmapIndex("idx_status", t.status),
  ginIdx: ginIndex("idx_desc", [t.description]),
}));

describe("Index Builders", () => {
  test("bitmapIndex creates correct config", () => {
    const col = varchar("status", { length: 50 });
    const idx = bitmapIndex("idx_status", col);
    expect(idx.type).toBe("BITMAP");
    expect(idx.name).toBe("idx_status");
    expect(idx.column).toBe("status");
  });

  test("bitmapIndex with comment", () => {
    const col = varchar("status", { length: 50 });
    const idx = bitmapIndex("idx_status", col, { comment: "Status index" });
    expect(idx.comment).toBe("Status index");
  });

  test("ginIndex creates correct config", () => {
    const col1 = varchar("desc", { length: 1000 });
    const col2 = varchar("title", { length: 255 });
    const idx = ginIndex("idx_text", [col1, col2]);
    expect(idx.type).toBe("GIN");
    expect(idx.name).toBe("idx_text");
    expect(idx.columns).toEqual(["desc", "title"]);
  });

  test("vectorIndex creates correct config", () => {
    const col = varchar("embedding", { length: 1000 });
    const idx = vectorIndex("idx_embed", col, {
      indexType: "HNSW",
      metric: "COSINE_SIMILARITY",
      dimension: 768,
      params: { M: 32, efConstruction: 64 },
    });
    expect(idx.type).toBe("VECTOR");
    expect(idx.name).toBe("idx_embed");
    expect(idx.column).toBe("embedding");
    expect(idx.indexType).toBe("HNSW");
    expect(idx.metric).toBe("COSINE_SIMILARITY");
    expect(idx.dimension).toBe(768);
    expect(idx.params?.M).toBe(32);
    expect(idx.params?.efConstruction).toBe(64);
  });
});

describe("Index SQL Generation", () => {
  test("generateCreateIndexSQL for BITMAP", () => {
    const col = varchar("status", { length: 50 });
    const idx = bitmapIndex("idx_status", col);
    const sql = generateCreateIndexSQL("events", idx);
    expect(sql).toContain("CREATE INDEX");
    expect(sql).toContain("idx_status");
    expect(sql).toContain("USING BITMAP");
    expect(sql).toContain("`status`");
  });

  test("generateCreateIndexSQL for BITMAP with comment", () => {
    const col = varchar("status", { length: 50 });
    const idx = bitmapIndex("idx_status", col, { comment: "Status filter" });
    const sql = generateCreateIndexSQL("events", idx);
    expect(sql).toContain("COMMENT 'Status filter'");
  });

  test("generateCreateIndexSQL for GIN", () => {
    const col1 = varchar("title", { length: 255 });
    const col2 = varchar("body", { length: 1000 });
    const idx = ginIndex("idx_text", [col1, col2]);
    const sql = generateCreateIndexSQL("events", idx);
    expect(sql).toContain("CREATE INDEX");
    expect(sql).toContain("idx_text");
    expect(sql).toContain("USING GIN");
    expect(sql).toContain("`title`, `body`");
  });

  test("generateCreateIndexSQL for VECTOR HNSW", () => {
    const col = varchar("embedding", { length: 100 });
    const idx = vectorIndex("idx_embed", col, {
      indexType: "HNSW",
      metric: "L2_DISTANCE",
      dimension: 128,
      params: { M: 16, efConstruction: 40 },
    });
    const sql = generateCreateIndexSQL("events", idx);
    expect(sql).toContain("USING VECTOR");
    expect(sql).toContain('"index_type" = "HNSW"');
    expect(sql).toContain('"dim" = "128"');
    expect(sql).toContain('"metric_type" = "L2_DISTANCE"');
    expect(sql).toContain('"M" = "16"');
    expect(sql).toContain('"efconstruction" = "40"');
  });

  test("generateCreateIndexSQL for VECTOR IVFPQ", () => {
    const col = varchar("embedding", { length: 100 });
    const idx = vectorIndex("idx_embed", col, {
      indexType: "IVFPQ",
      metric: "COSINE_SIMILARITY",
      dimension: 256,
      params: { nlist: 100, nbits: 8 },
    });
    const sql = generateCreateIndexSQL("events", idx);
    expect(sql).toContain('"index_type" = "IVFPQ"');
    expect(sql).toContain('"nlist" = "100"');
    expect(sql).toContain('"nbits" = "8"');
  });

  test("generateDropIndexSQL", () => {
    const sql = generateDropIndexSQL("events", "idx_status");
    expect(sql).toBe("DROP INDEX `idx_status` ON `events`");
  });
});

describe("Table Config Normalization with Indexes", () => {
  test("single index in table config", () => {
    const table = starrocksTable("test_table", {
      id: bigint("id").notNull(),
      status: varchar("status", { length: 50 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 4 }),
      bitmapIdx: bitmapIndex("idx_status", t.status),
    }));

    expect(table.config.indexes).toBeDefined();
    expect(table.config.indexes!.length).toBe(1);
    expect(table.config.indexes![0].type).toBe("BITMAP");
    expect(table.config.indexes![0].name).toBe("idx_status");
  });

  test("multiple indexes in table config", () => {
    expect(events.config.indexes).toBeDefined();
    expect(events.config.indexes!.length).toBe(2);
    expect(events.config.indexes!.map(i => i.type)).toEqual(["BITMAP", "GIN"]);
  });

  test("array of indexes in table config", () => {
    const table = starrocksTable("test_table", {
      id: bigint("id").notNull(),
      status: varchar("status", { length: 50 }),
      name: varchar("name", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 4 }),
      indexes: [
        bitmapIndex("idx_status", t.status),
        ginIndex("idx_name", [t.name]),
      ],
    }));

    expect(table.config.indexes).toBeDefined();
    expect(table.config.indexes!.length).toBe(2);
  });
});

describe("Schema Snapshot with Indexes", () => {
  test("indexes are included in snapshot", () => {
    const schema = defineSchema({ tables: { events } });
    const snapshot = schemaToIntrospected(schema, "testdb");

    const table = snapshot.tables.find(t => t.name === "events");
    expect(table).toBeDefined();
    expect(table!.indexes.length).toBe(2);

    const bitmapIdx = table!.indexes.find(i => i.name === "idx_status");
    expect(bitmapIdx).toBeDefined();
    expect(bitmapIdx!.type).toBe("BITMAP");
    expect(bitmapIdx!.columns).toEqual(["status"]);

    const ginIdx = table!.indexes.find(i => i.name === "idx_desc");
    expect(ginIdx).toBeDefined();
    expect(ginIdx!.type).toBe("GIN");
    expect(ginIdx!.columns).toEqual(["description"]);
  });

  test("vector index properties in snapshot", () => {
    const col = varchar("embedding", { length: 100 });
    const table = starrocksTable("vectors", {
      id: bigint("id").notNull(),
      embedding: col,
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 4 }),
      vecIdx: vectorIndex("idx_embed", t.embedding, {
        indexType: "HNSW",
        metric: "L2_DISTANCE",
        dimension: 128,
        params: { M: 16 },
      }),
    }));

    const schema = defineSchema({ tables: { vectors: table } });
    const snapshot = schemaToIntrospected(schema, "testdb");
    const t = snapshot.tables[0];
    const idx = t.indexes[0];

    expect(idx.type).toBe("VECTOR");
    expect(idx.properties["index_type"]).toBe("HNSW");
    expect(idx.properties["dim"]).toBe("128");
    expect(idx.properties["metric_type"]).toBe("L2_DISTANCE");
    expect(idx.properties["M"]).toBe("16");
  });
});

describe("Index Diffing", () => {
  test("detects added index", () => {
    const tableWithIndex = starrocksTable("events", {
      id: bigint("id").notNull(),
      name: varchar("name", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
      bitmapIdx: bitmapIndex("idx_name", t.name),
    }));

    const schema = defineSchema({ tables: { events: tableWithIndex } });

    // Existing table has no indexes
    const introspected = emptyIntrospectedSchema("testdb");
    introspected.tables.push({
      name: "events",
      type: "table",
      columns: [
        { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
        { name: "name", dataType: "VARCHAR(255)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
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

    const diff = diffSchema(schema, introspected);
    expect(diff.hasChanges).toBe(true);
    expect(diff.tables.modified.length).toBe(1);
    expect(diff.tables.modified[0].indexChanges).toBeDefined();
    expect(diff.tables.modified[0].indexChanges!.length).toBe(1);
    expect(diff.tables.modified[0].indexChanges![0].type).toBe("add");
    expect(diff.tables.modified[0].indexChanges![0].indexName).toBe("idx_name");
  });

  test("detects removed index", () => {
    const tableNoIndex = starrocksTable("events", {
      id: bigint("id").notNull(),
      name: varchar("name", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
    }));

    const schema = defineSchema({ tables: { events: tableNoIndex } });

    const introspected = emptyIntrospectedSchema("testdb");
    introspected.tables.push({
      name: "events",
      type: "table",
      columns: [
        { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
        { name: "name", dataType: "VARCHAR(255)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
      ],
      keyType: "PRIMARY",
      keyColumns: ["id"],
      distributionType: "HASH",
      distributionColumns: ["id"],
      buckets: 8,
      partitionType: null,
      partitionColumn: null,
      properties: {},
      indexes: [{ name: "idx_name", type: "BITMAP", columns: ["name"], properties: {}, comment: null }],
      comment: null,
    });

    const diff = diffSchema(schema, introspected);
    expect(diff.hasChanges).toBe(true);
    expect(diff.tables.modified[0].indexChanges![0].type).toBe("remove");
  });

  test("summarizeDiff includes index changes", () => {
    const tableWithIndex = starrocksTable("events", {
      id: bigint("id").notNull(),
      name: varchar("name", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
      bitmapIdx: bitmapIndex("idx_name", t.name),
    }));

    const schema = defineSchema({ tables: { events: tableWithIndex } });

    const introspected = emptyIntrospectedSchema("testdb");
    introspected.tables.push({
      name: "events",
      type: "table",
      columns: [
        { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
        { name: "name", dataType: "VARCHAR(255)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
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

    const diff = diffSchema(schema, introspected);
    const summary = summarizeDiff(diff);
    expect(summary).toContain("add indexes: idx_name");
  });
});

describe("Index Migration Generation", () => {
  test("generates CREATE INDEX for new table with indexes", () => {
    const schema = defineSchema({ tables: { events } });
    const introspected = emptyIntrospectedSchema("testdb");
    const diff = diffSchema(schema, introspected);
    const { migration } = generateMigration(schema, diff, introspected);

    const indexStmts = migration.up.filter(s => s.object === "index");
    expect(indexStmts.length).toBe(2);
    expect(indexStmts[0].sql).toContain("CREATE INDEX");
    expect(indexStmts[0].sql).toContain("USING BITMAP");
    expect(indexStmts[1].sql).toContain("USING GIN");
  });

  test("generates CREATE INDEX for added index on existing table", () => {
    const tableWithIndex = starrocksTable("events", {
      id: bigint("id").notNull(),
      name: varchar("name", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
      bitmapIdx: bitmapIndex("idx_name", t.name),
    }));

    const schema = defineSchema({ tables: { events: tableWithIndex } });

    const introspected = emptyIntrospectedSchema("testdb");
    introspected.tables.push({
      name: "events",
      type: "table",
      columns: [
        { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
        { name: "name", dataType: "VARCHAR(255)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
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

    const diff = diffSchema(schema, introspected);
    const { migration } = generateMigration(schema, diff, introspected);

    const indexUp = migration.up.filter(s => s.object === "index");
    expect(indexUp.length).toBe(1);
    expect(indexUp[0].sql).toContain("CREATE INDEX");
    expect(indexUp[0].sql).toContain("idx_name");

    const indexDown = migration.down.filter(s => s.object === "index");
    expect(indexDown.length).toBe(1);
    expect(indexDown[0].sql).toContain("DROP INDEX");
  });

  test("generates DROP INDEX for removed index", () => {
    const tableNoIndex = starrocksTable("events", {
      id: bigint("id").notNull(),
      name: varchar("name", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
    }));

    const schema = defineSchema({ tables: { events: tableNoIndex } });

    const introspected = emptyIntrospectedSchema("testdb");
    introspected.tables.push({
      name: "events",
      type: "table",
      columns: [
        { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
        { name: "name", dataType: "VARCHAR(255)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
      ],
      keyType: "PRIMARY",
      keyColumns: ["id"],
      distributionType: "HASH",
      distributionColumns: ["id"],
      buckets: 8,
      partitionType: null,
      partitionColumn: null,
      properties: {},
      indexes: [{ name: "idx_name", type: "BITMAP", columns: ["name"], properties: {}, comment: null }],
      comment: null,
    });

    const diff = diffSchema(schema, introspected);
    const { migration } = generateMigration(schema, diff, introspected);

    const indexUp = migration.up.filter(s => s.object === "index");
    expect(indexUp.length).toBe(1);
    expect(indexUp[0].sql).toContain("DROP INDEX");
    expect(indexUp[0].sql).toContain("idx_name");
  });
});
