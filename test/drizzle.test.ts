import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, type StarRocksClient } from "../src";
import { sql } from "../src/drizzle-schema";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import type { ColumnDef, LegacyTableOptions } from "../src/types";

describe("StarRocks Drizzle Integration", () => {
  let client: StarRocksClient;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);
    await client.useDatabase(TEST_DATABASE);

    // Create a test table
    const columns: ColumnDef[] = [
      { name: "id", type: "BIGINT", nullable: false },
      { name: "name", type: "VARCHAR", length: 255 },
      { name: "value", type: "INT" },
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

    await client.createTable("test_items", columns, options);
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  test("should insert data using raw SQL", async () => {
    await client.execute("INSERT INTO test_items (id, name, value) VALUES (1, 'item1', 100)");
    await client.execute("INSERT INTO test_items (id, name, value) VALUES (2, 'item2', 200)");

    const rows = await client.raw<{ id: number; name: string; value: number }>(
      "SELECT * FROM test_items ORDER BY id"
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe("item1");
    expect(rows[1]!.value).toBe(200);
  });

  test("should use drizzle db for queries", async () => {
    const db = client.db;

    // Use Drizzle's sql template for raw queries
    const result = await db.execute(sql`SELECT COUNT(*) as cnt FROM test_items`);
    expect(result).toBeDefined();
  });

  test("should update data", async () => {
    await client.execute("UPDATE test_items SET value = 150 WHERE id = 1");

    const rows = await client.raw<{ id: number; value: number }>(
      "SELECT value FROM test_items WHERE id = 1"
    );

    expect(rows[0]!.value).toBe(150);
  });

  test("should delete data", async () => {
    await client.execute("DELETE FROM test_items WHERE id = 2");

    const rows = await client.raw<{ id: number }>("SELECT * FROM test_items");
    expect(rows).toHaveLength(1);
  });
});
