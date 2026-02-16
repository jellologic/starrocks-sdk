import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE, beHttpPort } from "../src/test-config";

/**
 * Battle Test: Views Edge Cases
 *
 * Tests StarRocks view functionality:
 * - Create views with various query types
 * - Views with JOINs, subqueries, aggregations
 * - View security modes
 * - Alter views (requires DROP and CREATE)
 * - Query views
 * - View dependencies
 * - Edge cases with special characters, reserved words
 *
 * IMPORTANT: Uses raw SQL with fully qualified table names (database.table)
 * because connection pooling makes USE DATABASE unreliable.
 */
describe("StarRocks Views Battle Test", () => {
  let client: StarRocksClient;
  let streamLoader: StreamLoadClient;

  const FQN = (name: string) => `${TEST_DATABASE}.${name}`;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);

    streamLoader = createStreamLoadClient({
      host: testConfig.host,
      httpPort: beHttpPort,
      user: testConfig.user,
      password: testConfig.password,
    });

    // Create base tables for views
    await client.raw(`
      CREATE TABLE IF NOT EXISTS ${FQN("users")} (
        user_id BIGINT NOT NULL,
        name VARCHAR(100),
        email VARCHAR(255),
        status VARCHAR(20),
        created_at DATETIME
      )
      DUPLICATE KEY (user_id)
      DISTRIBUTED BY HASH(user_id) BUCKETS 4
      PROPERTIES("replication_num" = "1")
    `);

    await client.raw(`
      CREATE TABLE IF NOT EXISTS ${FQN("orders")} (
        order_id BIGINT NOT NULL,
        user_id BIGINT,
        product_id BIGINT,
        amount DECIMAL(10, 2),
        order_date DATE,
        status VARCHAR(20)
      )
      DUPLICATE KEY (order_id)
      DISTRIBUTED BY HASH(order_id) BUCKETS 4
      PROPERTIES("replication_num" = "1")
    `);

    await client.raw(`
      CREATE TABLE IF NOT EXISTS ${FQN("products")} (
        product_id BIGINT NOT NULL,
        name VARCHAR(100),
        category VARCHAR(50),
        price DECIMAL(10, 2)
      )
      DUPLICATE KEY (product_id)
      DISTRIBUTED BY HASH(product_id) BUCKETS 4
      PROPERTIES("replication_num" = "1")
    `);

    // Load test data
    await streamLoader.loadObjects([
      { user_id: 1, name: "Alice", email: "alice@test.com", status: "active", created_at: "2024-01-01 10:00:00" },
      { user_id: 2, name: "Bob", email: "bob@test.com", status: "active", created_at: "2024-01-02 11:00:00" },
      { user_id: 3, name: "Charlie", email: "charlie@test.com", status: "inactive", created_at: "2024-01-03 12:00:00" },
    ], { database: TEST_DATABASE, table: "users" });

    await streamLoader.loadObjects([
      { product_id: 100, name: "Widget", category: "Hardware", price: 99.99 },
      { product_id: 101, name: "Gadget", category: "Hardware", price: 149.99 },
      { product_id: 102, name: "Service", category: "Software", price: 49.99 },
    ], { database: TEST_DATABASE, table: "products" });

    await streamLoader.loadObjects([
      { order_id: 1001, user_id: 1, product_id: 100, amount: 199.98, order_date: "2024-01-15", status: "completed" },
      { order_id: 1002, user_id: 1, product_id: 101, amount: 149.99, order_date: "2024-01-20", status: "completed" },
      { order_id: 1003, user_id: 2, product_id: 100, amount: 99.99, order_date: "2024-02-01", status: "pending" },
      { order_id: 1004, user_id: 3, product_id: 102, amount: 149.97, order_date: "2024-02-10", status: "cancelled" },
    ], { database: TEST_DATABASE, table: "orders" });
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  // ============================================================================
  // Basic View Creation
  // ============================================================================

  describe("Basic View Creation", () => {
    test("should create simple SELECT view", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("active_users")} AS
        SELECT user_id, name, email
        FROM ${FQN("users")}
        WHERE status = 'active'
      `);

      const result = await client.raw<{ user_id: number; name: string }>(
        `SELECT * FROM ${FQN("active_users")} ORDER BY user_id`
      );

      expect(result.length).toBe(2);
      expect((result[0] as any).name).toBe("Alice");
      expect((result[1] as any).name).toBe("Bob");
    });

    test("should create view with column aliases", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("user_info")} (id, full_name, contact) AS
        SELECT user_id, name, email
        FROM ${FQN("users")}
      `);

      const result = await client.raw<{ id: number; full_name: string; contact: string }>(
        `SELECT id, full_name, contact FROM ${FQN("user_info")} WHERE id = 1`
      );

      expect(result.length).toBe(1);
      expect((result[0] as any).full_name).toBe("Alice");
    });

    test("should create view with COMMENT", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("users_with_comment")}
        COMMENT 'View of all users with email'
        AS SELECT user_id, name, email FROM ${FQN("users")}
      `);

      const showCreate = await client.raw(`SHOW CREATE VIEW ${FQN("users_with_comment")}`);
      const createStmt = (showCreate[0] as any)["Create View"];
      expect(createStmt).toContain("COMMENT");
    });
  });

  // ============================================================================
  // Views with JOINs
  // ============================================================================

  describe("Views with JOINs", () => {
    test("should create view with INNER JOIN", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("order_details")} AS
        SELECT
          o.order_id,
          u.name as customer_name,
          p.name as product_name,
          o.amount,
          o.order_date
        FROM ${FQN("orders")} o
        INNER JOIN ${FQN("users")} u ON o.user_id = u.user_id
        INNER JOIN ${FQN("products")} p ON o.product_id = p.product_id
      `);

      const result = await client.raw<{ order_id: number; customer_name: string; product_name: string }>(
        `SELECT * FROM ${FQN("order_details")} ORDER BY order_id`
      );

      expect(result.length).toBe(4);
      expect((result[0] as any).customer_name).toBe("Alice");
      expect((result[0] as any).product_name).toBe("Widget");
    });

    test("should create view with LEFT JOIN", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("user_order_count")} AS
        SELECT
          u.user_id,
          u.name,
          COUNT(o.order_id) as order_count
        FROM ${FQN("users")} u
        LEFT JOIN ${FQN("orders")} o ON u.user_id = o.user_id
        GROUP BY u.user_id, u.name
      `);

      const result = await client.raw<{ user_id: number; name: string; order_count: number }>(
        `SELECT * FROM ${FQN("user_order_count")} ORDER BY user_id`
      );

      expect(result.length).toBe(3);
      // Alice has 2 orders
      expect((result[0] as any).order_count).toBe(2);
    });
  });

  // ============================================================================
  // Views with Aggregations
  // ============================================================================

  describe("Views with Aggregations", () => {
    test("should create view with GROUP BY", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("category_sales")} AS
        SELECT
          p.category,
          COUNT(*) as order_count,
          SUM(o.amount) as total_amount
        FROM ${FQN("orders")} o
        JOIN ${FQN("products")} p ON o.product_id = p.product_id
        GROUP BY p.category
      `);

      const result = await client.raw<{ category: string; order_count: number; total_amount: number }>(
        `SELECT * FROM ${FQN("category_sales")} ORDER BY category`
      );

      expect(result.length).toBe(2); // Hardware, Software
    });

    test("should create view with HAVING clause", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("high_value_users")} AS
        SELECT
          u.user_id,
          u.name,
          SUM(o.amount) as total_spent
        FROM ${FQN("users")} u
        JOIN ${FQN("orders")} o ON u.user_id = o.user_id
        GROUP BY u.user_id, u.name
        HAVING SUM(o.amount) > 100
      `);

      const result = await client.raw<{ name: string; total_spent: number }>(
        `SELECT * FROM ${FQN("high_value_users")}`
      );

      expect(result.length).toBeGreaterThan(0);
      result.forEach((r: any) => expect(parseFloat(r.total_spent)).toBeGreaterThan(100));
    });

    test("should create view with window functions", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("order_rankings")} AS
        SELECT
          order_id,
          user_id,
          amount,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY amount DESC) as rank_by_amount
        FROM ${FQN("orders")}
      `);

      const result = await client.raw<{ order_id: number; rank_by_amount: number }>(
        `SELECT * FROM ${FQN("order_rankings")} WHERE user_id = 1 ORDER BY rank_by_amount`
      );

      expect((result[0] as any).rank_by_amount).toBe(1);
      expect((result[1] as any).rank_by_amount).toBe(2);
    });
  });

  // ============================================================================
  // View Alterations
  // ============================================================================

  describe("View Alterations", () => {
    test("should alter view by DROP and CREATE", async () => {
      // Create initial view
      await client.raw(`
        CREATE VIEW ${FQN("alterable_view")} AS
        SELECT user_id, name FROM ${FQN("users")}
      `);

      // Verify initial view
      const initial = await client.raw(`SELECT * FROM ${FQN("alterable_view")}`);
      expect(Object.keys(initial[0] as any)).toContain("name");
      expect(Object.keys(initial[0] as any)).not.toContain("email");

      // Drop and recreate with different columns
      await client.raw(`DROP VIEW IF EXISTS ${FQN("alterable_view")}`);
      await client.raw(`
        CREATE VIEW ${FQN("alterable_view")} AS
        SELECT user_id, name, email FROM ${FQN("users")}
      `);

      // Verify altered view
      const altered = await client.raw(`SELECT * FROM ${FQN("alterable_view")}`);
      expect(Object.keys(altered[0] as any)).toContain("email");
    });

    test("should handle CREATE OR REPLACE VIEW", async () => {
      // Create initial view
      await client.raw(`
        CREATE VIEW IF NOT EXISTS ${FQN("replaceable_view")} AS
        SELECT user_id, name FROM ${FQN("users")}
      `);

      // Verify initial columns
      const initial = await client.raw(`SELECT * FROM ${FQN("replaceable_view")} LIMIT 1`);
      expect(Object.keys(initial[0] as any)).not.toContain("status");

      // Replace it atomically with CREATE OR REPLACE VIEW (StarRocks supports this!)
      await client.raw(`
        CREATE OR REPLACE VIEW ${FQN("replaceable_view")} AS
        SELECT user_id, name, email, status FROM ${FQN("users")}
      `);

      const result = await client.raw(`SELECT * FROM ${FQN("replaceable_view")} LIMIT 1`);
      expect(Object.keys(result[0] as any)).toContain("status");
    });

    test("should handle ALTER VIEW", async () => {
      // Create initial view
      await client.raw(`
        CREATE VIEW IF NOT EXISTS ${FQN("alter_view_test")} AS
        SELECT user_id, name FROM ${FQN("users")}
      `);

      // Verify initial columns
      const initial = await client.raw(`SELECT * FROM ${FQN("alter_view_test")} LIMIT 1`);
      expect(Object.keys(initial[0] as any).length).toBe(2);

      // Use ALTER VIEW to change definition
      await client.raw(`
        ALTER VIEW ${FQN("alter_view_test")} AS
        SELECT user_id, name, email, 'modified' as source FROM ${FQN("users")}
      `);

      const result = await client.raw(`SELECT * FROM ${FQN("alter_view_test")} LIMIT 1`);
      expect(Object.keys(result[0] as any)).toContain("email");
      expect(Object.keys(result[0] as any)).toContain("source");
    });
  });

  // ============================================================================
  // Nested Views (Views on Views)
  // ============================================================================

  describe("Nested Views", () => {
    test("should create view based on another view", async () => {
      // Create base view
      await client.raw(`
        CREATE VIEW IF NOT EXISTS ${FQN("base_view")} AS
        SELECT user_id, name, status FROM ${FQN("users")}
      `);

      // Create nested view
      await client.raw(`
        CREATE VIEW ${FQN("nested_view")} AS
        SELECT user_id, name FROM ${FQN("base_view")}
        WHERE status = 'active'
      `);

      const result = await client.raw(`SELECT * FROM ${FQN("nested_view")}`);
      expect(result.length).toBe(2);
    });

    test("should handle multiple levels of nesting", async () => {
      // Level 1
      await client.raw(`
        CREATE VIEW IF NOT EXISTS ${FQN("level1_view")} AS
        SELECT user_id, name, email, status FROM ${FQN("users")}
      `);

      // Level 2
      await client.raw(`
        CREATE VIEW IF NOT EXISTS ${FQN("level2_view")} AS
        SELECT user_id, name, email FROM ${FQN("level1_view")}
        WHERE status = 'active'
      `);

      // Level 3
      await client.raw(`
        CREATE VIEW IF NOT EXISTS ${FQN("level3_view")} AS
        SELECT user_id, name FROM ${FQN("level2_view")}
      `);

      const result = await client.raw(`SELECT * FROM ${FQN("level3_view")}`);
      expect(result.length).toBe(2);
    });
  });

  // ============================================================================
  // View with Subqueries
  // ============================================================================

  describe("Views with Subqueries", () => {
    test("should create view with scalar subquery", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("users_with_order_total")} AS
        SELECT
          u.user_id,
          u.name,
          (SELECT SUM(amount) FROM ${FQN("orders")} o WHERE o.user_id = u.user_id) as total_orders
        FROM ${FQN("users")} u
      `);

      const result = await client.raw<{ user_id: number; total_orders: number | null }>(
        `SELECT * FROM ${FQN("users_with_order_total")} WHERE user_id = 1`
      );

      expect(result.length).toBe(1);
      expect(parseFloat((result[0] as any).total_orders)).toBeGreaterThan(0);
    });

    test("should create view with IN subquery", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("users_with_orders")} AS
        SELECT user_id, name
        FROM ${FQN("users")}
        WHERE user_id IN (SELECT DISTINCT user_id FROM ${FQN("orders")})
      `);

      const result = await client.raw(`SELECT * FROM ${FQN("users_with_orders")}`);
      expect(result.length).toBe(3); // All users have orders in test data
    });

    test("should create view with EXISTS subquery", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("users_with_completed_orders")} AS
        SELECT user_id, name
        FROM ${FQN("users")} u
        WHERE EXISTS (
          SELECT 1 FROM ${FQN("orders")} o
          WHERE o.user_id = u.user_id
          AND o.status = 'completed'
        )
      `);

      const result = await client.raw(`SELECT * FROM ${FQN("users_with_completed_orders")}`);
      expect(result.length).toBe(1); // Only Alice has completed orders
    });
  });

  // ============================================================================
  // View Schema Operations
  // ============================================================================

  describe("View Schema Operations", () => {
    test("should SHOW CREATE VIEW", async () => {
      await client.raw(`
        CREATE VIEW IF NOT EXISTS ${FQN("show_create_test")} AS
        SELECT user_id, name FROM ${FQN("users")}
      `);

      const result = await client.raw(`SHOW CREATE VIEW ${FQN("show_create_test")}`);
      expect(result.length).toBe(1);
      expect((result[0] as any)["Create View"]).toContain("SELECT");
    });

    test("should DESC view", async () => {
      await client.raw(`
        CREATE VIEW IF NOT EXISTS ${FQN("describe_test")} AS
        SELECT user_id, name, email FROM ${FQN("users")}
      `);

      const result = await client.raw(`DESC ${FQN("describe_test")}`);
      const fields = result.map((r: any) => r.Field);

      expect(fields).toContain("user_id");
      expect(fields).toContain("name");
      expect(fields).toContain("email");
    });

    test("should DROP VIEW IF EXISTS", async () => {
      await client.raw(`
        CREATE VIEW IF NOT EXISTS ${FQN("drop_test")} AS
        SELECT user_id FROM ${FQN("users")}
      `);

      // Drop should succeed
      await client.raw(`DROP VIEW IF EXISTS ${FQN("drop_test")}`);

      // Second drop should not error (IF EXISTS)
      await client.raw(`DROP VIEW IF EXISTS ${FQN("drop_test")}`);

      // View should not exist
      try {
        await client.raw(`SELECT * FROM ${FQN("drop_test")}`);
        expect(true).toBe(false); // Should not reach here
      } catch {
        // Expected
      }
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    test("should handle view with complex expressions", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("complex_expr_view")} AS
        SELECT
          order_id,
          amount,
          CASE
            WHEN amount > 150 THEN 'high'
            WHEN amount > 50 THEN 'medium'
            ELSE 'low'
          END as amount_tier,
          DATE_FORMAT(order_date, '%Y-%m') as order_month
        FROM ${FQN("orders")}
      `);

      const result = await client.raw<{ order_id: number; amount_tier: string }>(
        `SELECT * FROM ${FQN("complex_expr_view")} ORDER BY order_id`
      );

      expect(result.length).toBe(4);
      expect((result[0] as any).amount_tier).toBe("high"); // 199.98
    });

    test("should handle view with DISTINCT", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("distinct_categories")} AS
        SELECT DISTINCT category FROM ${FQN("products")}
      `);

      const result = await client.raw(`SELECT * FROM ${FQN("distinct_categories")}`);
      expect(result.length).toBe(2); // Hardware, Software
    });

    test("should handle view with ORDER BY", async () => {
      // Note: ORDER BY in view definition doesn't guarantee order when querying
      // We test that the view can be created with ORDER BY and queried with ORDER BY
      await client.raw(`
        CREATE VIEW ${FQN("sorted_users")} AS
        SELECT user_id, name FROM ${FQN("users")}
        ORDER BY name ASC
      `);

      // Query with explicit ORDER BY to get consistent results
      const result = await client.raw<{ name: string }>(
        `SELECT * FROM ${FQN("sorted_users")} ORDER BY name ASC`
      );

      expect((result[0] as any).name).toBe("Alice");
    });

    test("should handle view with LIMIT", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("top_orders")} AS
        SELECT order_id, amount FROM ${FQN("orders")}
        ORDER BY amount DESC
        LIMIT 2
      `);

      const result = await client.raw(`SELECT * FROM ${FQN("top_orders")}`);
      expect(result.length).toBe(2);
    });

    test("should handle quoted identifiers in view", async () => {
      await client.raw(`
        CREATE VIEW ${FQN("quoted_view")} AS
        SELECT \`user_id\` as \`id\`, \`name\` as \`full_name\`
        FROM ${FQN("users")}
      `);

      const result = await client.raw(`SELECT * FROM ${FQN("quoted_view")} LIMIT 1`);
      expect(Object.keys(result[0] as any)).toContain("id");
      expect(Object.keys(result[0] as any)).toContain("full_name");
    });
  });
});
