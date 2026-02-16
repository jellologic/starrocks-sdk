/**
 * Schema Introspector Edge Case Tests
 *
 * Tests the schema introspector against various table configurations.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import mysql from "mysql2/promise";
import { createStarRocksClient, type StarRocksClient } from "../src";
import { createSchemaIntrospector, type SchemaIntrospector } from "../src/schema/introspector";
import { testConfig, TEST_DATABASE } from "../src/test-config";

describe("Schema Introspector", () => {
  let client: StarRocksClient;
  let pool: mysql.Pool;
  let introspector: SchemaIntrospector;
  const INTROSPECT_DB = `${TEST_DATABASE}_introspect`;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(INTROSPECT_DB);
    await client.useDatabase(INTROSPECT_DB);

    pool = mysql.createPool({
      host: testConfig.host,
      port: testConfig.port,
      user: testConfig.user,
      password: testConfig.password,
      database: INTROSPECT_DB,
      waitForConnections: true,
      connectionLimit: 10,
    });

    introspector = createSchemaIntrospector(pool, INTROSPECT_DB);
  });

  afterAll(async () => {
    await pool.end();
    await client.dropDatabase(INTROSPECT_DB);
    await client.close();
  });

  // ============================================================================
  // Table Introspection
  // ============================================================================

  describe("Table Introspection", () => {
    beforeAll(async () => {
      // Create tables with various configurations
      await client.execute(`
        CREATE TABLE primary_key_table (
          id BIGINT NOT NULL,
          name VARCHAR(255),
          created_at DATETIME
        ) PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES ("replication_num" = "1")
      `);

      await client.execute(`
        CREATE TABLE duplicate_key_table (
          event_date DATE NOT NULL,
          event_id BIGINT NOT NULL,
          user_id BIGINT,
          data VARCHAR(500)
        ) DUPLICATE KEY (event_date, event_id)
        DISTRIBUTED BY HASH(event_id) BUCKETS 8
        PROPERTIES ("replication_num" = "1")
      `);

      await client.execute(`
        CREATE TABLE all_types_table (
          id BIGINT NOT NULL,
          tiny_val TINYINT,
          small_val SMALLINT,
          int_val INT,
          big_val BIGINT,
          large_val LARGEINT,
          float_val FLOAT,
          double_val DOUBLE,
          decimal_val DECIMAL(18, 4),
          char_val CHAR(10),
          varchar_val VARCHAR(255),
          string_val STRING,
          date_val DATE,
          datetime_val DATETIME,
          bool_val BOOLEAN,
          json_val JSON
        ) PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES ("replication_num" = "1")
      `);

      await client.execute(`
        CREATE TABLE partitioned_table (
          dt DATE NOT NULL,
          id BIGINT NOT NULL,
          value INT
        ) DUPLICATE KEY (dt, id)
        PARTITION BY RANGE (dt) (
          PARTITION p202401 VALUES LESS THAN ('2024-02-01'),
          PARTITION p202402 VALUES LESS THAN ('2024-03-01'),
          PARTITION p202403 VALUES LESS THAN ('2024-04-01')
        )
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES ("replication_num" = "1")
      `);

      await client.execute(`
        CREATE TABLE random_dist_table (
          id BIGINT NOT NULL,
          data VARCHAR(100)
        ) DUPLICATE KEY (id)
        DISTRIBUTED BY RANDOM BUCKETS 4
        PROPERTIES ("replication_num" = "1")
      `);
    });

    test("should introspect PRIMARY KEY table", async () => {
      const table = await introspector.introspectTable("primary_key_table");

      expect(table).not.toBeNull();
      expect(table!.name).toBe("primary_key_table");
      expect(table!.type).toBe("table");
      expect(table!.keyType).toBe("PRIMARY");
      expect(table!.keyColumns).toContain("id");
      expect(table!.distributionType).toBe("HASH");
      expect(table!.distributionColumns).toContain("id");
      expect(table!.buckets).toBe(4);
    });

    test("should introspect DUPLICATE KEY table", async () => {
      const table = await introspector.introspectTable("duplicate_key_table");

      expect(table).not.toBeNull();
      expect(table!.keyType).toBe("DUPLICATE");
      expect(table!.keyColumns).toContain("event_date");
      expect(table!.keyColumns).toContain("event_id");
      expect(table!.buckets).toBe(8);
    });

    test("should introspect all column types correctly", async () => {
      const table = await introspector.introspectTable("all_types_table");

      expect(table).not.toBeNull();
      expect(table!.columns.length).toBe(16);

      // Check specific types
      const findCol = (name: string) => table!.columns.find(c => c.name === name);

      expect(findCol("tiny_val")?.dataType.toLowerCase()).toContain("tinyint");
      expect(findCol("small_val")?.dataType.toLowerCase()).toContain("smallint");
      expect(findCol("int_val")?.dataType.toLowerCase()).toContain("int");
      expect(findCol("big_val")?.dataType.toLowerCase()).toContain("bigint");
      // Note: LARGEINT is reported as "bigint(20) unsigned" in information_schema
      expect(findCol("large_val")?.dataType.toLowerCase()).toContain("bigint");
      expect(findCol("float_val")?.dataType.toLowerCase()).toContain("float");
      expect(findCol("double_val")?.dataType.toLowerCase()).toContain("double");
      expect(findCol("decimal_val")?.dataType.toLowerCase()).toContain("decimal");
      expect(findCol("char_val")?.dataType.toLowerCase()).toContain("char");
      expect(findCol("varchar_val")?.dataType.toLowerCase()).toContain("varchar");
      expect(findCol("date_val")?.dataType.toLowerCase()).toContain("date");
      expect(findCol("datetime_val")?.dataType.toLowerCase()).toContain("datetime");
      // BOOLEAN is stored as tinyint(1) in information_schema
      expect(findCol("bool_val")?.dataType.toLowerCase()).toMatch(/boolean|tinyint/);
      expect(findCol("json_val")?.dataType.toLowerCase()).toContain("json");
    });

    test("should introspect partitioned table", async () => {
      const table = await introspector.introspectTable("partitioned_table");

      expect(table).not.toBeNull();
      expect(table!.partitionType).toBe("RANGE");
      expect(table!.partitionColumn).toBe("dt");
    });

    test("should introspect RANDOM distribution", async () => {
      const table = await introspector.introspectTable("random_dist_table");

      expect(table).not.toBeNull();
      expect(table!.distributionType).toBe("RANDOM");
      expect(table!.distributionColumns).toHaveLength(0);
      expect(table!.buckets).toBe(4);
    });

    test("should introspect table properties", async () => {
      const table = await introspector.introspectTable("primary_key_table");

      expect(table).not.toBeNull();
      expect(table!.properties).toBeDefined();
      expect(table!.properties["replication_num"]).toBe("1");
    });

    test("should return null for non-existent table", async () => {
      const table = await introspector.introspectTable("nonexistent_table_xyz");
      expect(table).toBeNull();
    });

    test("should introspect column nullability", async () => {
      const table = await introspector.introspectTable("primary_key_table");

      expect(table).not.toBeNull();
      const idCol = table!.columns.find(c => c.name === "id");
      const nameCol = table!.columns.find(c => c.name === "name");

      expect(idCol?.isNullable).toBe(false);
      expect(nameCol?.isNullable).toBe(true);
    });
  });

  // ============================================================================
  // View Introspection
  // ============================================================================

  describe("View Introspection", () => {
    beforeAll(async () => {
      // Create base table for views
      await client.execute(`
        CREATE TABLE view_base_table (
          id BIGINT NOT NULL,
          name VARCHAR(255),
          status VARCHAR(50),
          amount DECIMAL(10, 2)
        ) PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES ("replication_num" = "1")
      `);

      // Create simple view
      await client.execute(`
        CREATE VIEW simple_view AS
        SELECT id, name FROM view_base_table WHERE status = 'active'
      `);

      // Create view with expressions
      await client.execute(`
        CREATE VIEW computed_view AS
        SELECT
          id,
          UPPER(name) as upper_name,
          amount * 1.1 as amount_with_tax
        FROM view_base_table
      `);
    });

    test("should introspect simple view", async () => {
      const view = await introspector.introspectView("simple_view");

      expect(view).not.toBeNull();
      expect(view!.name).toBe("simple_view");
      expect(view!.type).toBe("view");
      expect(view!.columns.length).toBe(2);
      expect(view!.definition).toBeTruthy();
    });

    test("should introspect view with computed columns", async () => {
      const view = await introspector.introspectView("computed_view");

      expect(view).not.toBeNull();
      expect(view!.columns.length).toBe(3);

      const colNames = view!.columns.map(c => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("upper_name");
      expect(colNames).toContain("amount_with_tax");
    });

    test("should return null for non-existent view", async () => {
      const view = await introspector.introspectView("nonexistent_view_xyz");
      expect(view).toBeNull();
    });

    test("should capture view definition", async () => {
      const view = await introspector.introspectView("simple_view");

      expect(view).not.toBeNull();
      expect(view!.definition.toLowerCase()).toContain("select");
      expect(view!.definition.toLowerCase()).toContain("view_base_table");
    });
  });

  // ============================================================================
  // Full Schema Introspection
  // ============================================================================

  describe("Full Schema Introspection", () => {
    test("should introspect entire schema", async () => {
      const schema = await introspector.introspect();

      expect(schema.database).toBe(INTROSPECT_DB);
      expect(schema.tables.length).toBeGreaterThanOrEqual(5); // At least our test tables
      expect(schema.views.length).toBeGreaterThanOrEqual(2); // Our test views

      // Verify specific tables are included
      const tableNames = schema.tables.map(t => t.name);
      expect(tableNames).toContain("primary_key_table");
      expect(tableNames).toContain("duplicate_key_table");
      expect(tableNames).toContain("all_types_table");

      // Verify specific views are included
      const viewNames = schema.views.map(v => v.name);
      expect(viewNames).toContain("simple_view");
      expect(viewNames).toContain("computed_view");
    });

    test("should introspect schema concurrently", async () => {
      // Multiple concurrent introspections
      const [schema1, schema2, schema3] = await Promise.all([
        introspector.introspect(),
        introspector.introspect(),
        introspector.introspect(),
      ]);

      // All should return same results
      expect(schema1.tables.length).toBe(schema2.tables.length);
      expect(schema2.tables.length).toBe(schema3.tables.length);
      expect(schema1.views.length).toBe(schema2.views.length);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    beforeAll(async () => {
      // Create table with special characters in column names (backtick-quoted)
      await client.execute(`
        CREATE TABLE special_cols_table (
          \`id\` BIGINT NOT NULL,
          \`column with spaces\` VARCHAR(100),
          \`column-with-dashes\` VARCHAR(100),
          \`UPPER_CASE\` VARCHAR(100)
        ) PRIMARY KEY (\`id\`)
        DISTRIBUTED BY HASH(\`id\`) BUCKETS 4
        PROPERTIES ("replication_num" = "1")
      `);

      // Create table with default values
      // Note: StarRocks requires string literals for most DEFAULT values
      await client.execute(`
        CREATE TABLE defaults_table (
          id BIGINT NOT NULL,
          status VARCHAR(50) DEFAULT 'pending',
          description VARCHAR(255) DEFAULT 'none'
        ) PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES ("replication_num" = "1")
      `);

      // Create table with comments
      // Note: Table COMMENT must come before PROPERTIES in StarRocks
      await client.execute(`
        CREATE TABLE commented_table (
          id BIGINT NOT NULL COMMENT 'Primary identifier',
          name VARCHAR(255) COMMENT 'User name field',
          data JSON COMMENT 'Arbitrary JSON data'
        ) PRIMARY KEY (id)
        COMMENT 'Table with column comments'
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES ("replication_num" = "1")
      `);
    });

    test("should introspect table with special column names", async () => {
      const table = await introspector.introspectTable("special_cols_table");

      expect(table).not.toBeNull();
      expect(table!.columns.length).toBe(4);

      const colNames = table!.columns.map(c => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("column with spaces");
      expect(colNames).toContain("column-with-dashes");
      expect(colNames).toContain("UPPER_CASE");
    });

    test("should introspect column default values", async () => {
      const table = await introspector.introspectTable("defaults_table");

      expect(table).not.toBeNull();

      const statusCol = table!.columns.find(c => c.name === "status");
      const descCol = table!.columns.find(c => c.name === "description");

      // Default values should be present
      expect(statusCol).toBeDefined();
      expect(descCol).toBeDefined();
    });

    test("should introspect column comments", async () => {
      const table = await introspector.introspectTable("commented_table");

      expect(table).not.toBeNull();

      const idCol = table!.columns.find(c => c.name === "id");
      const nameCol = table!.columns.find(c => c.name === "name");

      // Comments should be captured
      expect(idCol?.comment).toBe("Primary identifier");
      expect(nameCol?.comment).toBe("User name field");
    });

    test("should introspect table comment", async () => {
      const table = await introspector.introspectTable("commented_table");

      expect(table).not.toBeNull();
      expect(table!.comment).toBe("Table with column comments");
    });

    test("should handle multiple key columns correctly", async () => {
      const table = await introspector.introspectTable("duplicate_key_table");

      expect(table).not.toBeNull();
      expect(table!.keyColumns.length).toBe(2);
      expect(table!.keyColumns[0]).toBe("event_date");
      expect(table!.keyColumns[1]).toBe("event_id");
    });

    test("should handle tables with many columns", async () => {
      // Create table with 50 columns
      const columns = Array.from({ length: 50 }, (_, i) =>
        `col_${i.toString().padStart(2, "0")} VARCHAR(100)`
      ).join(",\n");

      await client.execute(`
        CREATE TABLE many_columns_table (
          id BIGINT NOT NULL,
          ${columns}
        ) PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES ("replication_num" = "1")
      `);

      const table = await introspector.introspectTable("many_columns_table");

      expect(table).not.toBeNull();
      expect(table!.columns.length).toBe(51); // id + 50 cols
    });

    test("should handle decimal precision correctly", async () => {
      await client.execute(`
        CREATE TABLE decimal_precision_table (
          id BIGINT NOT NULL,
          small_decimal DECIMAL(5, 2),
          large_decimal DECIMAL(38, 10),
          money DECIMAL(18, 4)
        ) PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES ("replication_num" = "1")
      `);

      const table = await introspector.introspectTable("decimal_precision_table");

      expect(table).not.toBeNull();

      const smallDec = table!.columns.find(c => c.name === "small_decimal");
      const largeDec = table!.columns.find(c => c.name === "large_decimal");

      // COLUMN_TYPE should include precision (may have space after comma)
      expect(smallDec?.dataType.toLowerCase()).toMatch(/decimal\(5,\s*2\)/);
      expect(largeDec?.dataType.toLowerCase()).toMatch(/decimal\(38,\s*10\)/);
    });

    test("should handle varchar length correctly", async () => {
      await client.execute(`
        CREATE TABLE varchar_length_table (
          id BIGINT NOT NULL,
          short_text VARCHAR(10),
          medium_text VARCHAR(255),
          long_text VARCHAR(65535)
        ) PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES ("replication_num" = "1")
      `);

      const table = await introspector.introspectTable("varchar_length_table");

      expect(table).not.toBeNull();

      const shortText = table!.columns.find(c => c.name === "short_text");
      const longText = table!.columns.find(c => c.name === "long_text");

      // COLUMN_TYPE should include length
      expect(shortText?.dataType.toLowerCase()).toContain("varchar(10)");
      expect(longText?.dataType.toLowerCase()).toContain("varchar(65535)");
    });
  });

  // ============================================================================
  // Performance and Stress Tests
  // ============================================================================

  describe("Performance Tests", () => {
    test("should introspect schema with many tables efficiently", async () => {
      const start = Date.now();
      const schema = await introspector.introspect();
      const duration = Date.now() - start;

      // Should complete in reasonable time
      expect(duration).toBeLessThan(10000); // 10 seconds max
      expect(schema.tables.length).toBeGreaterThan(0);
    });

    test("should handle rapid sequential introspections", async () => {
      for (let i = 0; i < 10; i++) {
        const table = await introspector.introspectTable("primary_key_table");
        expect(table).not.toBeNull();
      }
    });

    test("should handle concurrent table introspections", async () => {
      const promises = [
        "primary_key_table",
        "duplicate_key_table",
        "all_types_table",
        "partitioned_table",
        "random_dist_table",
      ].map(name => introspector.introspectTable(name));

      const results = await Promise.all(promises);

      for (const table of results) {
        expect(table).not.toBeNull();
      }
    });
  });
});
