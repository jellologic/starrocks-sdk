import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createStarRocksClient,
  type StarRocksClient,
  LegacySchemaIntrospector as SchemaIntrospector,
  SchemaDiffer,
  SchemaValidator,
} from "../src";
import type {
  SchemaDefinition,
  IntrospectedSchema,
  IntrospectedTable,
} from "../src/schema-diff";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import type { TableOptions } from "../src/types";

describe("StarRocks Schema Diff", () => {
  let client: StarRocksClient;
  let introspector: SchemaIntrospector;
  let validator: SchemaValidator;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);
    await client.useDatabase(TEST_DATABASE);

    introspector = new SchemaIntrospector(client);
    validator = new SchemaValidator(client);

    // Create test tables for introspection
    const usersOptions: TableOptions = {
      keyType: "PRIMARY",
      keys: ["user_id"],
      distribution: {
        type: "HASH",
        columns: ["user_id"],
        buckets: 4,
      },
      properties: {
        replication_num: 1,
      },
    };

    await client.createTable(
      "users",
      [
        { name: "user_id", type: "BIGINT", nullable: false },
        { name: "username", type: "VARCHAR", length: 100, nullable: false },
        { name: "email", type: "VARCHAR", length: 255 },
        { name: "created_at", type: "DATETIME", defaultValue: "CURRENT_TIMESTAMP" },
        { name: "is_active", type: "BOOLEAN", defaultValue: "'1'" },
      ],
      usersOptions
    );

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
        { name: "user_id", type: "BIGINT" },
        { name: "amount", type: "DECIMAL", precision: 10, scale: 2 },
        { name: "status", type: "VARCHAR", length: 32 },
      ],
      ordersOptions
    );
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  describe("SchemaIntrospector", () => {
    test("should introspect database schema", async () => {
      const schema = await introspector.introspect(TEST_DATABASE);

      expect(schema.database).toBe(TEST_DATABASE);
      expect(schema.tables).toBeInstanceOf(Array);
      expect(schema.tables.length).toBeGreaterThanOrEqual(2);

      // Find users table
      const usersTable = schema.tables.find((t) => t.name === "users");
      expect(usersTable).toBeDefined();
      expect(usersTable!.columns.length).toBeGreaterThanOrEqual(5);
    });

    test("should introspect table columns correctly", async () => {
      const schema = await introspector.introspect(TEST_DATABASE);
      const usersTable = schema.tables.find((t) => t.name === "users");

      expect(usersTable).toBeDefined();

      // Check column details
      const userIdCol = usersTable!.columns.find((c) => c.name === "user_id");
      expect(userIdCol).toBeDefined();
      expect(userIdCol!.type.toLowerCase()).toContain("bigint");
      expect(userIdCol!.nullable).toBe(false);

      const emailCol = usersTable!.columns.find((c) => c.name === "email");
      expect(emailCol).toBeDefined();
      expect(emailCol!.type.toLowerCase()).toContain("varchar");
    });

    test("should introspect table key type", async () => {
      const schema = await introspector.introspect(TEST_DATABASE);

      const usersTable = schema.tables.find((t) => t.name === "users");
      expect(usersTable?.keyType).toBe("PRIMARY");

      const ordersTable = schema.tables.find((t) => t.name === "orders");
      expect(ordersTable?.keyType).toBe("DUPLICATE");
    });

    test("should introspect distribution info", async () => {
      const schema = await introspector.introspect(TEST_DATABASE);
      const usersTable = schema.tables.find((t) => t.name === "users");

      expect(usersTable?.distributionType).toBe("HASH");
      expect(usersTable?.distributionColumns).toContain("user_id");
    });
  });

  describe("SchemaDiffer", () => {
    // Helper to create minimal IntrospectedTable
    function createIntrospectedTable(
      name: string,
      columns: Array<{ name: string; type: string; nullable: boolean; isKey: boolean }>,
      keyType: "PRIMARY" | "DUPLICATE" | "UNIQUE" | "AGGREGATE" = "PRIMARY"
    ): IntrospectedTable {
      return {
        name,
        columns: columns.map((c) => ({ ...c })),
        keyType,
        keyColumns: columns.filter((c) => c.isKey).map((c) => c.name),
        distributionType: "HASH",
        distributionColumns: [columns[0]!.name],
        buckets: 4,
        properties: { replication_num: "1" },
      };
    }

    test("should detect missing tables", () => {
      const differ = new SchemaDiffer();

      const defined: SchemaDefinition = {
        database: TEST_DATABASE,
        tables: [
          {
            name: "users",
            columns: [
              { name: "user_id", type: "BIGINT", nullable: false },
              { name: "username", type: "VARCHAR", length: 100 },
            ],
            options: {
              keyType: "PRIMARY",
              keys: ["user_id"],
              distribution: { type: "HASH", columns: ["user_id"], buckets: 4 },
            },
          },
          {
            name: "new_table",
            columns: [{ name: "id", type: "BIGINT", nullable: false }],
            options: {
              keyType: "PRIMARY",
              keys: ["id"],
              distribution: { type: "HASH", columns: ["id"], buckets: 4 },
            },
          },
        ],
      };

      const actual: IntrospectedSchema = {
        database: TEST_DATABASE,
        tables: [
          createIntrospectedTable("users", [
            { name: "user_id", type: "BIGINT", nullable: false, isKey: true },
            { name: "username", type: "VARCHAR(100)", nullable: true, isKey: false },
          ]),
        ],
      };

      const result = differ.diff(defined, actual);

      // Check for missing table
      const missingTableDiffs = result.diffs.filter((d) => d.type === "table_missing");
      expect(missingTableDiffs.length).toBe(1);
      expect(missingTableDiffs[0]!.table).toBe("new_table");
    });

    test("should detect extra tables in database", () => {
      const differ = new SchemaDiffer();

      const defined: SchemaDefinition = {
        database: TEST_DATABASE,
        tables: [],
      };

      const actual: IntrospectedSchema = {
        database: TEST_DATABASE,
        tables: [
          createIntrospectedTable("extra_table", [
            { name: "id", type: "BIGINT", nullable: false, isKey: true },
          ]),
        ],
      };

      const result = differ.diff(defined, actual);

      // Check for extra table
      const extraTableDiffs = result.diffs.filter((d) => d.type === "table_extra");
      expect(extraTableDiffs.length).toBe(1);
      expect(extraTableDiffs[0]!.table).toBe("extra_table");
    });

    test("should detect column differences", () => {
      const differ = new SchemaDiffer();

      const defined: SchemaDefinition = {
        database: TEST_DATABASE,
        tables: [
          {
            name: "users",
            columns: [
              { name: "user_id", type: "BIGINT", nullable: false },
              { name: "username", type: "VARCHAR", length: 100 },
              { name: "new_column", type: "INT" }, // Missing in actual
            ],
            options: {
              keyType: "PRIMARY",
              keys: ["user_id"],
              distribution: { type: "HASH", columns: ["user_id"], buckets: 4 },
            },
          },
        ],
      };

      const actual: IntrospectedSchema = {
        database: TEST_DATABASE,
        tables: [
          createIntrospectedTable("users", [
            { name: "user_id", type: "BIGINT", nullable: false, isKey: true },
            { name: "username", type: "VARCHAR(100)", nullable: true, isKey: false },
            { name: "old_column", type: "INT", nullable: true, isKey: false }, // Extra in actual
          ]),
        ],
      };

      const result = differ.diff(defined, actual);

      // Check for missing column
      const missingColDiffs = result.diffs.filter((d) => d.type === "column_missing");
      expect(missingColDiffs.length).toBe(1);
      expect(missingColDiffs[0]!.column).toBe("new_column");

      // Check for extra column
      const extraColDiffs = result.diffs.filter((d) => d.type === "column_extra");
      expect(extraColDiffs.length).toBe(1);
      expect(extraColDiffs[0]!.column).toBe("old_column");
    });

    test("should report when schemas match", () => {
      const differ = new SchemaDiffer();

      const defined: SchemaDefinition = {
        database: TEST_DATABASE,
        tables: [
          {
            name: "users",
            columns: [
              { name: "user_id", type: "BIGINT", nullable: false },
              { name: "username", type: "VARCHAR", length: 100 },
            ],
            options: {
              keyType: "PRIMARY",
              keys: ["user_id"],
              distribution: { type: "HASH", columns: ["user_id"], buckets: 4 },
            },
          },
        ],
      };

      const actual: IntrospectedSchema = {
        database: TEST_DATABASE,
        tables: [
          createIntrospectedTable("users", [
            { name: "user_id", type: "BIGINT", nullable: false, isKey: true },
            { name: "username", type: "VARCHAR(100)", nullable: true, isKey: false },
          ]),
        ],
      };

      const result = differ.diff(defined, actual);

      expect(result.isValid).toBe(true);
      expect(result.summary.errors).toBe(0);
    });
  });

  describe("SchemaValidator", () => {
    test("should validate schema against database", async () => {
      const schema: SchemaDefinition = {
        database: TEST_DATABASE,
        tables: [
          {
            name: "users",
            columns: [
              { name: "user_id", type: "BIGINT", nullable: false },
              { name: "username", type: "VARCHAR", length: 100 },
              { name: "email", type: "VARCHAR", length: 255 },
              { name: "created_at", type: "DATETIME" },
              { name: "is_active", type: "BOOLEAN" },
            ],
            options: {
              keyType: "PRIMARY",
              keys: ["user_id"],
              distribution: { type: "HASH", columns: ["user_id"], buckets: 4 },
            },
          },
        ],
      };

      const result = await validator.validate(schema);

      // users table exists and has no missing table errors
      const missingTableDiffs = result.diffs.filter(
        (d) => d.type === "table_missing" && d.table === "users"
      );
      expect(missingTableDiffs.length).toBe(0);
    });

    test("should detect missing table in validation", async () => {
      const schema: SchemaDefinition = {
        database: TEST_DATABASE,
        tables: [
          {
            name: "nonexistent_table",
            columns: [{ name: "id", type: "BIGINT", nullable: false }],
            options: {
              keyType: "PRIMARY",
              keys: ["id"],
              distribution: { type: "HASH", columns: ["id"], buckets: 4 },
            },
          },
        ],
      };

      const result = await validator.validate(schema);

      const missingTableDiffs = result.diffs.filter((d) => d.type === "table_missing");
      expect(missingTableDiffs.some((d) => d.table === "nonexistent_table")).toBe(true);
      expect(result.isValid).toBe(false);
    });

    test("should generate human-readable report", async () => {
      const schema: SchemaDefinition = {
        database: TEST_DATABASE,
        tables: [
          {
            name: "users",
            columns: [
              { name: "user_id", type: "BIGINT", nullable: false },
              { name: "username", type: "VARCHAR", length: 100 },
            ],
            options: {
              keyType: "PRIMARY",
              keys: ["user_id"],
              distribution: { type: "HASH", columns: ["user_id"], buckets: 4 },
            },
          },
          {
            name: "missing_table",
            columns: [{ name: "id", type: "BIGINT", nullable: false }],
            options: {
              keyType: "PRIMARY",
              keys: ["id"],
              distribution: { type: "HASH", columns: ["id"], buckets: 4 },
            },
          },
        ],
      };

      const result = await validator.validate(schema);
      const report = validator.formatReport(result);

      expect(typeof report).toBe("string");
      expect(report).toContain("Schema Validation Report");
      expect(report).toContain("missing_table");
    });

    test("should introspect database directly", async () => {
      const schema = await validator.introspect(TEST_DATABASE);

      expect(schema.database).toBe(TEST_DATABASE);
      expect(schema.tables).toBeInstanceOf(Array);
      expect(schema.tables.some((t) => t.name === "users")).toBe(true);
    });
  });
});
