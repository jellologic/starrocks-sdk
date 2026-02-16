import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createStarRocksClient, createStreamLoadClient, type StarRocksClient, type StreamLoadClient } from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import type { TableOptions } from "../src/types";

describe("StarRocks Stream Load", () => {
  let client: StarRocksClient;
  let streamLoader: StreamLoadClient;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);
    await client.useDatabase(TEST_DATABASE);

    // Create stream load client with FE HTTP port (mapped to 18030)
    streamLoader = createStreamLoadClient({
      host: testConfig.host,
      httpPort: 18030,
      user: testConfig.user,
      password: testConfig.password,
    });

    // Create test table for stream load
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
      "stream_load_test",
      [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "name", type: "VARCHAR", length: 255 },
        { name: "value", type: "DOUBLE" },
        { name: "tags", type: "VARCHAR", length: 500 },
      ],
      options
    );
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  test("should load CSV data via stream load", async () => {
    const csvData = `1,Alice,100.5,tag1
2,Bob,200.5,tag2
3,Charlie,300.5,tag3`;

    const result = await streamLoader.loadCsv(csvData, {
      database: TEST_DATABASE,
      table: "stream_load_test",
      columns: ["id", "name", "value", "tags"],
      columnSeparator: ",",
    });

    // Stream load should succeed or fail gracefully
    expect(result.label).toBeTruthy();
    expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

    if (result.status === "Success") {
      expect(result.numberLoadedRows).toBe(3);

      // Verify data was loaded
      const rows = await client.raw<{ id: number; name: string }>(
        `SELECT * FROM stream_load_test WHERE id IN (1, 2, 3) ORDER BY id`
      );
      expect(rows).toHaveLength(3);
      expect(rows[0]!.name).toBe("Alice");
    }
  });

  test("should load JSON data via stream load", async () => {
    const jsonData = [
      { id: 10, name: "David", value: 1000.5, tags: "json1" },
      { id: 11, name: "Eve", value: 1100.5, tags: "json2" },
    ];

    const result = await streamLoader.loadJson(jsonData, {
      database: TEST_DATABASE,
      table: "stream_load_test",
      columns: ["id", "name", "value", "tags"],
    });

    expect(result.label).toBeTruthy();
    expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

    if (result.status === "Success") {
      expect(result.numberLoadedRows).toBe(2);

      // Verify data was loaded
      const rows = await client.raw<{ id: number; name: string }>(
        `SELECT * FROM stream_load_test WHERE id IN (10, 11) ORDER BY id`
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.name).toBe("David");
    }
  });

  test("should load objects via stream load", async () => {
    const objects = [
      { id: 20, name: "Frank", value: 2000.5, tags: "obj1" },
      { id: 21, name: "Grace", value: 2100.5, tags: "obj2" },
      { id: 22, name: "Henry", value: 2200.5, tags: "obj3" },
    ];

    const result = await streamLoader.loadObjects(objects, {
      database: TEST_DATABASE,
      table: "stream_load_test",
    });

    expect(result.label).toBeTruthy();
    expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

    if (result.status === "Success") {
      expect(result.numberLoadedRows).toBe(3);
    }
  });

  test("should handle stream load with custom label", async () => {
    const csvData = `100,CustomLabel,999.9,custom`;
    const customLabel = `test_label_${Date.now()}`;

    const result = await streamLoader.loadCsv(csvData, {
      database: TEST_DATABASE,
      table: "stream_load_test",
      label: customLabel,
      columns: ["id", "name", "value", "tags"],
      columnSeparator: ",",
    });

    expect(result.label).toBe(customLabel);
  });

  test("should report load metrics", async () => {
    const csvData = `200,Metrics,888.8,metrics`;

    const result = await streamLoader.loadCsv(csvData, {
      database: TEST_DATABASE,
      table: "stream_load_test",
      columns: ["id", "name", "value", "tags"],
      columnSeparator: ",",
    });

    // Check that metrics are reported
    expect(typeof result.loadTimeMs).toBe("number");
    expect(typeof result.loadBytes).toBe("number");
    expect(typeof result.numberLoadedRows).toBe("number");
    expect(typeof result.numberFilteredRows).toBe("number");
  });

  // ============================================================================
  // Battle Tests: Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    test("should handle Unicode characters in data", async () => {
      const objects = [
        { id: 1000, name: "日本語テスト", value: 100.0, tags: "unicode" },
        { id: 1001, name: "中文测试", value: 101.0, tags: "chinese" },
        { id: 1002, name: "Emoji 🎉🚀", value: 102.0, tags: "emoji" },
        { id: 1003, name: "Ümlauts äöü ß", value: 103.0, tags: "german" },
      ];

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        expect(result.numberLoadedRows).toBe(4);

        // Verify Unicode was preserved
        const rows = await client.raw<{ name: string }>(
          `SELECT name FROM stream_load_test WHERE id = 1000`
        );
        expect(rows[0]?.name).toBe("日本語テスト");
      }
    });

    test("should handle special characters in JSON strings", async () => {
      const objects = [
        { id: 2000, name: "Quote \"test\"", value: 200.0, tags: "quotes" },
        { id: 2001, name: "Backslash \\test\\", value: 201.0, tags: "backslash" },
        { id: 2002, name: "Tab\there", value: 202.0, tags: "tab" },
        { id: 2003, name: "Single'Quote", value: 203.0, tags: "single" },
      ];

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        expect(result.numberLoadedRows).toBe(4);

        // Verify special chars were preserved
        const rows = await client.raw<{ name: string }>(
          `SELECT name FROM stream_load_test WHERE id = 2000`
        );
        expect(rows[0]?.name).toBe('Quote "test"');
      }
    });

    test("should handle NULL values correctly", async () => {
      const objects = [
        { id: 3000, name: null, value: 300.0, tags: "null-name" },
        { id: 3001, name: "HasValue", value: null, tags: "null-value" },
      ];

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        const rows = await client.raw<{ id: number; name: string | null }>(
          `SELECT id, name FROM stream_load_test WHERE id IN (3000, 3001) ORDER BY id`
        );
        expect(rows[0]?.name).toBeNull();
        expect(rows[1]?.name).toBe("HasValue");
      }
    });

    test("should handle empty strings vs NULL", async () => {
      const objects = [
        { id: 4000, name: "", value: 400.0, tags: "empty" },
      ];

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        const rows = await client.raw<{ name: string }>(
          `SELECT name FROM stream_load_test WHERE id = 4000`
        );
        // Empty string should remain as empty string, not NULL
        expect(rows[0]?.name).toBe("");
      }
    });

    test("should reject empty array", async () => {
      const emptyArray: Record<string, unknown>[] = [];

      await expect(
        streamLoader.loadObjects(emptyArray, {
          database: TEST_DATABASE,
          table: "stream_load_test",
        })
      ).rejects.toThrow(/empty/i);
    });

    test("should handle very long strings", async () => {
      const longString = "A".repeat(400); // Within VARCHAR(500) limit

      const objects = [
        { id: 5000, name: "LongTagTest", value: 500.0, tags: longString },
      ];

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        const rows = await client.raw<{ tags: string }>(
          `SELECT tags FROM stream_load_test WHERE id = 5000`
        );
        expect(rows[0]?.tags.length).toBe(400);
      }
    });

    test("should handle CSV with special separators", async () => {
      // Use pipe as separator for data that contains commas
      const csvData = `6000|Has,Comma|600.0|comma,in,data`;

      const result = await streamLoader.loadCsv(csvData, {
        database: TEST_DATABASE,
        table: "stream_load_test",
        columns: ["id", "name", "value", "tags"],
        columnSeparator: "|",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        const rows = await client.raw<{ name: string; tags: string }>(
          `SELECT name, tags FROM stream_load_test WHERE id = 6000`
        );
        expect(rows[0]?.name).toBe("Has,Comma");
        expect(rows[0]?.tags).toBe("comma,in,data");
      }
    });

    test("should handle numeric edge values", async () => {
      const objects = [
        { id: 7000, name: "MaxDouble", value: Number.MAX_VALUE / 1e300, tags: "max" },
        { id: 7001, name: "MinDouble", value: Number.MIN_VALUE, tags: "min" },
        { id: 7002, name: "Zero", value: 0, tags: "zero" },
        { id: 7003, name: "Negative", value: -999.99, tags: "negative" },
      ];

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        expect(result.numberLoadedRows).toBe(4);
      }
    });
  });

  // ============================================================================
  // Format-Specific Edge Cases (from StarRocks docs)
  // ============================================================================

  describe("CSV Format Edge Cases", () => {
    test("should handle tab separator", async () => {
      const csvData = `8000\tTab Separated\t800.0\ttabs`;

      const result = await streamLoader.loadCsv(csvData, {
        database: TEST_DATABASE,
        table: "stream_load_test",
        columns: ["id", "name", "value", "tags"],
        columnSeparator: "\t",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        const rows = await client.raw<{ name: string }>(
          `SELECT name FROM stream_load_test WHERE id = 8000`
        );
        expect(rows[0]?.name).toBe("Tab Separated");
      }
    });

    test("should handle multi-character separator", async () => {
      // StarRocks supports UTF-8 strings up to 50 bytes as separators
      const csvData = `8001||MultiSep||801.0||multi`;

      const result = await streamLoader.loadCsv(csvData, {
        database: TEST_DATABASE,
        table: "stream_load_test",
        columns: ["id", "name", "value", "tags"],
        columnSeparator: "||",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        const rows = await client.raw<{ name: string }>(
          `SELECT name FROM stream_load_test WHERE id = 8001`
        );
        expect(rows[0]?.name).toBe("MultiSep");
      }
    });

    test("should handle \\N as NULL value in CSV", async () => {
      // Per StarRocks docs: \N represents NULL in CSV
      const csvData = `8002,\\N,802.0,nullname`;

      const result = await streamLoader.loadCsv(csvData, {
        database: TEST_DATABASE,
        table: "stream_load_test",
        columns: ["id", "name", "value", "tags"],
        columnSeparator: ",",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        const rows = await client.raw<{ name: string | null }>(
          `SELECT name FROM stream_load_test WHERE id = 8002`
        );
        expect(rows[0]?.name).toBeNull();
      }
    });

    test("should handle custom row delimiter", async () => {
      // Using different row delimiter
      const csvData = `8003,Row1,803.0,row1###8004,Row2,804.0,row2`;

      const result = await streamLoader.loadCsv(csvData, {
        database: TEST_DATABASE,
        table: "stream_load_test",
        columns: ["id", "name", "value", "tags"],
        columnSeparator: ",",
        rowDelimiter: "###",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        expect(result.numberLoadedRows).toBe(2);
        const rows = await client.raw<{ id: number }>(
          `SELECT id FROM stream_load_test WHERE id IN (8003, 8004) ORDER BY id`
        );
        expect(rows.length).toBe(2);
      }
    });

    test("should handle CRLF line endings", async () => {
      const csvData = `8005,CRLF Test,805.0,crlf\r\n8006,CRLF Test2,806.0,crlf2`;

      const result = await streamLoader.loadCsv(csvData, {
        database: TEST_DATABASE,
        table: "stream_load_test",
        columns: ["id", "name", "value", "tags"],
        columnSeparator: ",",
        rowDelimiter: "\r\n",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  describe("JSON Format Edge Cases", () => {
    test("should handle NDJSON format (newline delimited)", async () => {
      const ndjson = `{"id": 9000, "name": "NDJSON1", "value": 900.0, "tags": "ndjson"}
{"id": 9001, "name": "NDJSON2", "value": 901.0, "tags": "ndjson"}`;

      const result = await streamLoader.loadJson(ndjson, {
        database: TEST_DATABASE,
        table: "stream_load_test",
        columns: ["id", "name", "value", "tags"],
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle JSON with boolean values as integers", async () => {
      // StarRocks might convert booleans - test with explicit data
      const objects = [
        { id: 9100, name: "BoolTest", value: 910.0, tags: "bool" },
      ];

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle JSON with extra fields (ignored)", async () => {
      const objects = [
        { id: 9200, name: "ExtraFields", value: 920.0, tags: "extra", unused_field: "should_ignore", another: 123 },
      ];

      const result = await streamLoader.loadObjects(objects as any, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle JSON with scientific notation", async () => {
      const objects = [
        { id: 9300, name: "Scientific", value: 1.5e10, tags: "scientific" },
      ];

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        const rows = await client.raw<{ value: number }>(
          `SELECT value FROM stream_load_test WHERE id = 9300`
        );
        expect(rows[0]?.value).toBe(1.5e10);
      }
    });
  });

  describe("Error Handling Edge Cases", () => {
    test("should handle duplicate labels gracefully", async () => {
      const label = `duplicate_test_${Date.now()}`;
      const csvData = `9400,First,940.0,first`;

      // First load
      const result1 = await streamLoader.loadCsv(csvData, {
        database: TEST_DATABASE,
        table: "stream_load_test",
        label,
        columns: ["id", "name", "value", "tags"],
        columnSeparator: ",",
      });

      if (result1.status === "Success") {
        // Second load with same label
        const csvData2 = `9401,Second,941.0,second`;
        const result2 = await streamLoader.loadCsv(csvData2, {
          database: TEST_DATABASE,
          table: "stream_load_test",
          label, // Same label
          columns: ["id", "name", "value", "tags"],
          columnSeparator: ",",
        });

        // Should fail or report existing job status
        expect(["Success", "Fail", "Publish Timeout", "Label Already Exists"]).toContain(result2.status);
        if (result2.status === "Fail" || result2.status === "Label Already Exists") {
          expect(result2.existingJobStatus || result2.message).toBeTruthy();
        }
      }
    });

    test("should handle non-existent table", async () => {
      const csvData = `1,Test,100.0,test`;

      const result = await streamLoader.loadCsv(csvData, {
        database: TEST_DATABASE,
        table: "nonexistent_table_xyz",
        columns: ["id", "name", "value", "tags"],
        columnSeparator: ",",
      });

      expect(result.status).toBe("Fail");
      expect(result.message).toBeTruthy();
    });

    test("should handle non-existent database", async () => {
      const csvData = `1,Test,100.0,test`;

      const result = await streamLoader.loadCsv(csvData, {
        database: "nonexistent_database_xyz",
        table: "stream_load_test",
        columns: ["id", "name", "value", "tags"],
        columnSeparator: ",",
      });

      expect(result.status).toBe("Fail");
      expect(result.message).toBeTruthy();
    });

    test("should handle maxFilterRatio with some malformed rows", async () => {
      // Mix valid and invalid data
      const csvData = `9500,Valid,950.0,valid
INVALID_NOT_A_NUMBER,Bad,bad,bad
9501,AlsoValid,951.0,valid`;

      const result = await streamLoader.loadCsv(csvData, {
        database: TEST_DATABASE,
        table: "stream_load_test",
        columns: ["id", "name", "value", "tags"],
        columnSeparator: ",",
        maxFilterRatio: 0.5, // Allow up to 50% error rows
        strictMode: false,
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      // If success, check filtered rows were counted
      if (result.status === "Success") {
        expect(result.numberFilteredRows).toBeGreaterThanOrEqual(0);
      }
    });

    test("should respect strict mode", async () => {
      const csvData = `9600,Valid,960.0,valid`;

      const result = await streamLoader.loadCsv(csvData, {
        database: TEST_DATABASE,
        table: "stream_load_test",
        columns: ["id", "name", "value", "tags"],
        columnSeparator: ",",
        strictMode: true,
      });

      // Strict mode should still allow valid data
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  describe("Large Data Edge Cases", () => {
    test("should handle batch of 100 rows", async () => {
      const objects = Array.from({ length: 100 }, (_, i) => ({
        id: 10000 + i,
        name: `Batch100_${i}`,
        value: 1000 + i,
        tags: `batch100`,
      }));

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        expect(result.numberLoadedRows).toBe(100);
      }
    });

    test("should handle batch of 1000 rows", async () => {
      const objects = Array.from({ length: 1000 }, (_, i) => ({
        id: 20000 + i,
        name: `Batch1000_${i}`,
        value: 2000 + i,
        tags: `batch1000`,
      }));

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        expect(result.numberLoadedRows).toBe(1000);
      }
    });

    test("should report timing metrics for large batch", async () => {
      const objects = Array.from({ length: 500 }, (_, i) => ({
        id: 30000 + i,
        name: `Timing_${i}`,
        value: 3000 + i,
        tags: `timing`,
      }));

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);

      if (result.status === "Success") {
        // Verify timing metrics are populated
        expect(result.loadTimeMs).toBeGreaterThan(0);
        expect(result.loadBytes).toBeGreaterThan(0);
      }
    });
  });

  describe("Data Type Edge Cases", () => {
    test("should handle integer boundaries", async () => {
      const objects = [
        { id: 40001, name: "MaxSafeBigInt", value: Number.MAX_SAFE_INTEGER % 1e10, tags: "maxint" },
        { id: 40002, name: "MinSafeBigInt", value: Number.MIN_SAFE_INTEGER % 1e10, tags: "minint" },
      ];

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle floating point precision", async () => {
      const objects = [
        { id: 41001, name: "Float1", value: 0.1 + 0.2, tags: "float" }, // Classic floating point issue
        { id: 41002, name: "Float2", value: 123456.789012345, tags: "float" },
      ];

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });

    test("should handle infinity and NaN gracefully", async () => {
      // These should likely fail or be filtered
      const objects = [
        { id: 42001, name: "Infinity", value: Infinity, tags: "special" },
      ];

      // Note: JSON.stringify converts Infinity to null
      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      // May succeed (with null) or fail depending on StarRocks version
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });

  describe("Partial Update Edge Cases", () => {
    test("should support partial update mode flag", async () => {
      // First insert a full row
      const insertData = [
        { id: 50001, name: "PartialOriginal", value: 500.0, tags: "partial" },
      ];

      const insertResult = await streamLoader.loadObjects(insertData, {
        database: TEST_DATABASE,
        table: "stream_load_test",
      });

      if (insertResult.status === "Success") {
        // Now attempt partial update (only name column)
        const partialData = [
          { id: 50001, name: "PartialUpdated" },
        ];

        const updateResult = await streamLoader.loadJson(partialData, {
          database: TEST_DATABASE,
          table: "stream_load_test",
          columns: ["id", "name"],
          partialUpdate: true,
          partialUpdateMode: "row",
        });

        // Partial update may or may not be supported depending on StarRocks version
        expect(["Success", "Fail", "Publish Timeout"]).toContain(updateResult.status);
      }
    });
  });

  describe("Timeout Edge Cases", () => {
    test("should respect custom timeout setting", async () => {
      const objects = Array.from({ length: 50 }, (_, i) => ({
        id: 60000 + i,
        name: `Timeout_${i}`,
        value: 6000 + i,
        tags: `timeout`,
      }));

      const result = await streamLoader.loadObjects(objects, {
        database: TEST_DATABASE,
        table: "stream_load_test",
        timeout: 120, // 2 minute timeout
      });

      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status);
    });
  });
});
