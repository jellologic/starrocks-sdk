import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, type StarRocksClient } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";

describe("StarRocks Connection", () => {
  let client: StarRocksClient;

  beforeAll(() => {
    client = createStarRocksClient(testConfig);
  });

  afterAll(async () => {
    await client.close();
  });

  test("should connect and execute raw query", async () => {
    const result = await client.raw<{ "1": number }>("SELECT 1");
    expect(result).toHaveLength(1);
    expect(result[0]!["1"]).toBe(1);
  });

  test("should show databases", async () => {
    const databases = await client.showDatabases();
    expect(databases).toBeInstanceOf(Array);
    expect(databases).toContain("information_schema");
  });

  test("should create and drop test database", async () => {
    await client.createDatabase(TEST_DATABASE);

    const databases = await client.showDatabases();
    expect(databases).toContain(TEST_DATABASE);

    await client.dropDatabase(TEST_DATABASE);

    const afterDrop = await client.showDatabases();
    expect(afterDrop).not.toContain(TEST_DATABASE);
  });
});
