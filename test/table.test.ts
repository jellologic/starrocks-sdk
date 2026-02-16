import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, type StarRocksClient } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import type { ColumnDef, LegacyTableOptions } from "../src/types";

describe("StarRocks Table Operations", () => {
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

  test("should create DUPLICATE KEY table", async () => {
    const columns: ColumnDef[] = [
      { name: "event_time", type: "DATETIME", nullable: false },
      { name: "event_type", type: "VARCHAR", length: 64 },
      { name: "user_id", type: "BIGINT" },
      { name: "payload", type: "JSON" },
    ];

    const options: LegacyTableOptions = {
      keyType: "DUPLICATE",
      keys: ["event_time", "event_type"],
      distributedBy: ["user_id"],
      buckets: 4,
      properties: {
        replication_num: "1",
      },
    };

    await client.createTable("events", columns, options);

    const tables = await client.showTables();
    expect(tables).toContain("events");

    const schema = await client.getTableSchema("events");
    expect(schema).toContain("DUPLICATE KEY");
    expect(schema).toContain("event_time");
  });

  test("should create PRIMARY KEY table", async () => {
    const columns: ColumnDef[] = [
      { name: "id", type: "BIGINT", nullable: false },
      { name: "name", type: "VARCHAR", length: 255 },
      { name: "email", type: "VARCHAR", length: 255 },
      { name: "created_at", type: "DATETIME" },
      { name: "updated_at", type: "DATETIME" },
    ];

    const options: LegacyTableOptions = {
      keyType: "PRIMARY",
      keys: ["id"],
      distributedBy: ["id"],
      buckets: 4,
      properties: {
        replication_num: "1",
      },
    };

    await client.createTable("users", columns, options);

    const tables = await client.showTables();
    expect(tables).toContain("users");

    const schema = await client.getTableSchema("users");
    expect(schema).toContain("PRIMARY KEY");
  });

  test("should create AGGREGATE KEY table", async () => {
    const columns: ColumnDef[] = [
      { name: "dt", type: "DATE", nullable: false },
      { name: "product_id", type: "BIGINT", nullable: false },
      { name: "total_sales", type: "BIGINT", aggregateType: "SUM" },
      { name: "max_price", type: "DECIMAL", precision: 10, scale: 2, aggregateType: "MAX" },
    ];

    const options: LegacyTableOptions = {
      keyType: "AGGREGATE",
      keys: ["dt", "product_id"],
      distributedBy: ["product_id"],
      buckets: 4,
      properties: {
        replication_num: "1",
      },
    };

    await client.createTable("sales_agg", columns, options);

    const schema = await client.getTableSchema("sales_agg");
    expect(schema).toContain("AGGREGATE KEY");
    expect(schema).toContain("SUM");
    expect(schema).toContain("MAX");
  });

  test("should describe table", async () => {
    const desc = await client.describeTable("users");
    expect(desc).toBeInstanceOf(Array);
    expect(desc.length).toBeGreaterThan(0);
  });

  test("should drop table", async () => {
    await client.dropTable("events");
    await client.dropTable("users");
    await client.dropTable("sales_agg");

    const tables = await client.showTables();
    expect(tables).not.toContain("events");
    expect(tables).not.toContain("users");
    expect(tables).not.toContain("sales_agg");
  });
});
