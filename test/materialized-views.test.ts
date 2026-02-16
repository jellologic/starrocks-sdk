import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, type StarRocksClient, MaterializedViewManager } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import type { TableOptions } from "../src/types";

describe("StarRocks Materialized Views", () => {
  let client: StarRocksClient;
  let mvManager: MaterializedViewManager;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);
    await client.useDatabase(TEST_DATABASE);

    mvManager = client.materializedViews;

    // Create base tables for materialized views
    const ordersOptions: TableOptions = {
      keyType: "DUPLICATE",
      keys: ["order_date", "order_id"],
      distribution: {
        type: "HASH",
        columns: ["order_id"],
        buckets: 4,
      },
      properties: {
        replication_num: 1,
      },
    };

    await client.createTable(
      "orders",
      [
        { name: "order_date", type: "DATE", nullable: false },
        { name: "order_id", type: "BIGINT", nullable: false },
        { name: "customer_id", type: "BIGINT" },
        { name: "amount", type: "DECIMAL", precision: 10, scale: 2 },
        { name: "status", type: "VARCHAR", length: 32 },
      ],
      ordersOptions
    );

    const productsOptions: TableOptions = {
      keyType: "PRIMARY",
      keys: ["product_id"],
      distribution: {
        type: "HASH",
        columns: ["product_id"],
        buckets: 4,
      },
      properties: {
        replication_num: 1,
      },
    };

    await client.createTable(
      "products",
      [
        { name: "product_id", type: "BIGINT", nullable: false },
        { name: "name", type: "VARCHAR", length: 255 },
        { name: "price", type: "DECIMAL", precision: 10, scale: 2 },
        { name: "category", type: "VARCHAR", length: 64 },
      ],
      productsOptions
    );

    // Insert some test data
    await client.insertMany("orders", [
      { order_date: "2024-01-01", order_id: 1, customer_id: 100, amount: 150.00, status: "completed" },
      { order_date: "2024-01-01", order_id: 2, customer_id: 101, amount: 250.00, status: "completed" },
      { order_date: "2024-01-02", order_id: 3, customer_id: 100, amount: 100.00, status: "pending" },
      { order_date: "2024-01-02", order_id: 4, customer_id: 102, amount: 300.00, status: "completed" },
    ]);

    await client.insertMany("products", [
      { product_id: 1, name: "Widget A", price: 29.99, category: "widgets" },
      { product_id: 2, name: "Widget B", price: 49.99, category: "widgets" },
      { product_id: 3, name: "Gadget X", price: 99.99, category: "gadgets" },
    ]);
  });

  afterAll(async () => {
    // Clean up MVs first
    await mvManager.drop("daily_sales_mv").catch(() => {});
    await mvManager.drop("customer_totals_mv").catch(() => {});
    await mvManager.drop("simple_mv").catch(() => {});

    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  test("should create a simple materialized view with MANUAL refresh", async () => {
    await mvManager.create({
      name: "simple_mv",
      query: `SELECT product_id, name, price FROM products WHERE price > 30`,
      distribution: {
        type: "HASH",
        columns: ["product_id"],
        buckets: 4,
      },
      refresh: {
        type: "MANUAL",
      },
      properties: {
        replication_num: 1,
      },
    });

    // Verify MV was created
    const mvList = await mvManager.list("simple_mv");
    expect(mvList.length).toBeGreaterThanOrEqual(1);

    const mv = mvList.find(m => m.name === "simple_mv");
    expect(mv).toBeDefined();
  });

  test("should create aggregation materialized view", async () => {
    await mvManager.create({
      name: "daily_sales_mv",
      query: `
        SELECT
          order_date,
          COUNT(*) as order_count,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount
        FROM orders
        GROUP BY order_date
      `,
      distribution: {
        type: "HASH",
        columns: ["order_date"],
        buckets: 4,
      },
      refresh: {
        type: "MANUAL",
      },
      properties: {
        replication_num: 1,
      },
      comment: "Daily sales aggregation",
    });

    // Verify MV was created
    const mvs = await mvManager.list("daily_sales%");
    expect(mvs.some(m => m.name === "daily_sales_mv")).toBe(true);
  });

  test("should create materialized view with ASYNC refresh", async () => {
    await mvManager.create({
      name: "customer_totals_mv",
      query: `
        SELECT
          customer_id,
          COUNT(*) as order_count,
          SUM(amount) as total_spent
        FROM orders
        GROUP BY customer_id
      `,
      distribution: {
        type: "HASH",
        columns: ["customer_id"],
        buckets: 4,
      },
      refresh: {
        type: "ASYNC",
        every: {
          value: 1,
          unit: "HOUR",
        },
      },
      properties: {
        replication_num: 1,
      },
    });

    const mvs = await mvManager.list("customer_totals%");
    expect(mvs.some(m => m.name === "customer_totals_mv")).toBe(true);
  });

  test("should refresh materialized view manually", async () => {
    // Refresh the simple MV
    await mvManager.refresh("simple_mv");

    // Give it a moment to process
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Query the MV directly
    const rows = await client.raw<{ product_id: number; name: string }>(
      "SELECT * FROM simple_mv ORDER BY product_id"
    );

    // Should have products with price > 30
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test("should show CREATE statement for materialized view", async () => {
    const createStmt = await mvManager.showCreate("simple_mv");

    expect(createStmt).toContain("CREATE MATERIALIZED VIEW");
    expect(createStmt).toContain("simple_mv");
    expect(createStmt.toLowerCase()).toContain("select");
  });

  test("should list all materialized views", async () => {
    const mvs = await mvManager.list();

    expect(mvs).toBeInstanceOf(Array);
    expect(mvs.length).toBeGreaterThanOrEqual(1);

    // Each MV should have required fields
    for (const mv of mvs) {
      expect(mv.name).toBeTruthy();
      expect(typeof mv.isActive).toBe("boolean");
    }
  });

  test("should list materialized views with pattern", async () => {
    const mvs = await mvManager.list("%_mv");

    expect(mvs).toBeInstanceOf(Array);
    // Should find our test MVs
    const names = mvs.map(m => m.name);
    expect(names.some(n => n.endsWith("_mv"))).toBe(true);
  });

  test("should alter materialized view refresh interval", async () => {
    await mvManager.alter("customer_totals_mv", {
      refresh: {
        type: "ASYNC",
        every: {
          value: 2,
          unit: "HOUR",
        },
      },
    });

    // Verify change by checking the MV
    const createStmt = await mvManager.showCreate("customer_totals_mv");
    expect(createStmt.toLowerCase()).toContain("refresh");
  });

  test("should query materialized view after refresh", async () => {
    // Refresh daily_sales_mv
    await mvManager.refresh("daily_sales_mv");

    // Wait for refresh
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Query the MV
    const rows = await client.raw<{ order_date: string; order_count: number; total_amount: number }>(
      "SELECT * FROM daily_sales_mv ORDER BY order_date"
    );

    expect(rows).toBeInstanceOf(Array);
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty("order_count");
      expect(rows[0]).toHaveProperty("total_amount");
    }
  });

  test("should get refresh task history", async () => {
    // This may return empty if no tasks have run yet
    const tasks = await mvManager.getRefreshTasks("simple_mv", { limit: 5 });

    expect(tasks).toBeInstanceOf(Array);
    // Tasks may be empty for manual refresh MVs that haven't been refreshed
  });

  test("should drop materialized view", async () => {
    // Create a temporary MV to drop - must reference a real base table
    await mvManager.create({
      name: "temp_mv_to_drop",
      query: "SELECT product_id, name FROM products LIMIT 10",
      distribution: {
        type: "HASH",
        columns: ["product_id"],
        buckets: 4,
      },
      refresh: { type: "MANUAL" },
      properties: { replication_num: 1 },
    });

    // Verify it exists
    let mvs = await mvManager.list("temp_mv_to_drop");
    expect(mvs.length).toBe(1);

    // Drop it
    await mvManager.drop("temp_mv_to_drop");

    // Verify it's gone
    mvs = await mvManager.list("temp_mv_to_drop");
    expect(mvs.length).toBe(0);
  });

  test("should handle drop with IF EXISTS for non-existent MV", async () => {
    // Should not throw
    await mvManager.drop("nonexistent_mv_12345", true);
  });
});
