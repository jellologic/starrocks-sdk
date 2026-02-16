import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createStarRocksClient,
  createStreamLoadTransactionClient,
  TransactionError,
  type StarRocksClient,
  type StreamLoadTransactionClient,
} from "../src";
import { testConfig, TEST_DATABASE, beHttpPort } from "../src/test-config";
import type { TableOptions } from "../src/types";

describe("StarRocks Stream Load Transaction", () => {
  let client: StarRocksClient;
  let txnClient: StreamLoadTransactionClient;
  const TEST_TABLE = "txn_load_test";

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);
    await client.useDatabase(TEST_DATABASE);

    // Create transaction client with BE HTTP port directly
    // (avoids FE→BE redirect issues in Docker environments)
    txnClient = createStreamLoadTransactionClient({
      host: testConfig.host,
      httpPort: beHttpPort,
      user: testConfig.user,
      password: testConfig.password,
    });

    // Create test table for transaction loads
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
      TEST_TABLE,
      [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "name", type: "VARCHAR", length: 255 },
        { name: "value", type: "DOUBLE" },
      ],
      options
    );
  });

  afterAll(async () => {
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  /**
   * Generate a unique label for each test to avoid conflicts
   */
  function uniqueLabel(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  test("should complete transaction: begin → load → commit", async () => {
    const label = uniqueLabel("txn_commit");
    const csvData = `1001,CommitTest1,100.5
1002,CommitTest2,200.5
1003,CommitTest3,300.5`;

    // Begin transaction
    const beginResult = await txnClient.beginTransaction({
      database: TEST_DATABASE,
      table: TEST_TABLE,
      label,
    });

    expect(beginResult.status).toBe("OK");
    expect(beginResult.label).toBe(label);
    expect(beginResult.txnId).toBeGreaterThan(0);

    // Load data
    const loadResult = await txnClient.transactionLoad(
      label,
      TEST_DATABASE,
      TEST_TABLE,
      csvData,
      {
        format: "csv",
        columnSeparator: ",",
        columns: ["id", "name", "value"],
      }
    );

    expect(loadResult.status).toBe("OK");
    expect(loadResult.label).toBe(label);

    // Commit directly (without prepare)
    const commitResult = await txnClient.commitTransaction(label, TEST_DATABASE);

    expect(commitResult.status).toBe("OK");
    expect(commitResult.numberLoadedRows).toBe(3);

    // Verify data was loaded
    const rows = await client.raw<{ id: number; name: string }>(
      `SELECT * FROM ${TEST_TABLE} WHERE id IN (1001, 1002, 1003) ORDER BY id`
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]!.name).toBe("CommitTest1");
    expect(rows[2]!.name).toBe("CommitTest3");
  });

  test("should rollback transaction: begin → load → rollback", async () => {
    const label = uniqueLabel("txn_rollback");
    const csvData = `2001,Rollback1,100.5
2002,Rollback2,200.5`;

    // Begin transaction
    const beginResult = await txnClient.beginTransaction({
      database: TEST_DATABASE,
      table: TEST_TABLE,
      label,
    });

    expect(beginResult.status).toBe("OK");

    // Load data
    const loadResult = await txnClient.transactionLoad(
      label,
      TEST_DATABASE,
      TEST_TABLE,
      csvData,
      {
        format: "csv",
        columnSeparator: ",",
        columns: ["id", "name", "value"],
      }
    );

    expect(loadResult.status).toBe("OK");

    // Rollback instead of commit
    const rollbackResult = await txnClient.rollbackTransaction(label, TEST_DATABASE);

    expect(rollbackResult.status).toBe("OK");

    // Verify data was NOT loaded
    const rows = await client.raw<{ id: number }>(
      `SELECT * FROM ${TEST_TABLE} WHERE id IN (2001, 2002)`
    );

    expect(rows).toHaveLength(0);
  });

  test("should handle multi-batch loading in single transaction", async () => {
    const label = uniqueLabel("txn_multi_batch");

    // Begin transaction
    await txnClient.beginTransaction({
      database: TEST_DATABASE,
      table: TEST_TABLE,
      label,
    });

    // Load batch 1 (single row with trailing newline for proper CSV parsing)
    await txnClient.transactionLoad(
      label,
      TEST_DATABASE,
      TEST_TABLE,
      "3001,Batch1,100.0\n",
      { format: "csv", columnSeparator: ",", columns: ["id", "name", "value"] }
    );

    // Load batch 2 (single row with trailing newline)
    await txnClient.transactionLoad(
      label,
      TEST_DATABASE,
      TEST_TABLE,
      "3002,Batch2,200.0\n",
      { format: "csv", columnSeparator: ",", columns: ["id", "name", "value"] }
    );

    // Load batch 3 (single row with trailing newline)
    await txnClient.transactionLoad(
      label,
      TEST_DATABASE,
      TEST_TABLE,
      "3003,Batch3,300.0\n",
      { format: "csv", columnSeparator: ",", columns: ["id", "name", "value"] }
    );

    // Commit
    const commitResult = await txnClient.commitTransaction(label, TEST_DATABASE);
    expect(commitResult.status).toBe("OK");
    expect(commitResult.numberLoadedRows).toBe(3);

    // Verify all data was loaded
    const rows = await client.raw<{ id: number }>(
      `SELECT * FROM ${TEST_TABLE} WHERE id BETWEEN 3001 AND 3003 ORDER BY id`
    );

    expect(rows).toHaveLength(3);
  });

  test("should load JSON data in transaction", async () => {
    const label = uniqueLabel("txn_json");
    const jsonData = JSON.stringify([
      { id: 4001, name: "JsonItem1", value: 111.1 },
      { id: 4002, name: "JsonItem2", value: 222.2 },
    ]);

    // Begin transaction
    await txnClient.beginTransaction({
      database: TEST_DATABASE,
      table: TEST_TABLE,
      label,
    });

    // Load JSON data
    await txnClient.transactionLoad(
      label,
      TEST_DATABASE,
      TEST_TABLE,
      jsonData,
      {
        format: "json",
        stripOuterArray: true,
        columns: ["id", "name", "value"],
      }
    );

    // Commit
    const commitResult = await txnClient.commitTransaction(label, TEST_DATABASE);
    expect(commitResult.status).toBe("OK");
    expect(commitResult.numberLoadedRows).toBe(2);

    // Verify data
    const rows = await client.raw<{ id: number; name: string }>(
      `SELECT * FROM ${TEST_TABLE} WHERE id IN (4001, 4002) ORDER BY id`
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe("JsonItem1");
  });

  test("should throw TransactionError for duplicate label", async () => {
    const label = uniqueLabel("txn_duplicate");

    // First transaction with this label
    await txnClient.beginTransaction({
      database: TEST_DATABASE,
      table: TEST_TABLE,
      label,
    });

    // Try to begin another transaction with same label - should throw
    let thrownError: TransactionError | null = null;
    try {
      await txnClient.beginTransaction({
        database: TEST_DATABASE,
        table: TEST_TABLE,
        label,
      });
    } catch (error) {
      thrownError = error as TransactionError;
    }
    expect(thrownError).not.toBeNull();
    expect(thrownError!.name).toBe("TransactionError");
    expect(thrownError!.status).toBe("LABEL_ALREADY_EXISTS");

    // Clean up - rollback the first transaction
    await txnClient.rollbackTransaction(label, TEST_DATABASE);
  });

  test("should throw TransactionError for invalid transaction", async () => {
    const invalidLabel = uniqueLabel("txn_nonexistent");

    // Try to commit a transaction that doesn't exist - should throw
    let thrownError: TransactionError | null = null;
    try {
      await txnClient.commitTransaction(invalidLabel, TEST_DATABASE);
    } catch (error) {
      thrownError = error as TransactionError;
    }
    expect(thrownError).not.toBeNull();
    expect(thrownError!.name).toBe("TransactionError");
    expect(thrownError!.status).toBe("TXN_NOT_EXISTS");
  });

  test("should report load metrics", async () => {
    const label = uniqueLabel("txn_metrics");
    const csvData = `5001,Metrics1,100.0
5002,Metrics2,200.0`;

    await txnClient.beginTransaction({
      database: TEST_DATABASE,
      table: TEST_TABLE,
      label,
    });

    const loadResult = await txnClient.transactionLoad(
      label,
      TEST_DATABASE,
      TEST_TABLE,
      csvData,
      { format: "csv", columnSeparator: ",", columns: ["id", "name", "value"] }
    );

    // Load result should have basic info
    expect(loadResult.txnId).toBeGreaterThan(0);
    expect(loadResult.label).toBe(label);

    const commitResult = await txnClient.commitTransaction(label, TEST_DATABASE);

    // Commit result should have load metrics
    expect(commitResult.numberLoadedRows).toBe(2);
    expect(typeof commitResult.loadBytes).toBe("number");
    expect(typeof commitResult.loadTimeMs).toBe("number");
  });

  test("should use custom label", async () => {
    const customLabel = `custom_label_${Date.now()}`;

    await txnClient.beginTransaction({
      database: TEST_DATABASE,
      table: TEST_TABLE,
      label: customLabel,
    });

    await txnClient.transactionLoad(
      customLabel,
      TEST_DATABASE,
      TEST_TABLE,
      "6001,CustomLabel,999.9",
      { format: "csv", columnSeparator: ",", columns: ["id", "name", "value"] }
    );

    const result = await txnClient.commitTransaction(customLabel, TEST_DATABASE);
    expect(result.label).toBe(customLabel);
  });
});
