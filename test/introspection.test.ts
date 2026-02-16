import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, type StarRocksClient } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import type { TableOptions } from "../src/types";

describe("StarRocks Schema Introspection", () => {
  let client: StarRocksClient;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);
    await client.useDatabase(TEST_DATABASE);

    // Create test table with partitions
    const options: TableOptions = {
      keyType: "DUPLICATE",
      keys: ["dt", "id"],
      partition: {
        type: "RANGE",
        columns: ["dt"],
        partitions: [
          { name: "p202401", lessThan: "2024-02-01" },
          { name: "p202402", lessThan: "2024-03-01" },
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

    await client.createTable(
      "introspect_test",
      [
        { name: "dt", type: "DATE", nullable: false },
        { name: "id", type: "BIGINT", nullable: false },
        { name: "name", type: "VARCHAR", length: 255 },
        { name: "value", type: "DECIMAL", precision: 10, scale: 2 },
      ],
      options
    );
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  test("should get column information", async () => {
    const columns = await client.getColumns("introspect_test");

    expect(columns).toBeInstanceOf(Array);
    expect(columns.length).toBe(4);

    const dtColumn = columns.find((c) => c.name === "dt");
    expect(dtColumn).toBeDefined();
    expect(dtColumn!.type.toLowerCase()).toContain("date");
    expect(dtColumn!.isKey).toBe(true);

    const nameColumn = columns.find((c) => c.name === "name");
    expect(nameColumn).toBeDefined();
    expect(nameColumn!.nullable).toBe(true);
  });

  test("should get partition information", async () => {
    const partitions = await client.getPartitions("introspect_test");

    expect(partitions).toBeInstanceOf(Array);
    expect(partitions.length).toBe(2);

    const partitionNames = partitions.map((p) => p.partitionName);
    expect(partitionNames).toContain("p202401");
    expect(partitionNames).toContain("p202402");
  });

  test("should get table statistics", async () => {
    const stats = await client.getTableStats("introspect_test");

    expect(stats.tableName).toBe("introspect_test");
    expect(stats.partitionCount).toBe(2);
    expect(stats.rowCount).toBe(0); // Empty table
  });

  test("should check if table exists", async () => {
    const exists = await client.tableExists("introspect_test");
    expect(exists).toBe(true);

    const notExists = await client.tableExists("nonexistent_table");
    expect(notExists).toBe(false);
  });

  test("should get table infos", async () => {
    const tables = await client.getTableInfos(TEST_DATABASE);

    expect(tables).toBeInstanceOf(Array);
    const testTable = tables.find((t) => t.name === "introspect_test");
    expect(testTable).toBeDefined();
    expect(testTable!.type).toContain("TABLE");
  });

  test("should get load jobs (may be empty)", async () => {
    const jobs = await client.getLoadJobs({
      database: TEST_DATABASE,
      limit: 10,
    });

    expect(jobs).toBeInstanceOf(Array);
    // May be empty if no load jobs have been run
  });
});
