import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE, beHttpPort } from "../src/test-config";
import {
  starrocksTable,
  bigint,
  varchar,
  double,
  int,
  datetime,
  duplicateKey,
  hash,

  // Expressions
  gt,
  eq,

  // Aggregates
  sum,
  count,

  // CASE/WHEN
  when,
  caseWhen,
  caseExpr,
  ifExpr,
  coalesce,

  // Window functions
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  firstValue,
  lastValue,
  partitionBy,
  windowOrderBy,
  rows,
  unboundedPreceding,
  currentRow,
  unboundedFollowing,

  // Query builder
  QueryBuilder,
} from "../src/schema/index";
import mysql from "mysql2/promise";

/**
 * Integration tests: Query Builder Tier 1 features against live StarRocks
 *
 * Tests CASE/WHEN, window functions, CTEs, and UNION/INTERSECT/EXCEPT
 * using the type-safe query builder API.
 *
 * IMPORTANT: Uses testConfig/TEST_DATABASE from test-config.ts.
 * The test startup script handles docker up/down.
 */
describe("Query Builder Integration", () => {
  let client: StarRocksClient;
  let streamLoader: StreamLoadClient;
  let pool: mysql.Pool;

  const FQN = (table: string) => `${TEST_DATABASE}.${table}`;

  // Schema definitions (used for typed query builder refs only —
  // raw DDL is used for table creation since key column order matters)
  const employees = starrocksTable("employees", {
    dept: varchar("dept", { length: 50 }).notNull(),
    employee: varchar("employee", { length: 100 }).notNull(),
    id: bigint("id").notNull(),
    salary: int("salary"),
    hireDate: datetime("hire_date"),
  }, (t) => ({
    key: duplicateKey(t.dept, t.employee),
    distribution: hash(t.dept, { buckets: 4 }),
    properties: { replication_num: 1 },
  }));

  const orders = starrocksTable("orders_qb", {
    orderId: bigint("order_id").notNull(),
    customerId: bigint("customer_id"),
    amount: double("amount"),
    category: varchar("category", { length: 50 }),
    orderDate: datetime("order_date"),
  }, (t) => ({
    key: duplicateKey(t.orderId),
    distribution: hash(t.orderId, { buckets: 4 }),
    properties: { replication_num: 1 },
  }));

  const refunds = starrocksTable("refunds_qb", {
    refundId: bigint("refund_id").notNull(),
    customerId: bigint("customer_id"),
    amount: double("amount"),
    refundDate: datetime("refund_date"),
  }, (t) => ({
    key: duplicateKey(t.refundId),
    distribution: hash(t.refundId, { buckets: 4 }),
    properties: { replication_num: 1 },
  }));

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);

    streamLoader = createStreamLoadClient({
      host: testConfig.host,
      httpPort: beHttpPort,
      user: testConfig.user,
      password: testConfig.password,
    });

    pool = mysql.createPool({
      host: testConfig.host,
      port: testConfig.port,
      user: testConfig.user,
      password: testConfig.password,
      database: TEST_DATABASE,
    });

    // Create tables (key columns must come first in StarRocks)
    await client.raw(`
      CREATE TABLE IF NOT EXISTS ${FQN("employees")} (
        dept VARCHAR(50) NOT NULL,
        employee VARCHAR(100) NOT NULL,
        id BIGINT NOT NULL,
        salary INT,
        hire_date DATETIME
      )
      DUPLICATE KEY (dept, employee)
      DISTRIBUTED BY HASH(dept) BUCKETS 4
      PROPERTIES("replication_num" = "1")
    `);

    await client.raw(`
      CREATE TABLE IF NOT EXISTS ${FQN("orders_qb")} (
        order_id BIGINT NOT NULL,
        customer_id BIGINT,
        amount DOUBLE,
        category VARCHAR(50),
        order_date DATETIME
      )
      DUPLICATE KEY (order_id)
      DISTRIBUTED BY HASH(order_id) BUCKETS 4
      PROPERTIES("replication_num" = "1")
    `);

    await client.raw(`
      CREATE TABLE IF NOT EXISTS ${FQN("refunds_qb")} (
        refund_id BIGINT NOT NULL,
        customer_id BIGINT,
        amount DOUBLE,
        refund_date DATETIME
      )
      DUPLICATE KEY (refund_id)
      DISTRIBUTED BY HASH(refund_id) BUCKETS 4
      PROPERTIES("replication_num" = "1")
    `);

    // Load seed data
    await streamLoader.loadObjects([
      { id: 1, dept: "Sales", employee: "Alice", salary: 50000, hire_date: "2020-01-15 00:00:00" },
      { id: 2, dept: "Sales", employee: "Bob", salary: 60000, hire_date: "2019-03-20 00:00:00" },
      { id: 3, dept: "Sales", employee: "Charlie", salary: 55000, hire_date: "2021-06-01 00:00:00" },
      { id: 4, dept: "Engineering", employee: "David", salary: 80000, hire_date: "2018-02-10 00:00:00" },
      { id: 5, dept: "Engineering", employee: "Eve", salary: 90000, hire_date: "2017-11-05 00:00:00" },
      { id: 6, dept: "Engineering", employee: "Frank", salary: 75000, hire_date: "2022-01-15 00:00:00" },
      { id: 7, dept: "HR", employee: "Grace", salary: 45000, hire_date: "2020-08-20 00:00:00" },
    ], { database: TEST_DATABASE, table: "employees" });

    await streamLoader.loadObjects([
      { order_id: 1, customer_id: 1, amount: 250.0, category: "Electronics", order_date: "2024-01-10 00:00:00" },
      { order_id: 2, customer_id: 1, amount: 50.0, category: "Books", order_date: "2024-01-15 00:00:00" },
      { order_id: 3, customer_id: 2, amount: 120.0, category: "Electronics", order_date: "2024-02-01 00:00:00" },
      { order_id: 4, customer_id: 2, amount: 30.0, category: "Books", order_date: "2024-02-10 00:00:00" },
      { order_id: 5, customer_id: 3, amount: 500.0, category: "Electronics", order_date: "2024-03-01 00:00:00" },
    ], { database: TEST_DATABASE, table: "orders_qb" });

    await streamLoader.loadObjects([
      { refund_id: 1, customer_id: 1, amount: 50.0, refund_date: "2024-01-20 00:00:00" },
      { refund_id: 2, customer_id: 2, amount: 30.0, refund_date: "2024-02-15 00:00:00" },
    ], { database: TEST_DATABASE, table: "refunds_qb" });
  });

  afterAll(async () => {
    await pool.end();
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  // ==========================================================================
  // CASE/WHEN
  // ==========================================================================

  describe("CASE/WHEN", () => {
    test("searched CASE: salary tiers", async () => {
      const salaryTier = caseWhen(
        when(gt(employees.salary, 70000), "senior"),
        when(gt(employees.salary, 50000), "mid"),
      ).else("junior");

      const qb = new QueryBuilder(pool)
        .from(employees)
        .select({
          employee: employees.employee,
          salary: employees.salary,
          tier: salaryTier,
        })
        .orderBy({ column: employees.salary, direction: "DESC" });

      const results = await qb.execute();

      expect(results.length).toBe(7);
      const eve = results.find((r: any) => r.employee === "Eve");
      expect((eve as any).tier).toBe("senior");
      const charlie = results.find((r: any) => r.employee === "Charlie");
      expect((charlie as any).tier).toBe("mid");
      const grace = results.find((r: any) => r.employee === "Grace");
      expect((grace as any).tier).toBe("junior");
    });

    test("simple CASE: department labels", async () => {
      const deptLabel = caseExpr(
        employees.dept,
        when("Sales", "Revenue"),
        when("Engineering", "Product"),
      ).else("Support");

      const qb = new QueryBuilder(pool)
        .from(employees)
        .select({
          employee: employees.employee,
          dept: employees.dept,
          label: deptLabel,
        })
        .orderBy(employees.employee);

      const results = await qb.execute();

      const alice = results.find((r: any) => r.employee === "Alice");
      expect((alice as any).label).toBe("Revenue");
      const david = results.find((r: any) => r.employee === "David");
      expect((david as any).label).toBe("Product");
      const grace = results.find((r: any) => r.employee === "Grace");
      expect((grace as any).label).toBe("Support");
    });

    test("IF expression", async () => {
      const seniorFlag = ifExpr(gt(employees.salary, 70000), "yes", "no");

      const qb = new QueryBuilder(pool)
        .from(employees)
        .select({
          employee: employees.employee,
          isSenior: seniorFlag,
        })
        .orderBy(employees.employee);

      const results = await qb.execute();
      const eve = results.find((r: any) => r.employee === "Eve");
      expect((eve as any).isSenior).toBe("yes");
      const grace = results.find((r: any) => r.employee === "Grace");
      expect((grace as any).isSenior).toBe("no");
    });

    test("COALESCE", async () => {
      const safeSalary = coalesce(employees.salary, 0);

      const qb = new QueryBuilder(pool)
        .from(employees)
        .select({
          employee: employees.employee,
          safeSalary,
        })
        .orderBy(employees.employee)
        .limit(1);

      const results = await qb.execute();
      expect(results.length).toBe(1);
      expect((results[0] as any).safeSalary).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Window Functions
  // ==========================================================================

  describe("Window functions", () => {
    test("ROW_NUMBER with PARTITION BY", async () => {
      const rn = rowNumber().over(
        partitionBy(employees.dept),
        windowOrderBy({ column: employees.salary, direction: "DESC" })
      );

      const qb = new QueryBuilder(pool)
        .from(employees)
        .select({
          dept: employees.dept,
          employee: employees.employee,
          salary: employees.salary,
          rn,
        })
        .orderBy(employees.dept, { column: employees.salary, direction: "DESC" });

      const results = await qb.execute();
      expect(results.length).toBe(7);

      const eng = results.filter((r: any) => r.dept === "Engineering");
      expect(eng.length).toBe(3);
      expect((eng[0] as any).employee).toBe("Eve");
      expect((eng[0] as any).rn).toBe(1);
      expect((eng[1] as any).employee).toBe("David");
      expect((eng[1] as any).rn).toBe(2);
    });

    test("RANK", async () => {
      const rnk = rank().over(
        windowOrderBy({ column: employees.salary, direction: "DESC" })
      );

      const qb = new QueryBuilder(pool)
        .from(employees)
        .select({
          employee: employees.employee,
          salary: employees.salary,
          rnk,
        })
        .orderBy({ column: employees.salary, direction: "DESC" });

      const results = await qb.execute();
      expect((results[0] as any).employee).toBe("Eve");
      expect((results[0] as any).rnk).toBe(1);
    });

    test("LAG / LEAD", async () => {
      const prevSalary = lag(employees.salary, 1).over(
        partitionBy(employees.dept),
        windowOrderBy(employees.hireDate)
      );
      const nextSalary = lead(employees.salary, 1).over(
        partitionBy(employees.dept),
        windowOrderBy(employees.hireDate)
      );

      const qb = new QueryBuilder(pool)
        .from(employees)
        .select({
          employee: employees.employee,
          dept: employees.dept,
          salary: employees.salary,
          prevSalary,
          nextSalary,
        })
        .where(eq(employees.dept, "Engineering"))
        .orderBy(employees.hireDate);

      const results = await qb.execute();
      expect(results.length).toBe(3);
      expect((results[0] as any).prevSalary).toBeNull();
      expect((results[2] as any).nextSalary).toBeNull();
    });

    test("FIRST_VALUE / LAST_VALUE", async () => {
      const firstEmp = firstValue(employees.employee).over(
        partitionBy(employees.dept),
        windowOrderBy(employees.hireDate),
        rows(unboundedPreceding(), unboundedFollowing())
      );
      const lastEmp = lastValue(employees.employee).over(
        partitionBy(employees.dept),
        windowOrderBy(employees.hireDate),
        rows(unboundedPreceding(), unboundedFollowing())
      );

      const qb = new QueryBuilder(pool)
        .from(employees)
        .select({
          employee: employees.employee,
          dept: employees.dept,
          firstEmp,
          lastEmp,
        })
        .where(eq(employees.dept, "Engineering"))
        .orderBy(employees.hireDate);

      const results = await qb.execute();
      for (const r of results) {
        expect((r as any).firstEmp).toBe("Eve");
        expect((r as any).lastEmp).toBe("Frank");
      }
    });

    test("SUM() OVER() running total", async () => {
      const runningTotal = sum(employees.salary).over(
        partitionBy(employees.dept),
        windowOrderBy(employees.hireDate),
        rows(unboundedPreceding(), currentRow())
      );

      const qb = new QueryBuilder(pool)
        .from(employees)
        .select({
          employee: employees.employee,
          dept: employees.dept,
          salary: employees.salary,
          runningTotal,
        })
        .where(eq(employees.dept, "Engineering"))
        .orderBy(employees.hireDate);

      const results = await qb.execute();
      expect(results.length).toBe(3);
      expect((results[0] as any).runningTotal).toBe(90000);
      expect((results[1] as any).runningTotal).toBe(170000);
      expect((results[2] as any).runningTotal).toBe(245000);
    });

    test("DENSE_RANK", async () => {
      const dr = denseRank().over(
        windowOrderBy({ column: employees.salary, direction: "DESC" })
      );

      const qb = new QueryBuilder(pool)
        .from(employees)
        .select({
          employee: employees.employee,
          salary: employees.salary,
          dr,
        })
        .orderBy({ column: employees.salary, direction: "DESC" });

      const results = await qb.execute();
      expect((results[0] as any).dr).toBe(1);
      expect((results[1] as any).dr).toBe(2);
    });
  });

  // ==========================================================================
  // CTEs
  // ==========================================================================

  describe("CTEs", () => {
    test("single CTE", async () => {
      const qb = new QueryBuilder(pool)
        .with("high_earners", (sub) =>
          sub.from(employees)
            .select({
              dept: employees.dept,
              employee: employees.employee,
              salary: employees.salary,
            })
            .where(gt(employees.salary, 70000))
        )
        .selectAll();

      const { sql: querySql, values } = qb.toSQL();

      // Append FROM to reference the CTE (typed .from() can't reference CTE names yet)
      const fullSql = querySql + "\nFROM high_earners\nORDER BY salary DESC";
      const [rows] = await pool.query(fullSql, values);
      const results = rows as any[];

      expect(results.length).toBe(3);
      expect(results[0].employee).toBe("Eve");
    });

    test("multiple CTEs", async () => {
      const qb = new QueryBuilder(pool)
        .with("dept_totals", (sub) =>
          sub.from(employees)
            .select({
              dept: employees.dept,
              totalSalary: sum(employees.salary),
            })
            .groupBy(employees.dept)
        )
        .with("dept_counts", (sub) =>
          sub.from(employees)
            .select({
              dept: employees.dept,
              headcount: count(),
            })
            .groupBy(employees.dept)
        )
        .selectAll();

      const { sql: querySql, values } = qb.toSQL();

      const fullSql = querySql +
        "\nFROM dept_totals t JOIN dept_counts c ON t.dept = c.dept\nORDER BY t.dept";
      const [rows] = await pool.query(fullSql, values);
      const results = rows as any[];

      expect(results.length).toBe(3);
      const eng = results.find((r: any) => r.dept === "Engineering");
      expect(eng.headcount).toBe(3);
      expect(eng.totalSalary).toBe(245000);
    });
  });

  // ==========================================================================
  // Set Operations
  // ==========================================================================

  describe("Set operations", () => {
    test("UNION ALL combines rows", async () => {
      const q1 = new QueryBuilder()
        .from(orders)
        .select({ customerId: orders.customerId, amount: orders.amount });
      const q2 = new QueryBuilder()
        .from(refunds)
        .select({ customerId: refunds.customerId, amount: refunds.amount });

      const { sql: querySql, values } = q1.unionAll(q2).toSQL();
      const [rows] = await pool.query(querySql, values);
      const results = rows as any[];

      expect(results.length).toBe(7);
    });

    test("UNION deduplicates", async () => {
      const q1 = new QueryBuilder()
        .from(orders)
        .select({ customerId: orders.customerId });
      const q2 = new QueryBuilder()
        .from(refunds)
        .select({ customerId: refunds.customerId });

      const { sql: querySql, values } = q1.union(q2).toSQL();
      const [rows] = await pool.query(querySql, values);
      const results = rows as any[];

      expect(results.length).toBe(3);
    });

    test("EXCEPT removes matching rows", async () => {
      const q1 = new QueryBuilder()
        .from(orders)
        .select({ customerId: orders.customerId });
      const q2 = new QueryBuilder()
        .from(refunds)
        .select({ customerId: refunds.customerId });

      const { sql: querySql, values } = q1.except(q2).toSQL();
      const [rows] = await pool.query(querySql, values);
      const results = rows as any[];

      expect(results.length).toBe(1);
      expect(results[0].customerId).toBe(3);
    });

    test("INTERSECT finds common rows", async () => {
      const q1 = new QueryBuilder()
        .from(orders)
        .select({ customerId: orders.customerId });
      const q2 = new QueryBuilder()
        .from(refunds)
        .select({ customerId: refunds.customerId });

      const { sql: querySql, values } = q1.intersect(q2).toSQL();
      const [rows] = await pool.query(querySql, values);
      const results = rows as any[];

      expect(results.length).toBe(2);
    });

    test("UNION ALL with ORDER BY and LIMIT", async () => {
      const q1 = new QueryBuilder()
        .from(orders)
        .select({ customerId: orders.customerId, amount: orders.amount });
      const q2 = new QueryBuilder()
        .from(refunds)
        .select({ customerId: refunds.customerId, amount: refunds.amount });

      const { sql: querySql, values } = q1
        .unionAll(q2)
        .orderBy({ column: orders.amount, direction: "DESC" })
        .limit(3)
        .toSQL();

      const [rows] = await pool.query(querySql, values);
      const results = rows as any[];

      expect(results.length).toBe(3);
      expect(results[0].amount).toBe(500);
      expect(results[1].amount).toBe(250);
      expect(results[2].amount).toBe(120);
    });
  });

  // ==========================================================================
  // Combined features
  // ==========================================================================

  describe("Combined features", () => {
    test("CASE/WHEN + window function in same SELECT", async () => {
      const salaryTier = caseWhen(
        when(gt(employees.salary, 70000), "senior"),
        when(gt(employees.salary, 50000), "mid"),
      ).else("junior");

      const rn = rowNumber().over(
        partitionBy(employees.dept),
        windowOrderBy({ column: employees.salary, direction: "DESC" })
      );

      const qb = new QueryBuilder(pool)
        .from(employees)
        .select({
          dept: employees.dept,
          employee: employees.employee,
          salary: employees.salary,
          tier: salaryTier,
          rankInDept: rn,
        })
        .orderBy(employees.dept, { column: employees.salary, direction: "DESC" });

      const results = await qb.execute();
      expect(results.length).toBe(7);

      const eve = results.find((r: any) => r.employee === "Eve");
      expect((eve as any).tier).toBe("senior");
      expect((eve as any).rankInDept).toBe(1);
    });
  });
});
