import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, type StarRocksClient } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import {
  bigint,
  int,
  varchar,
  datetime,
  date,
  double,
  boolean,
  json,
  string,
  starrocksTable,
  primaryKey,
  duplicateKey,
  aggregateKey,
  uniqueKey,
  hash,
  random,
  rangePartition,
  listPartition,
  expressionPartition,
  sortKey,
  bitmapIndex,
  generateCreateTableSQL,
  flattenProperties,
} from "../src/schema/index";

/**
 * Integration Tests: DSL SQL Generation → StarRocks Round-Trip
 *
 * These tests define tables using the type-safe DSL, generate SQL via
 * generateCreateTableSQL(), execute that SQL against a real StarRocks
 * instance, and verify the result with SHOW CREATE TABLE / DESC.
 */
describe("Schema DDL Integration Tests", () => {
  let client: StarRocksClient;

  const FQN = (table: string) => `${TEST_DATABASE}.${table}`;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  // ============================================================================
  // Unit Tests: flattenProperties
  // ============================================================================

  describe("flattenProperties", () => {
    test("should flatten simple key-value pairs", () => {
      const result = flattenProperties({ replication_num: 1, storage_medium: "SSD" });
      expect(result).toEqual([
        ["replication_num", "1"],
        ["storage_medium", "SSD"],
      ]);
    });

    test("should flatten nested objects with dot-separated keys", () => {
      const result = flattenProperties({
        dynamic_partition: {
          enable: true,
          time_unit: "DAY",
          start: -7,
          end: 3,
          prefix: "p",
          buckets: 4,
        },
      });
      expect(result).toEqual([
        ["dynamic_partition.enable", "true"],
        ["dynamic_partition.time_unit", "DAY"],
        ["dynamic_partition.start", "-7"],
        ["dynamic_partition.end", "3"],
        ["dynamic_partition.prefix", "p"],
        ["dynamic_partition.buckets", "4"],
      ]);
    });

    test("should join arrays with commas", () => {
      const result = flattenProperties({
        bloom_filter_columns: ["col1", "col2", "col3"],
      });
      expect(result).toEqual([
        ["bloom_filter_columns", "col1,col2,col3"],
      ]);
    });

    test("should convert booleans to string", () => {
      const result = flattenProperties({
        replicated_storage: true,
        fast_schema_evolution: false,
      });
      expect(result).toEqual([
        ["replicated_storage", "true"],
        ["fast_schema_evolution", "false"],
      ]);
    });

    test("should skip undefined values", () => {
      const result = flattenProperties({
        replication_num: 1,
        storage_medium: undefined,
      });
      expect(result).toEqual([
        ["replication_num", "1"],
      ]);
    });

    test("should handle mixed nested and flat properties", () => {
      const result = flattenProperties({
        replication_num: 1,
        dynamic_partition: { enable: true, time_unit: "DAY" },
        bloom_filter_columns: ["a", "b"],
      });
      expect(result).toEqual([
        ["replication_num", "1"],
        ["dynamic_partition.enable", "true"],
        ["dynamic_partition.time_unit", "DAY"],
        ["bloom_filter_columns", "a,b"],
      ]);
    });

    test("should handle empty object", () => {
      const result = flattenProperties({});
      expect(result).toEqual([]);
    });

    test("should handle single-element arrays", () => {
      const result = flattenProperties({
        bloom_filter_columns: ["only_one"],
      });
      expect(result).toEqual([
        ["bloom_filter_columns", "only_one"],
      ]);
    });
  });

  // ============================================================================
  // Unit Tests: Column-Level Enhancements
  // ============================================================================

  describe("Column-level enhancements", () => {
    test("should generate column with COMMENT", () => {
      const table = starrocksTable("comment_col_test", {
        id: bigint("id").notNull().comment("Primary identifier"),
        name: varchar("name", { length: 255 }).comment("User's display name"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain("`id` BIGINT NOT NULL COMMENT 'Primary identifier'");
      expect(sql).toContain("`name` VARCHAR(255) COMMENT 'User''s display name'");
    });

    test("should generate column with AUTO_INCREMENT", () => {
      const table = starrocksTable("auto_inc_test", {
        id: bigint("id").notNull().autoIncrement(),
        name: varchar("name", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain("`id` BIGINT NOT NULL AUTO_INCREMENT");
    });

    test("should generate generated column with AS expression", () => {
      const table = starrocksTable("generated_col_test", {
        id: bigint("id").notNull(),
        price: double("price"),
        tax: double("tax"),
        total: double("total").generatedAs("`price` + `tax`"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain("`total` DOUBLE AS (`price` + `tax`)");
      // Generated columns should not have NOT NULL or DEFAULT
      expect(sql).not.toContain("`total` DOUBLE NOT NULL");
    });

    test("should generate generated column with COMMENT", () => {
      const table = starrocksTable("generated_comment_test", {
        id: bigint("id").notNull(),
        a: int("a"),
        b: int("b"),
        c: int("c").generatedAs("`a` + `b`").comment("Sum of a and b"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain("`c` INT AS (`a` + `b`) COMMENT 'Sum of a and b'");
    });
  });

  // ============================================================================
  // Unit Tests: Table-Level Enhancements
  // ============================================================================

  describe("Table-level enhancements", () => {
    test("should generate ORDER BY (sort key)", () => {
      const table = starrocksTable("sort_key_test", {
        id: bigint("id").notNull(),
        dt: date("dt"),
        name: varchar("name", { length: 255 }),
      }, (t) => ({
        key: duplicateKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        sort: sortKey(t.dt, t.name),
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain("ORDER BY (`dt`, `name`)");
    });

    test("should generate table COMMENT after KEY", () => {
      const table = starrocksTable("table_comment_test", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        comment: "This is a test table",
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain('COMMENT "This is a test table"');
      // COMMENT must come after KEY in StarRocks syntax
      const keyIdx = sql.indexOf("PRIMARY KEY");
      const commentIdx = sql.indexOf("COMMENT");
      expect(commentIdx).toBeGreaterThan(keyIdx);
    });

    test("should generate DISTRIBUTED BY HASH without BUCKETS when omitted", () => {
      const table = starrocksTable("auto_bucket_hash_test", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id),
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain("DISTRIBUTED BY HASH(`id`)");
      expect(sql).not.toContain("BUCKETS");
    });

    test("should generate DISTRIBUTED BY RANDOM without BUCKETS when omitted", () => {
      const table = starrocksTable("auto_bucket_random_test", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: duplicateKey(t.id),
        distribution: random(),
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain("DISTRIBUTED BY RANDOM");
      expect(sql).not.toContain("BUCKETS");
    });

    test("should generate dynamic_partition properties with flattened keys", () => {
      const table = starrocksTable("dynamic_part_test", {
        id: bigint("id").notNull(),
        dt: date("dt").notNull(),
      }, (t) => ({
        key: duplicateKey(t.dt, t.id),
        distribution: hash(t.id, { buckets: 4 }),
        partition: rangePartition(t.dt, { interval: "DAY" }),
        properties: {
          replication_num: 1,
          dynamic_partition: {
            enable: true,
            time_unit: "DAY",
            start: -7,
            end: 3,
            prefix: "p",
            buckets: 4,
          },
        },
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain('"dynamic_partition.enable" = "true"');
      expect(sql).toContain('"dynamic_partition.time_unit" = "DAY"');
      expect(sql).toContain('"dynamic_partition.start" = "-7"');
      expect(sql).toContain('"dynamic_partition.end" = "3"');
      expect(sql).toContain('"dynamic_partition.prefix" = "p"');
      expect(sql).toContain('"dynamic_partition.buckets" = "4"');
    });

    test("should generate typed properties", () => {
      const table = starrocksTable("typed_props_test", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: {
          replication_num: 1,
          compression: "LZ4",
          fast_schema_evolution: true,
          replicated_storage: false,
        },
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain('"compression" = "LZ4"');
      expect(sql).toContain('"fast_schema_evolution" = "true"');
      expect(sql).toContain('"replicated_storage" = "false"');
    });
  });

  // ============================================================================
  // Unit Tests: Inline Bitmap Indexes
  // ============================================================================

  describe("Inline bitmap indexes", () => {
    test("should generate bitmap index inside column list", () => {
      const table = starrocksTable("bitmap_inline_test", {
        id: bigint("id").notNull(),
        status: varchar("status", { length: 50 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        bitmapIdx: bitmapIndex("idx_status", t.status),
      }));

      const sql = generateCreateTableSQL(table);
      // Bitmap index should be inside the parentheses, after column defs
      expect(sql).toContain("INDEX `idx_status` (`status`) USING BITMAP");
      // Should appear before the standalone closing paren line
      const lines = sql.split("\n");
      const closingParenLineIdx = lines.findIndex(l => l.trim() === ")");
      const idxLineIdx = lines.findIndex(l => l.includes("INDEX `idx_status`"));
      expect(idxLineIdx).toBeGreaterThan(0);
      expect(idxLineIdx).toBeLessThan(closingParenLineIdx);
    });

    test("should generate bitmap index with comment", () => {
      const table = starrocksTable("bitmap_comment_test", {
        id: bigint("id").notNull(),
        status: varchar("status", { length: 50 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        bitmapIdx: bitmapIndex("idx_status", t.status, { comment: "Status lookup" }),
      }));

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain("INDEX `idx_status` (`status`) USING BITMAP COMMENT 'Status lookup'");
    });
  });

  // ============================================================================
  // Integration Tests: Round-trip DSL → SQL → StarRocks
  // ============================================================================

  describe("Round-trip: DSL → SQL → StarRocks", () => {
    /** Execute generated SQL against StarRocks, replacing table name with FQN */
    async function execDSL(tableName: string, sql: string): Promise<void> {
      await client.raw(sql.replace(
        `IF NOT EXISTS \`${tableName}\``,
        `IF NOT EXISTS ${FQN(tableName)}`
      ));
    }

    /** Get SHOW CREATE TABLE output */
    async function showCreate(tableName: string): Promise<string> {
      const rows = await client.raw<{ "Create Table": string }>(
        `SHOW CREATE TABLE ${FQN(tableName)}`
      );
      return rows[0]?.["Create Table"] ?? "";
    }

    /** Get DESC output */
    async function descTable(tableName: string): Promise<any[]> {
      return client.raw(`DESC ${FQN(tableName)}`);
    }

    test("should create PRIMARY KEY table via DSL", async () => {
      const table = starrocksTable("dsl_primary", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
        created_at: datetime("created_at"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_primary", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_primary");
      expect(schema).toContain("PRIMARY KEY");
      expect(schema).toContain("`id`");
    });

    test("should create DUPLICATE KEY table via DSL", async () => {
      const table = starrocksTable("dsl_duplicate", {
        event_time: datetime("event_time").notNull(),
        event_type: varchar("event_type", { length: 64 }),
        user_id: bigint("user_id"),
        payload: json("payload"),
      }, (t) => ({
        key: duplicateKey(t.event_time, t.event_type),
        distribution: hash(t.user_id, { buckets: 4 }),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_duplicate", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_duplicate");
      expect(schema).toContain("DUPLICATE KEY");
    });

    test("should create AGGREGATE KEY table via DSL", async () => {
      const table = starrocksTable("dsl_aggregate", {
        dt: date("dt").notNull(),
        product_id: bigint("product_id").notNull(),
        total_sales: bigint("total_sales").aggregate("SUM"),
        max_price: double("max_price").aggregate("MAX"),
      }, (t) => ({
        key: aggregateKey(t.dt, t.product_id),
        distribution: hash(t.product_id, { buckets: 4 }),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_aggregate", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_aggregate");
      expect(schema).toContain("AGGREGATE KEY");
    });

    test("should create UNIQUE KEY table via DSL", async () => {
      const table = starrocksTable("dsl_unique", {
        user_id: bigint("user_id").notNull(),
        email: varchar("email", { length: 255 }).notNull(),
        name: varchar("name", { length: 255 }),
      }, (t) => ({
        key: uniqueKey(t.user_id),
        distribution: hash(t.user_id, { buckets: 4 }),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_unique", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_unique");
      expect(schema).toContain("UNIQUE KEY");
    });

    test("should create table with multi-column hash distribution via DSL", async () => {
      const table = starrocksTable("dsl_hash_dist", {
        id: bigint("id").notNull(),
        tenant_id: bigint("tenant_id").notNull(),
        data: varchar("data", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id, t.tenant_id),
        distribution: hash([t.id, t.tenant_id], { buckets: 8 }),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_hash_dist", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_hash_dist");
      expect(schema).toContain("DISTRIBUTED BY HASH");
    });

    test("should create table with random distribution via DSL", async () => {
      const table = starrocksTable("dsl_random_dist", {
        id: bigint("id").notNull(),
        data: varchar("data", { length: 255 }),
      }, (t) => ({
        key: duplicateKey(t.id),
        distribution: random({ buckets: 4 }),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_random_dist", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_random_dist");
      expect(schema).toContain("DISTRIBUTED BY RANDOM");
    });

    test("should create table with range partition via DSL", async () => {
      const table = starrocksTable("dsl_range_part", {
        dt: date("dt").notNull(),
        id: bigint("id").notNull(),
        value: double("value"),
      }, (t) => ({
        key: duplicateKey(t.dt, t.id),
        partition: rangePartition(t.dt, {
          partitions: [
            { name: "p2024q1", lessThan: "2024-04-01" },
            { name: "p2024q2", lessThan: "2024-07-01" },
            { name: "p_max", lessThan: "MAXVALUE" },
          ],
        }),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_range_part", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_range_part");
      expect(schema).toContain("PARTITION BY RANGE");
      expect(schema).toContain("p2024q1");
      expect(schema).toContain("p2024q2");
    });

    test("should create table with list partition via DSL", async () => {
      const table = starrocksTable("dsl_list_part", {
        region: varchar("region", { length: 50 }).notNull(),
        id: bigint("id").notNull(),
        data: varchar("data", { length: 255 }),
      }, (t) => ({
        key: duplicateKey(t.region, t.id),
        partition: listPartition(t.region, {
          americas: ["us", "ca", "mx"],
          europe: ["uk", "de", "fr"],
        }),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_list_part", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_list_part");
      expect(schema).toContain("PARTITION BY LIST");
    });

    test("should create table with dynamic_partition properties via DSL", async () => {
      const table = starrocksTable("dsl_dynamic_part", {
        dt: date("dt").notNull(),
        id: bigint("id").notNull(),
        value: double("value"),
      }, (t) => ({
        key: duplicateKey(t.dt, t.id),
        partition: rangePartition(t.dt, { interval: "DAY" }),
        distribution: hash(t.id, { buckets: 4 }),
        properties: {
          replication_num: 1,
          dynamic_partition: {
            enable: true,
            time_unit: "DAY",
            start: -3,
            end: 3,
            prefix: "p",
            buckets: 4,
          },
        },
      }));

      await execDSL("dsl_dynamic_part", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_dynamic_part");
      expect(schema).toContain("dynamic_partition.enable");
      expect(schema).toContain("dynamic_partition.time_unit");
    });

    test("should create table with bloom_filter_columns via DSL", async () => {
      const table = starrocksTable("dsl_bloom_filter", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
        email: varchar("email", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: {
          replication_num: 1,
          bloom_filter_columns: ["name", "email"],
        },
      }));

      await execDSL("dsl_bloom_filter", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_bloom_filter");
      expect(schema).toContain("bloom_filter_columns");
    });

    test("should create table with sort key via DSL", async () => {
      const table = starrocksTable("dsl_sort_key", {
        id: bigint("id").notNull(),
        dt: date("dt"),
        name: varchar("name", { length: 255 }),
        value: double("value"),
      }, (t) => ({
        key: duplicateKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        sort: sortKey(t.dt, t.name),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_sort_key", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_sort_key");
      expect(schema).toContain("ORDER BY");
    });

    test("should create table with inline bitmap index via DSL", async () => {
      const table = starrocksTable("dsl_bitmap_idx", {
        id: bigint("id").notNull(),
        status: varchar("status", { length: 50 }),
        category: varchar("category", { length: 100 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        idx1: bitmapIndex("idx_status", t.status),
        idx2: bitmapIndex("idx_category", t.category, { comment: "Category filter" }),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_bitmap_idx", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_bitmap_idx");
      expect(schema).toContain("idx_status");
      expect(schema).toContain("BITMAP");
    });

    test("should create table with column comments via DSL", async () => {
      const table = starrocksTable("dsl_col_comments", {
        id: bigint("id").notNull().comment("Primary key"),
        name: varchar("name", { length: 255 }).comment("User name"),
        email: varchar("email", { length: 255 }).comment("Email address"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_col_comments", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_col_comments");
      expect(schema).toContain("Primary key");
      expect(schema).toContain("User name");
    });

    test("should create table with table comment via DSL", async () => {
      const table = starrocksTable("dsl_table_comment", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        comment: "A table with a comment",
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_table_comment", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_table_comment");
      expect(schema).toContain("A table with a comment");
    });

    test("should create table with auto-bucketing via DSL", async () => {
      const table = starrocksTable("dsl_auto_bucket", {
        id: bigint("id").notNull(),
        data: varchar("data", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_auto_bucket", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_auto_bucket");
      expect(schema).toContain("DISTRIBUTED BY HASH");
    });

    test("should create table with AUTO_INCREMENT via DSL", async () => {
      const table = starrocksTable("dsl_auto_inc", {
        id: bigint("id").notNull().autoIncrement(),
        name: varchar("name", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: 1 },
      }));

      await execDSL("dsl_auto_inc", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_auto_inc");
      expect(schema).toContain("AUTO_INCREMENT");
    });

    test("should create complex table with all features via DSL", async () => {
      const table = starrocksTable("dsl_complex", {
        dt: date("dt").notNull().comment("Event date"),
        id: bigint("id").notNull().comment("Primary key"),
        name: varchar("name", { length: 255 }),
        status: varchar("status", { length: 50 }).default("active"),
        value: double("value"),
        payload: json("payload"),
      }, (t) => ({
        key: duplicateKey(t.dt, t.id),
        partition: rangePartition(t.dt, {
          partitions: [
            { name: "p2024h1", lessThan: "2024-07-01" },
            { name: "p2024h2", lessThan: "2025-01-01" },
            { name: "p_future", lessThan: "MAXVALUE" },
          ],
        }),
        distribution: hash(t.id, { buckets: 4 }),
        sort: sortKey(t.dt, t.name),
        bitmapIdx: bitmapIndex("idx_status", t.status),
        comment: "Complex test table with all features",
        properties: {
          replication_num: 1,
          bloom_filter_columns: ["name"],
        },
      }));

      await execDSL("dsl_complex", generateCreateTableSQL(table));

      const schema = await showCreate("dsl_complex");
      expect(schema).toContain("DUPLICATE KEY");
      expect(schema).toContain("PARTITION BY RANGE");
      expect(schema).toContain("DISTRIBUTED BY HASH");
      expect(schema).toContain("ORDER BY");
      expect(schema).toContain("idx_status");
      expect(schema).toContain("Complex test table with all features");
      expect(schema).toContain("bloom_filter_columns");
    });

    test("should verify DESC output matches DSL columns", async () => {
      const desc = await descTable("dsl_complex");
      const columnNames = desc.map((row: any) => row.Field || row.field);

      expect(columnNames).toContain("id");
      expect(columnNames).toContain("dt");
      expect(columnNames).toContain("name");
      expect(columnNames).toContain("status");
      expect(columnNames).toContain("value");
      expect(columnNames).toContain("payload");
    });
  });
});
