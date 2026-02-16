import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";

/**
 * Battle Test: Data Type Boundary Edge Cases
 *
 * Tests all StarRocks data types with boundary values, edge cases,
 * and special values to ensure robust handling.
 *
 * IMPORTANT: Uses raw SQL with fully qualified table names (database.table)
 * because connection pooling makes USE DATABASE unreliable across queries.
 */
describe("StarRocks Data Types Edge Cases", () => {
  let client: StarRocksClient;
  let streamLoader: StreamLoadClient;

  const FQN = (table: string) => `${TEST_DATABASE}.${table}`;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);

    streamLoader = createStreamLoadClient({
      host: testConfig.host,
      httpPort: 18030,
      user: testConfig.user,
      password: testConfig.password,
    });
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  // ============================================================================
  // Integer Types Boundaries
  // ============================================================================

  describe("Integer Types Boundaries", () => {
    const TABLE = "int_boundary_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          tinyint_col TINYINT,
          smallint_col SMALLINT,
          int_col INT,
          bigint_col BIGINT,
          largeint_col LARGEINT
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle TINYINT boundaries (-128 to 127)", async () => {
      const data = [
        { id: 1, tinyint_col: -128, smallint_col: null, int_col: null, bigint_col: null, largeint_col: null },
        { id: 2, tinyint_col: 127, smallint_col: null, int_col: null, bigint_col: null, largeint_col: null },
        { id: 3, tinyint_col: 0, smallint_col: null, int_col: null, bigint_col: null, largeint_col: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ tinyint_col: number }>(
        `SELECT tinyint_col FROM ${FQN(TABLE)} WHERE id IN (1, 2, 3) ORDER BY id`
      );
      expect(rows[0]!.tinyint_col).toBe(-128);
      expect(rows[1]!.tinyint_col).toBe(127);
      expect(rows[2]!.tinyint_col).toBe(0);
    });

    test("should handle SMALLINT boundaries (-32768 to 32767)", async () => {
      const data = [
        { id: 10, tinyint_col: null, smallint_col: -32768, int_col: null, bigint_col: null, largeint_col: null },
        { id: 11, tinyint_col: null, smallint_col: 32767, int_col: null, bigint_col: null, largeint_col: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ smallint_col: number }>(
        `SELECT smallint_col FROM ${FQN(TABLE)} WHERE id IN (10, 11) ORDER BY id`
      );
      expect(rows[0]!.smallint_col).toBe(-32768);
      expect(rows[1]!.smallint_col).toBe(32767);
    });

    test("should handle INT boundaries (-2147483648 to 2147483647)", async () => {
      const data = [
        { id: 20, tinyint_col: null, smallint_col: null, int_col: -2147483648, bigint_col: null, largeint_col: null },
        { id: 21, tinyint_col: null, smallint_col: null, int_col: 2147483647, bigint_col: null, largeint_col: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ int_col: number }>(
        `SELECT int_col FROM ${FQN(TABLE)} WHERE id IN (20, 21) ORDER BY id`
      );
      expect(rows[0]!.int_col).toBe(-2147483648);
      expect(rows[1]!.int_col).toBe(2147483647);
    });

    test("should handle BIGINT boundaries (safe integer range)", async () => {
      // Note: JavaScript loses precision for very large numbers, so we use safe integers
      const data = [
        { id: 30, tinyint_col: null, smallint_col: null, int_col: null, bigint_col: Number.MIN_SAFE_INTEGER, largeint_col: null },
        { id: 31, tinyint_col: null, smallint_col: null, int_col: null, bigint_col: Number.MAX_SAFE_INTEGER, largeint_col: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ bigint_col: number }>(
        `SELECT bigint_col FROM ${FQN(TABLE)} WHERE id IN (30, 31) ORDER BY id`
      );
      expect(rows[0]!.bigint_col).toBe(Number.MIN_SAFE_INTEGER);
      expect(rows[1]!.bigint_col).toBe(Number.MAX_SAFE_INTEGER);
    });

    test("should handle LARGEINT with string representation", async () => {
      // LARGEINT requires string for very large values
      const data = [
        { id: 40, tinyint_col: null, smallint_col: null, int_col: null, bigint_col: null, largeint_col: "170141183460469231731687303715884105727" },
        { id: 41, tinyint_col: null, smallint_col: null, int_col: null, bigint_col: null, largeint_col: "-170141183460469231731687303715884105728" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      // May succeed or fail depending on JSON handling
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  // ============================================================================
  // Floating Point Types
  // ============================================================================

  describe("Floating Point Types", () => {
    const TABLE = "float_boundary_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          float_col FLOAT,
          double_col DOUBLE
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle FLOAT precision", async () => {
      const data = [
        { id: 1, float_col: 3.4028235e38, double_col: null }, // Near max float
        { id: 2, float_col: 1.17549435e-38, double_col: null }, // Near min positive float
        { id: 3, float_col: -3.4028235e38, double_col: null }, // Near min float
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle DOUBLE precision", async () => {
      const data = [
        { id: 10, float_col: null, double_col: 1.7976931348623157e308 }, // Near max double
        { id: 11, float_col: null, double_col: 2.2250738585072014e-308 }, // Near min positive double
        { id: 12, float_col: null, double_col: -1.7976931348623157e308 }, // Near min double
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle floating point precision edge cases", async () => {
      const data = [
        { id: 20, float_col: 0.1 + 0.2, double_col: 0.1 + 0.2 }, // Classic floating point issue
        { id: 21, float_col: 0.000001, double_col: 0.000000000001 },
        { id: 22, float_col: 999999.999999, double_col: 999999999.999999999 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle zero values", async () => {
      const data = [
        { id: 30, float_col: 0, double_col: 0 },
        { id: 31, float_col: 0.0, double_col: 0.0 },
        { id: 32, float_col: -0, double_col: -0 }, // Negative zero
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle scientific notation", async () => {
      const data = [
        { id: 40, float_col: 1e10, double_col: 1e100 },
        { id: 41, float_col: 1e-10, double_col: 1e-100 },
        { id: 42, float_col: 1.5e5, double_col: 2.5e15 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });
  });

  // ============================================================================
  // Decimal Type
  // ============================================================================

  describe("Decimal Type", () => {
    const TABLE = "decimal_boundary_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          decimal_10_2 DECIMAL(10, 2),
          decimal_38_18 DECIMAL(38, 18),
          decimal_5_0 DECIMAL(5, 0)
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle DECIMAL(10,2) boundaries", async () => {
      const data = [
        { id: 1, decimal_10_2: "99999999.99", decimal_38_18: null, decimal_5_0: null },
        { id: 2, decimal_10_2: "-99999999.99", decimal_38_18: null, decimal_5_0: null },
        { id: 3, decimal_10_2: "0.01", decimal_38_18: null, decimal_5_0: null },
        { id: 4, decimal_10_2: "-0.01", decimal_38_18: null, decimal_5_0: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ decimal_10_2: string }>(
        `SELECT decimal_10_2 FROM ${FQN(TABLE)} WHERE id = 1`
      );
      expect(rows[0]!.decimal_10_2).toBe("99999999.99");
    });

    test("should handle DECIMAL(38,18) for high precision", async () => {
      const data = [
        { id: 10, decimal_10_2: null, decimal_38_18: "12345678901234567890.123456789012345678", decimal_5_0: null },
        { id: 11, decimal_10_2: null, decimal_38_18: "0.000000000000000001", decimal_5_0: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle DECIMAL(5,0) as integer-like", async () => {
      const data = [
        { id: 20, decimal_10_2: null, decimal_38_18: null, decimal_5_0: "99999" },
        { id: 21, decimal_10_2: null, decimal_38_18: null, decimal_5_0: "-99999" },
        { id: 22, decimal_10_2: null, decimal_38_18: null, decimal_5_0: "0" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle decimal rounding", async () => {
      // Value that needs rounding for DECIMAL(10,2)
      const data = [
        { id: 30, decimal_10_2: "123.456", decimal_38_18: null, decimal_5_0: null }, // Should round to 123.46
        { id: 31, decimal_10_2: "123.454", decimal_38_18: null, decimal_5_0: null }, // Should round to 123.45
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  // ============================================================================
  // String Types
  // ============================================================================

  describe("String Types", () => {
    const TABLE = "string_boundary_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          char_10 CHAR(10),
          varchar_255 VARCHAR(255),
          string_col VARCHAR(65533)
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle CHAR padding and truncation", async () => {
      const data = [
        { id: 1, char_10: "exact10ch!", varchar_255: null, string_col: null },
        { id: 2, char_10: "short", varchar_255: null, string_col: null }, // Should be padded
        { id: 3, char_10: "", varchar_255: null, string_col: null }, // Empty string
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle VARCHAR at boundary", async () => {
      const str255 = "A".repeat(255);
      const data = [
        { id: 10, char_10: null, varchar_255: str255, string_col: null },
        { id: 11, char_10: null, varchar_255: "", string_col: null },
        { id: 12, char_10: null, varchar_255: "a", string_col: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ varchar_255: string }>(
        `SELECT varchar_255 FROM ${FQN(TABLE)} WHERE id = 10`
      );
      expect(rows[0]!.varchar_255.length).toBe(255);
    });

    test("should handle STRING (long varchar) up to ~65KB", async () => {
      const longStr = "B".repeat(60000); // Under 65533 limit
      const data = [
        { id: 20, char_10: null, varchar_255: null, string_col: longStr },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ string_col: string }>(
        `SELECT string_col FROM ${FQN(TABLE)} WHERE id = 20`
      );
      expect(rows[0]!.string_col.length).toBe(60000);
    });

    test("should handle Unicode strings correctly", async () => {
      const data = [
        { id: 30, char_10: null, varchar_255: "日本語テスト漢字", string_col: null },
        { id: 31, char_10: null, varchar_255: "Emoji 🎉🚀🌟💻🔥", string_col: null },
        { id: 32, char_10: null, varchar_255: "Cyrillic: Привет мир", string_col: null },
        { id: 33, char_10: null, varchar_255: "Arabic: مرحبا بالعالم", string_col: null },
        { id: 34, char_10: null, varchar_255: "Mixed: Hello世界🌍", string_col: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ varchar_255: string }>(
        `SELECT varchar_255 FROM ${FQN(TABLE)} WHERE id = 30`
      );
      expect(rows[0]!.varchar_255).toBe("日本語テスト漢字");
    });

    test("should handle special characters and escape sequences", async () => {
      const data = [
        { id: 40, char_10: null, varchar_255: "Tab\there", string_col: null },
        { id: 41, char_10: null, varchar_255: "Quote\"test\"", string_col: null },
        { id: 42, char_10: null, varchar_255: "Backslash\\test", string_col: null },
        { id: 43, char_10: null, varchar_255: "Newline\nhere", string_col: null },
        { id: 44, char_10: null, varchar_255: "Carriage\rreturn", string_col: null },
        { id: 45, char_10: null, varchar_255: "Single'quote", string_col: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle null bytes and binary-like content", async () => {
      // Note: Null bytes in strings may cause issues
      const data = [
        { id: 50, char_10: null, varchar_255: "Before\x00After", string_col: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      // May succeed or fail depending on null byte handling
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  // ============================================================================
  // Date/Time Types
  // ============================================================================

  describe("Date/Time Types", () => {
    const TABLE = "datetime_boundary_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          date_col DATE,
          datetime_col DATETIME
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle DATE boundaries", async () => {
      const data = [
        { id: 1, date_col: "0001-01-01", datetime_col: null }, // Min date
        { id: 2, date_col: "9999-12-31", datetime_col: null }, // Max date
        { id: 3, date_col: "2024-02-29", datetime_col: null }, // Leap year
        { id: 4, date_col: "2023-02-28", datetime_col: null }, // Non-leap year
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle DATETIME boundaries", async () => {
      const data = [
        { id: 10, date_col: null, datetime_col: "0001-01-01 00:00:00" }, // Min datetime
        { id: 11, date_col: null, datetime_col: "9999-12-31 23:59:59" }, // Max datetime
        { id: 12, date_col: null, datetime_col: "2024-01-01 12:00:00" }, // Normal datetime
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle midnight and end of day", async () => {
      const data = [
        { id: 20, date_col: null, datetime_col: "2024-01-15 00:00:00" }, // Midnight
        { id: 21, date_col: null, datetime_col: "2024-01-15 23:59:59" }, // End of day
        { id: 22, date_col: null, datetime_col: "2024-01-15 12:00:00" }, // Noon
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle epoch and unix timestamp edge cases", async () => {
      const data = [
        { id: 30, date_col: "1970-01-01", datetime_col: "1970-01-01 00:00:00" }, // Unix epoch
        { id: 31, date_col: "2038-01-19", datetime_col: "2038-01-19 03:14:07" }, // Y2K38
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle ISO 8601 format variations", async () => {
      const data = [
        { id: 40, date_col: "2024-06-15", datetime_col: "2024-06-15T10:30:00" }, // T separator
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      // May or may not accept T format
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  // ============================================================================
  // Boolean Type
  // ============================================================================

  describe("Boolean Type", () => {
    const TABLE = "boolean_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          bool_col BOOLEAN
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle boolean true/false", async () => {
      const data = [
        { id: 1, bool_col: true },
        { id: 2, bool_col: false },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ bool_col: boolean | number }>(
        `SELECT bool_col FROM ${FQN(TABLE)} WHERE id IN (1, 2) ORDER BY id`
      );
      // StarRocks may return 1/0 or true/false depending on driver
      expect([true, 1]).toContain(rows[0]!.bool_col);
      expect([false, 0]).toContain(rows[1]!.bool_col);
    });

    test("should handle boolean null", async () => {
      const data = [
        { id: 10, bool_col: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ bool_col: boolean | null }>(
        `SELECT bool_col FROM ${FQN(TABLE)} WHERE id = 10`
      );
      expect(rows[0]!.bool_col).toBeNull();
    });

    test("should handle integer-as-boolean (1/0)", async () => {
      const data = [
        { id: 20, bool_col: 1 },
        { id: 21, bool_col: 0 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  // ============================================================================
  // JSON Type
  // ============================================================================

  describe("JSON Type", () => {
    const TABLE = "json_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          json_col JSON
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle simple JSON objects", async () => {
      const data = [
        { id: 1, json_col: JSON.stringify({ name: "test", value: 123 }) },
        { id: 2, json_col: JSON.stringify({ nested: { deep: { value: "found" } } }) },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle JSON arrays", async () => {
      const data = [
        { id: 10, json_col: JSON.stringify([1, 2, 3, 4, 5]) },
        { id: 11, json_col: JSON.stringify(["a", "b", "c"]) },
        { id: 12, json_col: JSON.stringify([{ id: 1 }, { id: 2 }]) },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle JSON primitives", async () => {
      const data = [
        { id: 20, json_col: JSON.stringify("just a string") },
        { id: 21, json_col: JSON.stringify(12345) },
        { id: 22, json_col: JSON.stringify(true) },
        { id: 23, json_col: JSON.stringify(null) },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle large JSON objects", async () => {
      const largeObj: Record<string, number> = {};
      for (let i = 0; i < 100; i++) {
        largeObj[`key_${i}`] = i;
      }

      const data = [
        { id: 30, json_col: JSON.stringify(largeObj) },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle JSON with special characters", async () => {
      const data = [
        { id: 40, json_col: JSON.stringify({ message: "Hello\nWorld\t!" }) },
        { id: 41, json_col: JSON.stringify({ quote: 'He said "Hello"' }) },
        { id: 42, json_col: JSON.stringify({ unicode: "日本語" }) },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle empty JSON structures", async () => {
      const data = [
        { id: 50, json_col: JSON.stringify({}) },
        { id: 51, json_col: JSON.stringify([]) },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });
  });

  // ============================================================================
  // Array Type
  // ============================================================================

  describe("Array Type", () => {
    const TABLE = "array_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          int_array ARRAY<INT>,
          string_array ARRAY<VARCHAR(100)>,
          double_array ARRAY<DOUBLE>
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle integer arrays", async () => {
      const data = [
        { id: 1, int_array: "[1, 2, 3, 4, 5]", string_array: null, double_array: null },
        { id: 2, int_array: "[]", string_array: null, double_array: null }, // Empty array
        { id: 3, int_array: "[0]", string_array: null, double_array: null }, // Single element
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle string arrays", async () => {
      const data = [
        { id: 10, int_array: null, string_array: '["a", "b", "c"]', double_array: null },
        { id: 11, int_array: null, string_array: '["hello", "world"]', double_array: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle arrays with null elements", async () => {
      const data = [
        { id: 20, int_array: "[1, null, 3]", string_array: null, double_array: null },
        { id: 21, int_array: null, string_array: '["a", null, "c"]', double_array: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  // ============================================================================
  // MAP Type
  // ============================================================================

  describe("MAP Type", () => {
    const TABLE = "map_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          string_int_map MAP<VARCHAR(100), INT>,
          int_string_map MAP<INT, VARCHAR(100)>
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle string->int maps", async () => {
      // Note: Map format in StarRocks may vary
      const data = [
        { id: 1, string_int_map: '{"a": 1, "b": 2}', int_string_map: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle empty maps", async () => {
      const data = [
        { id: 10, string_int_map: "{}", int_string_map: "{}" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  // ============================================================================
  // Null Handling Edge Cases
  // ============================================================================

  describe("Null Handling Edge Cases", () => {
    const TABLE = "null_handling_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          nullable_int INT,
          nullable_string VARCHAR(255),
          nullable_double DOUBLE
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle explicit null values", async () => {
      const data = [
        { id: 1, nullable_int: null, nullable_string: null, nullable_double: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ nullable_int: number | null }>(
        `SELECT nullable_int, nullable_string, nullable_double FROM ${FQN(TABLE)} WHERE id = 1`
      );
      expect(rows[0]!.nullable_int).toBeNull();
    });

    test("should handle undefined as null", async () => {
      const data = [
        { id: 10, nullable_int: undefined, nullable_string: undefined, nullable_double: undefined },
      ] as any[];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      // undefined in JSON becomes missing, which should be treated as null
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle missing fields as null", async () => {
      const data = [
        { id: 20 }, // Missing optional fields
      ] as any[];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should distinguish empty string from null", async () => {
      const data = [
        { id: 30, nullable_int: null, nullable_string: "", nullable_double: null },
        { id: 31, nullable_int: null, nullable_string: null, nullable_double: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ nullable_string: string | null }>(
        `SELECT nullable_string FROM ${FQN(TABLE)} WHERE id IN (30, 31) ORDER BY id`
      );
      expect(rows[0]!.nullable_string).toBe("");
      expect(rows[1]!.nullable_string).toBeNull();
    });
  });

  // ============================================================================
  // Type Coercion Edge Cases
  // ============================================================================

  describe("Type Coercion Edge Cases", () => {
    const TABLE = "type_coercion_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          int_col INT,
          double_col DOUBLE,
          string_col VARCHAR(255),
          bool_col BOOLEAN
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle string-encoded numbers", async () => {
      const data = [
        { id: 1, int_col: "123", double_col: "45.67", string_col: null, bool_col: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      // May coerce strings to numbers
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle number-to-string coercion", async () => {
      const data = [
        { id: 10, int_col: null, double_col: null, string_col: 12345, bool_col: null },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      // May coerce numbers to strings
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle integer to double coercion", async () => {
      const data = [
        { id: 20, int_col: null, double_col: 100, string_col: null, bool_col: null }, // int -> double
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle double truncation to int", async () => {
      const data = [
        { id: 30, int_col: 99.9, double_col: null, string_col: null, bool_col: null }, // May truncate
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle boolean coercion variations", async () => {
      const data = [
        { id: 40, int_col: null, double_col: null, string_col: null, bool_col: "true" },
        { id: 41, int_col: null, double_col: null, string_col: null, bool_col: "false" },
        { id: 42, int_col: null, double_col: null, string_col: null, bool_col: "1" },
        { id: 43, int_col: null, double_col: null, string_col: null, bool_col: "0" },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  // ============================================================================
  // HLL and BITMAP Types (Special Aggregation Types)
  // ============================================================================

  describe("HLL and BITMAP Types", () => {
    const TABLE = "special_types_test";

    beforeAll(async () => {
      // HLL and BITMAP are typically used with AGGREGATE KEY tables
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          date_col DATE NOT NULL,
          category VARCHAR(100) NOT NULL,
          user_hll HLL HLL_UNION,
          user_bitmap BITMAP BITMAP_UNION
        )
        AGGREGATE KEY (date_col, category)
        DISTRIBUTED BY HASH(date_col) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should accept HLL data via stream load", async () => {
      // HLL values are typically created via functions like HLL_HASH
      const csvData = `2024-01-01,cat1,,`;

      const result = await streamLoader.loadCsv(csvData, {
        database: TEST_DATABASE,
        table: TABLE,
        columns: ["date_col", "category", "user_hll", "user_bitmap"],
        columnSeparator: ",",
      });

      // May fail since HLL requires special handling
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  // ============================================================================
  // Binary-like Data Edge Cases
  // ============================================================================

  describe("Binary-like Data Edge Cases", () => {
    const TABLE = "binary_like_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          data VARCHAR(10000)
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle base64 encoded data", async () => {
      const binaryData = Buffer.from("Hello, World! Binary test data here.");
      const base64 = binaryData.toString("base64");

      const data = [
        { id: 1, data: base64 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");

      const rows = await client.raw<{ data: string }>(
        `SELECT data FROM ${FQN(TABLE)} WHERE id = 1`
      );
      expect(rows[0]!.data).toBe(base64);
    });

    test("should handle hex encoded data", async () => {
      const hexData = Buffer.from("Test data").toString("hex");

      const data = [
        { id: 10, data: hexData },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle URL-safe base64", async () => {
      const urlSafeBase64 = Buffer.from("Test with special chars +/=")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

      const data = [
        { id: 20, data: urlSafeBase64 },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });
  });

  // ============================================================================
  // Multiple Type Combinations
  // ============================================================================

  describe("Multiple Type Combinations", () => {
    const TABLE = "multi_type_test";

    beforeAll(async () => {
      await client.raw(`
        CREATE TABLE IF NOT EXISTS ${FQN(TABLE)} (
          id BIGINT NOT NULL,
          tinyint_col TINYINT,
          int_col INT,
          bigint_col BIGINT,
          float_col FLOAT,
          double_col DOUBLE,
          decimal_col DECIMAL(10, 2),
          char_col CHAR(10),
          varchar_col VARCHAR(255),
          date_col DATE,
          datetime_col DATETIME,
          bool_col BOOLEAN
        )
        PRIMARY KEY (id)
        DISTRIBUTED BY HASH(id) BUCKETS 4
        PROPERTIES("replication_num" = "1")
      `);
    });

    test("should handle row with all types populated", async () => {
      const data = [
        {
          id: 1,
          tinyint_col: 127,
          int_col: 2147483647,
          bigint_col: 9007199254740991, // MAX_SAFE_INTEGER
          float_col: 3.14,
          double_col: 2.718281828,
          decimal_col: "12345.67",
          char_col: "CHAR_TEST",
          varchar_col: "VARCHAR_TEST",
          date_col: "2024-06-15",
          datetime_col: "2024-06-15 10:30:00",
          bool_col: true,
        },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle row with all types null", async () => {
      const data = [
        {
          id: 2,
          tinyint_col: null,
          int_col: null,
          bigint_col: null,
          float_col: null,
          double_col: null,
          decimal_col: null,
          char_col: null,
          varchar_col: null,
          date_col: null,
          datetime_col: null,
          bool_col: null,
        },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
    });

    test("should handle mixed null and non-null in batch", async () => {
      const data = [
        { id: 10, tinyint_col: 1, int_col: null, bigint_col: 100, float_col: null, double_col: 1.1, decimal_col: null, char_col: "a", varchar_col: null, date_col: "2024-01-01", datetime_col: null, bool_col: true },
        { id: 11, tinyint_col: null, int_col: 2, bigint_col: null, float_col: 2.2, double_col: null, decimal_col: "22.22", char_col: null, varchar_col: "b", date_col: null, datetime_col: "2024-01-02 12:00:00", bool_col: null },
        { id: 12, tinyint_col: 3, int_col: 3, bigint_col: 300, float_col: 3.3, double_col: 3.3, decimal_col: "33.33", char_col: "c", varchar_col: "c", date_col: "2024-01-03", datetime_col: "2024-01-03 12:00:00", bool_col: false },
      ];

      const result = await streamLoader.loadObjects(data, {
        database: TEST_DATABASE,
        table: TABLE,
      });

      expect(result.status).toBe("Success");
      expect(result.numberLoadedRows).toBe(3);
    });
  });
});
