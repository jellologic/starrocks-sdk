import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE, beHttpPort } from "../src/test-config";

/**
 * Battle Test: Query Edge Cases
 *
 * Tests StarRocks query features:
 * - Window functions
 * - Complex JOINs
 * - Subqueries and CTEs
 * - OLAP-specific functions
 * - GROUP BY extensions (ROLLUP, CUBE)
 * - Query optimization hints
 * - Large result sets
 *
 * IMPORTANT: Uses raw SQL with fully qualified table names (database.table)
 * because connection pooling makes USE DATABASE unreliable.
 */
describe("StarRocks Query Edge Cases", () => {
  let client: StarRocksClient;
  let streamLoader: StreamLoadClient;

  const FQN = (table: string) => `${TEST_DATABASE}.${table}`;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);

    streamLoader = createStreamLoadClient({
      host: testConfig.host,
      httpPort: beHttpPort,
      user: testConfig.user,
      password: testConfig.password,
    });
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  // ============================================================================
  // Window Functions
  // ============================================================================

  describe("Window Functions", () => {
    const TABLE = "window_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          dept VARCHAR(50) NOT NULL,
          employee VARCHAR(100) NOT NULL,
          salary INT,
          hire_date DATE
        )
        DUPLICATE KEY (dept, employee)
        DISTRIBUTED BY HASH(dept) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      await streamLoader.loadObjects([
        { dept: "Sales", employee: "Alice", salary: 50000, hire_date: "2020-01-15" },
        { dept: "Sales", employee: "Bob", salary: 60000, hire_date: "2019-03-20" },
        { dept: "Sales", employee: "Charlie", salary: 55000, hire_date: "2021-06-01" },
        { dept: "Engineering", employee: "David", salary: 80000, hire_date: "2018-02-10" },
        { dept: "Engineering", employee: "Eve", salary: 90000, hire_date: "2017-11-05" },
        { dept: "Engineering", employee: "Frank", salary: 75000, hire_date: "2022-01-15" },
        { dept: "HR", employee: "Grace", salary: 45000, hire_date: "2020-08-20" },
      ], {
        database: TEST_DATABASE,
        table: TABLE,
      });
    });

    test("should calculate ROW_NUMBER", async () => {
      const result = await client.raw<{ dept: string; employee: string; rn: number }>(
        `SELECT dept, employee,
                ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) as rn
         FROM ${FQN(TABLE)}
         ORDER BY dept, rn`
      );

      expect(result.length).toBe(7);

      // Engineering: Eve(90k)=1, David(80k)=2, Frank(75k)=3
      const engRows = result.filter((r: any) => r.dept === "Engineering");
      expect((engRows[0] as any).employee).toBe("Eve");
      expect((engRows[0] as any).rn).toBe(1);
    });

    test("should calculate RANK with ties", async () => {
      // Add duplicate salary for testing ties
      await streamLoader.loadObjects([
        { dept: "Sales", employee: "Zack", salary: 60000, hire_date: "2023-01-01" },
      ], {
        database: TEST_DATABASE,
        table: TABLE,
      });

      const result = await client.raw<{ employee: string; rnk: number }>(
        `SELECT employee,
                RANK() OVER (PARTITION BY dept ORDER BY salary DESC) as rnk
         FROM ${FQN(TABLE)}
         WHERE dept = 'Sales'
         ORDER BY rnk, employee`
      );

      // Bob and Zack both have 60000 - should be rank 1 (tied)
      const rank1 = result.filter((r: any) => r.rnk === 1);
      expect(rank1.length).toBe(2);
    });

    test("should calculate DENSE_RANK", async () => {
      const result = await client.raw<{ employee: string; dense_rnk: number }>(
        `SELECT employee,
                DENSE_RANK() OVER (PARTITION BY dept ORDER BY salary DESC) as dense_rnk
         FROM ${FQN(TABLE)}
         WHERE dept = 'Sales'
         ORDER BY dense_rnk, employee`
      );

      // After rank 1 (Bob, Zack at 60k), next should be dense_rank 2 (not 3)
      expect(result.some((r: any) => r.dense_rnk === 2)).toBe(true);
    });

    test("should calculate running totals with SUM OVER", async () => {
      const result = await client.raw<{ employee: string; salary: number; running_total: number }>(
        `SELECT employee, salary,
                SUM(salary) OVER (PARTITION BY dept ORDER BY hire_date) as running_total
         FROM ${FQN(TABLE)}
         WHERE dept = 'Engineering'
         ORDER BY hire_date`
      );

      // Eve (2017), David (2018), Frank (2022)
      expect((result[0] as any).running_total).toBe(90000); // Eve only
      expect((result[1] as any).running_total).toBe(170000); // Eve + David
      expect((result[2] as any).running_total).toBe(245000); // Eve + David + Frank
    });

    test("should calculate LAG and LEAD", async () => {
      const result = await client.raw<{
        employee: string;
        salary: number;
        prev_salary: number | null;
        next_salary: number | null;
      }>(
        `SELECT employee, salary,
                LAG(salary, 1) OVER (PARTITION BY dept ORDER BY hire_date) as prev_salary,
                LEAD(salary, 1) OVER (PARTITION BY dept ORDER BY hire_date) as next_salary
         FROM ${FQN(TABLE)}
         WHERE dept = 'Engineering'
         ORDER BY hire_date`
      );

      // First person has no prev
      expect((result[0] as any).prev_salary).toBeNull();
      expect((result[0] as any).next_salary).toBe(80000);

      // Last person has no next
      expect((result[2] as any).next_salary).toBeNull();
    });

    test("should calculate FIRST_VALUE and LAST_VALUE", async () => {
      const result = await client.raw<{
        employee: string;
        first_emp: string;
        last_emp: string;
      }>(
        `SELECT employee,
                FIRST_VALUE(employee) OVER (PARTITION BY dept ORDER BY hire_date) as first_emp,
                LAST_VALUE(employee) OVER (
                  PARTITION BY dept ORDER BY hire_date
                  ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                ) as last_emp
         FROM ${FQN(TABLE)}
         WHERE dept = 'Engineering'
         ORDER BY hire_date`
      );

      // All rows should show Eve as first (earliest) and Frank as last (latest)
      result.forEach((r: any) => {
        expect(r.first_emp).toBe("Eve");
        expect(r.last_emp).toBe("Frank");
      });
    });

    test("should calculate NTILE", async () => {
      const result = await client.raw<{ employee: string; quartile: number }>(
        `SELECT employee,
                NTILE(4) OVER (ORDER BY salary DESC) as quartile
         FROM ${FQN(TABLE)}
         ORDER BY salary DESC`
      );

      // Top earner should be in quartile 1
      expect((result[0] as any).quartile).toBe(1);
      // Bottom earner should be in quartile 4
      expect((result[result.length - 1] as any).quartile).toBe(4);
    });
  });

  // ============================================================================
  // Complex JOINs
  // ============================================================================

  describe("Complex JOINs", () => {
    beforeAll(async () => {
      // Create tables for JOIN tests
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("orders")} (
          order_id BIGINT NOT NULL,
          customer_id BIGINT,
          product_id BIGINT,
          amount DECIMAL(10, 2),
          order_date DATE
        )
        DUPLICATE KEY (order_id)
        DISTRIBUTED BY HASH(order_id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN("customers")} (
          customer_id BIGINT NOT NULL,
          name VARCHAR(100),
          region VARCHAR(50)
        )
        DUPLICATE KEY (customer_id)
        DISTRIBUTED BY HASH(customer_id) BUCKETS 4
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

      // Load data
      await streamLoader.loadObjects([
        { customer_id: 1, name: "Acme Corp", region: "US" },
        { customer_id: 2, name: "Beta Inc", region: "EU" },
        { customer_id: 3, name: "Gamma LLC", region: "US" },
      ], { database: TEST_DATABASE, table: "customers" });

      await streamLoader.loadObjects([
        { product_id: 100, name: "Widget", category: "Hardware", price: 99.99 },
        { product_id: 101, name: "Gadget", category: "Hardware", price: 149.99 },
        { product_id: 102, name: "Service", category: "Software", price: 49.99 },
      ], { database: TEST_DATABASE, table: "products" });

      await streamLoader.loadObjects([
        { order_id: 1001, customer_id: 1, product_id: 100, amount: 199.98, order_date: "2024-01-15" },
        { order_id: 1002, customer_id: 1, product_id: 101, amount: 449.97, order_date: "2024-01-20" },
        { order_id: 1003, customer_id: 2, product_id: 100, amount: 99.99, order_date: "2024-02-01" },
        { order_id: 1004, customer_id: 3, product_id: 102, amount: 149.97, order_date: "2024-02-10" },
      ], { database: TEST_DATABASE, table: "orders" });
    });

    test("should handle multi-table JOIN", async () => {
      const result = await client.raw<{ customer_name: string; product_name: string; amount: number }>(
        `SELECT c.name as customer_name, p.name as product_name, o.amount
         FROM ${FQN("orders")} o
         JOIN ${FQN("customers")} c ON o.customer_id = c.customer_id
         JOIN ${FQN("products")} p ON o.product_id = p.product_id
         ORDER BY o.order_id`
      );

      expect(result.length).toBe(4);
      expect((result[0] as any).customer_name).toBe("Acme Corp");
      expect((result[0] as any).product_name).toBe("Widget");
    });

    test("should handle LEFT OUTER JOIN", async () => {
      // Add customer with no orders
      await streamLoader.loadObjects([
        { customer_id: 4, name: "Delta Co", region: "APAC" },
      ], { database: TEST_DATABASE, table: "customers" });

      const result = await client.raw<{ name: string; order_count: number }>(
        `SELECT c.name, COUNT(o.order_id) as order_count
         FROM ${FQN("customers")} c
         LEFT JOIN ${FQN("orders")} o ON c.customer_id = o.customer_id
         GROUP BY c.name
         ORDER BY c.name`
      );

      // Delta Co should have 0 orders
      const delta = result.find((r: any) => r.name === "Delta Co");
      expect((delta as any).order_count).toBe(0);
    });

    test("should handle self-JOIN", async () => {
      // Find pairs of orders from same customer
      const result = await client.raw<{ order1: number; order2: number }>(
        `SELECT o1.order_id as order1, o2.order_id as order2
         FROM ${FQN("orders")} o1
         JOIN ${FQN("orders")} o2 ON o1.customer_id = o2.customer_id
         WHERE o1.order_id < o2.order_id
         ORDER BY o1.order_id, o2.order_id`
      );

      // Acme Corp (customer_id=1) has orders 1001 and 1002
      expect(result.length).toBe(1);
      expect((result[0] as any).order1).toBe(1001);
      expect((result[0] as any).order2).toBe(1002);
    });

    test("should handle CROSS JOIN", async () => {
      const result = await client.raw<{ cnt: number }>(
        `SELECT COUNT(*) as cnt
         FROM ${FQN("customers")} c
         CROSS JOIN ${FQN("products")} p
         WHERE c.region = 'US'`
      );

      // 2 US customers × 3 products = 6
      expect((result[0] as any).cnt).toBe(6);
    });
  });

  // ============================================================================
  // Subqueries and CTEs
  // ============================================================================

  describe("Subqueries and CTEs", () => {
    test("should handle scalar subquery", async () => {
      const result = await client.raw<{ name: string }>(
        `SELECT name FROM ${FQN("customers")}
         WHERE customer_id IN (
           SELECT customer_id FROM ${FQN("orders")}
           WHERE amount > 200
         )`
      );

      expect(result.length).toBeGreaterThan(0);
    });

    test("should handle correlated subquery", async () => {
      const result = await client.raw<{ name: string; order_count: number }>(
        `SELECT c.name,
                (SELECT COUNT(*) FROM ${FQN("orders")} o WHERE o.customer_id = c.customer_id) as order_count
         FROM ${FQN("customers")} c
         ORDER BY c.name`
      );

      const acme = result.find((r: any) => r.name === "Acme Corp");
      expect((acme as any).order_count).toBe(2);
    });

    test("should handle CTE (WITH clause)", async () => {
      const result = await client.raw<{ region: string; total: number }>(
        `WITH regional_sales AS (
           SELECT c.region, SUM(o.amount) as total
           FROM ${FQN("orders")} o
           JOIN ${FQN("customers")} c ON o.customer_id = c.customer_id
           GROUP BY c.region
         )
         SELECT * FROM regional_sales
         ORDER BY total DESC`
      );

      expect(result.length).toBe(2); // US and EU
    });

    test("should handle multiple CTEs", async () => {
      const result = await client.raw<{ category: string; total_amount: number }>(
        `WITH customer_orders AS (
           SELECT o.*, c.region
           FROM ${FQN("orders")} o
           JOIN ${FQN("customers")} c ON o.customer_id = c.customer_id
         ),
         product_sales AS (
           SELECT p.category, SUM(co.amount) as total_amount
           FROM customer_orders co
           JOIN ${FQN("products")} p ON co.product_id = p.product_id
           GROUP BY p.category
         )
         SELECT * FROM product_sales
         ORDER BY total_amount DESC`
      );

      expect(result.length).toBe(2); // Hardware and Software
    });

    test("should handle EXISTS subquery", async () => {
      const result = await client.raw<{ name: string }>(
        `SELECT name FROM ${FQN("customers")} c
         WHERE EXISTS (
           SELECT 1 FROM ${FQN("orders")} o
           WHERE o.customer_id = c.customer_id
           AND o.amount > 100
         )
         ORDER BY name`
      );

      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // GROUP BY Extensions
  // ============================================================================

  describe("GROUP BY Extensions", () => {
    test("should handle GROUP BY ROLLUP", async () => {
      const result = await client.raw<{ region: string | null; category: string | null; total: number }>(
        `SELECT c.region, p.category, SUM(o.amount) as total
         FROM ${FQN("orders")} o
         JOIN ${FQN("customers")} c ON o.customer_id = c.customer_id
         JOIN ${FQN("products")} p ON o.product_id = p.product_id
         GROUP BY ROLLUP(c.region, p.category)
         ORDER BY c.region, p.category`
      );

      // Should have subtotals (region, NULL) and grand total (NULL, NULL)
      const grandTotal = result.find((r: any) => r.region === null && r.category === null);
      expect(grandTotal).toBeDefined();
    });

    test("should handle GROUP BY CUBE", async () => {
      const result = await client.raw<{ region: string | null; category: string | null; total: number }>(
        `SELECT c.region, p.category, SUM(o.amount) as total
         FROM ${FQN("orders")} o
         JOIN ${FQN("customers")} c ON o.customer_id = c.customer_id
         JOIN ${FQN("products")} p ON o.product_id = p.product_id
         GROUP BY CUBE(c.region, p.category)
         ORDER BY c.region, p.category`
      );

      // Should have all combinations including (NULL, category) subtotals
      expect(result.length).toBeGreaterThan(4);
    });

    test("should handle GROUPING SETS", async () => {
      const result = await client.raw<{ region: string | null; category: string | null; total: number }>(
        `SELECT c.region, p.category, SUM(o.amount) as total
         FROM ${FQN("orders")} o
         JOIN ${FQN("customers")} c ON o.customer_id = c.customer_id
         JOIN ${FQN("products")} p ON o.product_id = p.product_id
         GROUP BY GROUPING SETS (
           (c.region, p.category),
           (c.region),
           ()
         )
         ORDER BY c.region, p.category`
      );

      // Should have specific groupings only
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Query Limits and Pagination
  // ============================================================================

  describe("Query Limits and Pagination", () => {
    const TABLE = "pagination_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          value INT
        )
        DUPLICATE KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);

      const data = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        value: (i + 1) * 10,
      }));

      await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });
    });

    test("should handle LIMIT", async () => {
      const result = await client.raw<{ id: number }>(
        `SELECT id FROM ${FQN(TABLE)} ORDER BY id LIMIT 10`
      );

      expect(result.length).toBe(10);
      expect((result[0] as any).id).toBe(1);
      expect((result[9] as any).id).toBe(10);
    });

    test("should handle LIMIT with OFFSET", async () => {
      const result = await client.raw<{ id: number }>(
        `SELECT id FROM ${FQN(TABLE)} ORDER BY id LIMIT 10 OFFSET 20`
      );

      expect(result.length).toBe(10);
      expect((result[0] as any).id).toBe(21);
      expect((result[9] as any).id).toBe(30);
    });

    test("should handle LIMIT larger than result set", async () => {
      const result = await client.raw<{ id: number }>(
        `SELECT id FROM ${FQN(TABLE)} ORDER BY id LIMIT 1000`
      );

      expect(result.length).toBe(100);
    });

    test("should handle OFFSET beyond result set", async () => {
      const result = await client.raw<{ id: number }>(
        `SELECT id FROM ${FQN(TABLE)} ORDER BY id LIMIT 10 OFFSET 200`
      );

      expect(result.length).toBe(0);
    });
  });

  // ============================================================================
  // String Functions
  // ============================================================================

  describe("String Functions", () => {
    test("should handle CONCAT", async () => {
      const result = await client.raw<{ full_name: string }>(
        `SELECT CONCAT(name, ' - ', region) as full_name
         FROM ${FQN("customers")}
         WHERE customer_id = 1`
      );

      expect((result[0] as any).full_name).toBe("Acme Corp - US");
    });

    test("should handle SUBSTRING", async () => {
      const result = await client.raw<{ short_name: string }>(
        `SELECT SUBSTRING(name, 1, 4) as short_name
         FROM ${FQN("customers")}
         WHERE customer_id = 1`
      );

      expect((result[0] as any).short_name).toBe("Acme");
    });

    test("should handle UPPER and LOWER", async () => {
      const result = await client.raw<{ upper_name: string; lower_name: string }>(
        `SELECT UPPER(name) as upper_name, LOWER(name) as lower_name
         FROM ${FQN("customers")}
         WHERE customer_id = 1`
      );

      expect((result[0] as any).upper_name).toBe("ACME CORP");
      expect((result[0] as any).lower_name).toBe("acme corp");
    });

    test("should handle REPLACE", async () => {
      const result = await client.raw<{ new_name: string }>(
        `SELECT REPLACE(name, 'Corp', 'Inc') as new_name
         FROM ${FQN("customers")}
         WHERE customer_id = 1`
      );

      expect((result[0] as any).new_name).toBe("Acme Inc");
    });

    test("should handle TRIM", async () => {
      const result = await client.raw<{ trimmed: string }>(
        `SELECT TRIM('  hello  ') as trimmed`
      );

      expect((result[0] as any).trimmed).toBe("hello");
    });

    test("should handle LENGTH", async () => {
      const result = await client.raw<{ name_len: number }>(
        `SELECT LENGTH(name) as name_len
         FROM ${FQN("customers")}
         WHERE customer_id = 1`
      );

      expect((result[0] as any).name_len).toBe(9); // "Acme Corp"
    });
  });

  // ============================================================================
  // Date Functions
  // ============================================================================

  describe("Date Functions", () => {
    test("should handle DATE_FORMAT", async () => {
      const result = await client.raw<{ formatted: string }>(
        `SELECT DATE_FORMAT(order_date, '%Y-%m') as formatted
         FROM ${FQN("orders")}
         WHERE order_id = 1001`
      );

      expect((result[0] as any).formatted).toBe("2024-01");
    });

    test("should handle DATE_ADD and DATE_SUB", async () => {
      const result = await client.raw<{ next_week: any; last_week: any }>(
        `SELECT DATE_ADD(order_date, INTERVAL 7 DAY) as next_week,
                DATE_SUB(order_date, INTERVAL 7 DAY) as last_week
         FROM ${FQN("orders")}
         WHERE order_id = 1001`
      );

      // Results should be returned (format may vary based on client)
      expect((result[0] as any).next_week).toBeDefined();
      expect((result[0] as any).last_week).toBeDefined();

      // Convert to date for comparison
      const nextDate = new Date((result[0] as any).next_week);
      const lastDate = new Date((result[0] as any).last_week);

      // 2024-01-15 + 7 days = 2024-01-22
      expect(nextDate.getDate()).toBe(22);
      // 2024-01-15 - 7 days = 2024-01-08
      expect(lastDate.getDate()).toBe(8);
    });

    test("should handle DATEDIFF", async () => {
      const result = await client.raw<{ days_diff: number }>(
        `SELECT DATEDIFF('2024-01-31', '2024-01-01') as days_diff`
      );

      expect((result[0] as any).days_diff).toBe(30);
    });

    test("should handle YEAR, MONTH, DAY extraction", async () => {
      const result = await client.raw<{ yr: number; mo: number; dy: number }>(
        `SELECT YEAR(order_date) as yr, MONTH(order_date) as mo, DAY(order_date) as dy
         FROM ${FQN("orders")}
         WHERE order_id = 1001`
      );

      expect((result[0] as any).yr).toBe(2024);
      expect((result[0] as any).mo).toBe(1);
      expect((result[0] as any).dy).toBe(15);
    });

    test("should handle NOW and CURDATE", async () => {
      const result = await client.raw<{ now_val: string; today: string }>(
        `SELECT NOW() as now_val, CURDATE() as today`
      );

      expect((result[0] as any).now_val).toBeDefined();
      expect((result[0] as any).today).toBeDefined();
    });
  });

  // ============================================================================
  // Aggregate Functions
  // ============================================================================

  describe("Additional Aggregate Functions", () => {
    test("should handle COUNT DISTINCT", async () => {
      const result = await client.raw<{ unique_customers: number }>(
        `SELECT COUNT(DISTINCT customer_id) as unique_customers
         FROM ${FQN("orders")}`
      );

      expect((result[0] as any).unique_customers).toBe(3);
    });

    test("should handle GROUP_CONCAT", async () => {
      const result = await client.raw<{ all_regions: string }>(
        `SELECT GROUP_CONCAT(DISTINCT region ORDER BY region) as all_regions
         FROM ${FQN("customers")}`
      );

      // Should contain all regions
      expect((result[0] as any).all_regions).toContain("US");
    });

    test("should handle STDDEV and VARIANCE", async () => {
      const result = await client.raw<{ std: number; var_val: number }>(
        `SELECT STDDEV(amount) as std, VARIANCE(amount) as var_val
         FROM ${FQN("orders")}`
      );

      expect((result[0] as any).std).toBeGreaterThan(0);
      expect((result[0] as any).var_val).toBeGreaterThan(0);
    });
  });
});
