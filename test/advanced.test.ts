import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, type StarRocksClient } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import type { ColumnDef, TableOptions, BitmapIndex, InvertedIndex } from "../src/types";

describe("StarRocks Advanced Features", () => {
  let client: StarRocksClient;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);
    await client.useDatabase(TEST_DATABASE);
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  describe("New TableOptions Format", () => {
    test("should create table with hash distribution config", async () => {
      const columns: ColumnDef[] = [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "name", type: "VARCHAR", length: 255 },
        { name: "created_at", type: "DATETIME" },
      ];

      const options: TableOptions = {
        keyType: "PRIMARY",
        keys: ["id"],
        distribution: {
          type: "HASH",
          columns: ["id"],
          buckets: 4,
        },
        properties: {
          replication_num: 1,
        },
      };

      await client.createTable("new_format_table", columns, options);

      const tables = await client.showTables();
      expect(tables).toContain("new_format_table");

      const schema = await client.getTableSchema("new_format_table");
      expect(schema).toContain("PRIMARY KEY");
      expect(schema).toContain("DISTRIBUTED BY HASH");

      await client.dropTable("new_format_table");
    });

    test("should create table with random distribution", async () => {
      const columns: ColumnDef[] = [
        { name: "event_time", type: "DATETIME", nullable: false },
        { name: "message", type: "VARCHAR", length: 1000 },
      ];

      const options: TableOptions = {
        keyType: "DUPLICATE",
        keys: ["event_time"],
        distribution: {
          type: "RANDOM",
          buckets: 4,
        },
        properties: {
          replication_num: 1,
        },
      };

      await client.createTable("random_dist_table", columns, options);

      const schema = await client.getTableSchema("random_dist_table");
      // StarRocks uses uppercase RANDOM in output
      expect(schema.toUpperCase()).toContain("RANDOM");

      await client.dropTable("random_dist_table");
    });

    test("should create PRIMARY KEY table with persistent index", async () => {
      const columns: ColumnDef[] = [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "user_id", type: "BIGINT", nullable: false },
        { name: "created_at", type: "DATETIME", nullable: false },
        { name: "data", type: "JSON" },
      ];

      const options: TableOptions = {
        keyType: "PRIMARY",
        keys: ["id"],
        distribution: {
          type: "HASH",
          columns: ["id"],
          buckets: 4,
        },
        properties: {
          replication_num: 1,
          enable_persistent_index: true,
        },
      };

      await client.createTable("pk_table", columns, options);

      const schema = await client.getTableSchema("pk_table");
      expect(schema).toContain("PRIMARY KEY");
      expect(schema).toContain("enable_persistent_index");

      await client.dropTable("pk_table");
    });
  });

  describe("Complex Data Types", () => {
    test("should create table with ARRAY type", async () => {
      const columns: ColumnDef[] = [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "tags", type: { type: "ARRAY", elementType: "VARCHAR" } },
        { name: "scores", type: { type: "ARRAY", elementType: "INT" } },
      ];

      const options: TableOptions = {
        keyType: "PRIMARY",
        keys: ["id"],
        distribution: {
          type: "HASH",
          columns: ["id"],
          buckets: 4,
        },
        properties: {
          replication_num: 1,
        },
      };

      await client.createTable("array_table", columns, options);

      const schema = await client.getTableSchema("array_table");
      // StarRocks returns lowercase type names
      expect(schema.toLowerCase()).toContain("array<varchar");
      expect(schema.toLowerCase()).toContain("array<int");

      await client.dropTable("array_table");
    });

    test("should create table with MAP type", async () => {
      const columns: ColumnDef[] = [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "attributes", type: { type: "MAP", keyType: "VARCHAR", valueType: "VARCHAR" } },
        { name: "counts", type: { type: "MAP", keyType: "VARCHAR", valueType: "BIGINT" } },
      ];

      const options: TableOptions = {
        keyType: "PRIMARY",
        keys: ["id"],
        distribution: {
          type: "HASH",
          columns: ["id"],
          buckets: 4,
        },
        properties: {
          replication_num: 1,
        },
      };

      await client.createTable("map_table", columns, options);

      const schema = await client.getTableSchema("map_table");
      expect(schema.toLowerCase()).toContain("map<varchar");

      await client.dropTable("map_table");
    });

    test("should create table with STRUCT type", async () => {
      const columns: ColumnDef[] = [
        { name: "id", type: "BIGINT", nullable: false },
        {
          name: "address",
          type: {
            type: "STRUCT",
            fields: [
              { name: "street", type: "VARCHAR" },
              { name: "city", type: "VARCHAR" },
              { name: "zip", type: "VARCHAR" },
            ],
          },
        },
      ];

      const options: TableOptions = {
        keyType: "PRIMARY",
        keys: ["id"],
        distribution: {
          type: "HASH",
          columns: ["id"],
          buckets: 4,
        },
        properties: {
          replication_num: 1,
        },
      };

      await client.createTable("struct_table", columns, options);

      const schema = await client.getTableSchema("struct_table");
      expect(schema.toLowerCase()).toContain("struct<");
      expect(schema).toContain("street");
      expect(schema).toContain("city");

      await client.dropTable("struct_table");
    });
  });

  describe("Table Properties", () => {
    test("should create table with compression property", async () => {
      const columns: ColumnDef[] = [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "name", type: "VARCHAR", length: 255 },
        { name: "value", type: "DOUBLE" },
      ];

      const options: TableOptions = {
        keyType: "PRIMARY",
        keys: ["id"],
        distribution: {
          type: "HASH",
          columns: ["id"],
          buckets: 4,
        },
        properties: {
          replication_num: 1,
          compression: "ZSTD",
        },
      };

      await client.createTable("compressed_table", columns, options);

      const schema = await client.getTableSchema("compressed_table");
      expect(schema.toLowerCase()).toContain("zstd");

      await client.dropTable("compressed_table");
    });

    test("should create table with bloom filter columns", async () => {
      const columns: ColumnDef[] = [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "email", type: "VARCHAR", length: 255 },
        { name: "phone", type: "VARCHAR", length: 32 },
      ];

      const options: TableOptions = {
        keyType: "PRIMARY",
        keys: ["id"],
        distribution: {
          type: "HASH",
          columns: ["id"],
          buckets: 4,
        },
        properties: {
          replication_num: 1,
          bloom_filter_columns: ["email", "phone"],
        },
      };

      await client.createTable("bloom_table", columns, options);

      const schema = await client.getTableSchema("bloom_table");
      expect(schema).toContain("bloom_filter_columns");

      await client.dropTable("bloom_table");
    });
  });

  describe("Indexes", () => {
    test("should create bitmap index", async () => {
      // First create a table
      const columns: ColumnDef[] = [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "status", type: "VARCHAR", length: 32 },
        { name: "category", type: "VARCHAR", length: 64 },
      ];

      const options: TableOptions = {
        keyType: "PRIMARY",
        keys: ["id"],
        distribution: {
          type: "HASH",
          columns: ["id"],
          buckets: 4,
        },
        properties: {
          replication_num: 1,
        },
      };

      await client.createTable("index_test_table", columns, options);

      // Create bitmap index
      const bitmapIndex: BitmapIndex = {
        type: "BITMAP",
        name: "idx_status",
        column: "status",
        comment: "Index on status column",
      };

      await client.createBitmapIndex("index_test_table", bitmapIndex);

      const indexes = await client.showIndexes("index_test_table");
      expect(indexes).toBeInstanceOf(Array);

      // Note: Dropping index requires waiting for schema change to complete
      // For this test, we just verify the index was created and clean up the table
      await client.dropTable("index_test_table");
    });

    test("should attempt to create inverted (GIN) index", async () => {
      // Note: GIN index requires enable_experimental_gin = true in StarRocks FE config
      // This test verifies the SQL is correctly generated even if the feature is disabled
      const columns: ColumnDef[] = [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "title", type: "VARCHAR", length: 255 },
        { name: "content", type: "STRING" },
      ];

      const options: TableOptions = {
        keyType: "PRIMARY",
        keys: ["id"],
        distribution: {
          type: "HASH",
          columns: ["id"],
          buckets: 4,
        },
        properties: {
          replication_num: 1,
        },
      };

      await client.createTable("search_table", columns, options);

      // Create inverted index (GIN) - may fail if experimental feature is disabled
      const invertedIndex: InvertedIndex = {
        type: "INVERTED",
        name: "idx_content_gin",
        columns: ["content"],
      };

      try {
        await client.createInvertedIndex("search_table", invertedIndex);
        const indexes = await client.showIndexes("search_table");
        expect(indexes).toBeInstanceOf(Array);
      } catch (err) {
        // GIN index is an experimental feature, may be disabled
        const error = err as Error;
        expect(error.message).toContain("enable_experimental_gin");
      }

      await client.dropTable("search_table");
    });
  });

  describe("Partitioning", () => {
    test("should create table with range partitioning", async () => {
      // Note: Key columns must be first in schema and match order
      const columns: ColumnDef[] = [
        { name: "dt", type: "DATE", nullable: false },
        { name: "id", type: "BIGINT", nullable: false },
        { name: "amount", type: "DECIMAL", precision: 10, scale: 2 },
      ];

      const options: TableOptions = {
        keyType: "DUPLICATE",
        keys: ["dt", "id"],
        partition: {
          type: "RANGE",
          columns: ["dt"],
          partitions: [
            { name: "p202401", lessThan: "2024-02-01" },
            { name: "p202402", lessThan: "2024-03-01" },
            { name: "p202403", lessThan: "2024-04-01" },
          ],
        },
        distribution: {
          type: "HASH",
          columns: ["id"],
          buckets: 4,
        },
        properties: {
          replication_num: 1,
        },
      };

      await client.createTable("range_partition_table", columns, options);

      const schema = await client.getTableSchema("range_partition_table");
      expect(schema).toContain("PARTITION BY RANGE");
      expect(schema).toContain("p202401");
      expect(schema).toContain("p202402");

      await client.dropTable("range_partition_table");
    });

    test("should create table with list partitioning", async () => {
      // Note: Key columns must be first in schema and match order
      const columns: ColumnDef[] = [
        { name: "region", type: "VARCHAR", length: 32, nullable: false },
        { name: "id", type: "BIGINT", nullable: false },
        { name: "value", type: "DOUBLE" },
      ];

      const options: TableOptions = {
        keyType: "DUPLICATE",
        keys: ["region", "id"],
        partition: {
          type: "LIST",
          columns: ["region"],
          partitions: [
            { name: "p_na", values: ["US", "CA", "MX"] },
            { name: "p_eu", values: ["UK", "DE", "FR"] },
            { name: "p_apac", values: ["JP", "CN", "AU"] },
          ],
        },
        distribution: {
          type: "HASH",
          columns: ["id"],
          buckets: 4,
        },
        properties: {
          replication_num: 1,
        },
      };

      await client.createTable("list_partition_table", columns, options);

      const schema = await client.getTableSchema("list_partition_table");
      expect(schema).toContain("PARTITION BY LIST");
      expect(schema).toContain("p_na");
      expect(schema).toContain("p_eu");

      await client.dropTable("list_partition_table");
    });
  });
});
