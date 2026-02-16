import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, type StarRocksClient } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import type { TableOptions } from "../src/types";

describe("StarRocks Insert Operations", () => {
  let client: StarRocksClient;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);
    await client.useDatabase(TEST_DATABASE);

    // Create test table
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

    await client.createTable(
      "insert_test",
      [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "name", type: "VARCHAR", length: 255 },
        { name: "value", type: "DOUBLE" },
        { name: "created_at", type: "DATETIME" },
      ],
      options
    );
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  test("should insert a single row", async () => {
    await client.insert("insert_test", {
      id: 1,
      name: "test1",
      value: 100.5,
      created_at: new Date("2024-01-01T00:00:00Z"),
    });

    const rows = await client.raw<{ id: number; name: string }>(
      "SELECT * FROM insert_test WHERE id = 1"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("test1");
  });

  test("should insert multiple rows", async () => {
    await client.insertMany("insert_test", [
      { id: 2, name: "test2", value: 200.5 },
      { id: 3, name: "test3", value: 300.5 },
      { id: 4, name: "test4", value: 400.5 },
    ]);

    const rows = await client.raw<{ id: number }>(
      "SELECT * FROM insert_test WHERE id IN (2, 3, 4)"
    );
    expect(rows).toHaveLength(3);
  });

  test("should insert from SELECT", async () => {
    // Create source table
    await client.createTable(
      "insert_source",
      [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "name", type: "VARCHAR", length: 255 },
        { name: "value", type: "DOUBLE" },
      ],
      {
        keyType: "PRIMARY",
        keys: ["id"],
        distribution: { type: "HASH", columns: ["id"], buckets: 4 },
        properties: { replication_num: 1 },
      }
    );

    await client.insertMany("insert_source", [
      { id: 10, name: "source1", value: 1000 },
      { id: 11, name: "source2", value: 1100 },
    ]);

    // Insert from SELECT
    await client.insertSelect(
      "insert_test",
      "SELECT id, name, value, NOW() as created_at FROM insert_source",
      { columns: ["id", "name", "value", "created_at"] }
    );

    const rows = await client.raw<{ id: number }>(
      "SELECT * FROM insert_test WHERE id IN (10, 11)"
    );
    expect(rows).toHaveLength(2);

    await client.dropTable("insert_source");
  });

  test("should handle NULL values correctly", async () => {
    await client.insert("insert_test", {
      id: 100,
      name: null,
      value: null,
      created_at: null,
    });

    const rows = await client.raw<{ id: number; name: string | null }>(
      "SELECT * FROM insert_test WHERE id = 100"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBeNull();
  });

  test("should escape special characters in strings", async () => {
    await client.insert("insert_test", {
      id: 101,
      name: "test's \"value\"",
      value: 999,
    });

    const rows = await client.raw<{ name: string }>(
      "SELECT name FROM insert_test WHERE id = 101"
    );
    expect(rows[0]!.name).toBe("test's \"value\"");
  });
});
