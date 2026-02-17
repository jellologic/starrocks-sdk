/**
 * Error Handling Tests
 *
 * Tests for Tagged Errors, error messages, and error catchability.
 */

import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import {
  ConnectionError,
  StreamLoadError,
  TransactionError,
  ArchiveError,
  MigrationError,
  MaterializedViewError,
  QueryError,
} from "../src/errors/index";
import { StarRocksConfigFromEnv } from "../src/config/starrocks.config";

// ============================================================================
// Error Creation Tests
// ============================================================================

describe("Error Creation", () => {
  describe("ConnectionError", () => {
    test("should create with required fields", () => {
      const error = new ConnectionError({
        host: "localhost",
        port: 9030,
        cause: "Connection refused",
      });

      expect(error._tag).toBe("ConnectionError");
      expect(error.host).toBe("localhost");
      expect(error.port).toBe(9030);
      expect(error.cause).toBe("Connection refused");
    });

    test("should generate formatted message with context", () => {
      const error = new ConnectionError({
        host: "192.168.1.100",
        port: 9030,
        cause: "Connection timed out",
      });

      expect(error.formattedMessage).toBe(
        "Connection to 192.168.1.100:9030 failed: Connection timed out"
      );
    });
  });

  describe("StreamLoadError", () => {
    test("should create with required fields", () => {
      const error = new StreamLoadError({
        table: "events",
        message: "Parse error",
      });

      expect(error._tag).toBe("StreamLoadError");
      expect(error.table).toBe("events");
      expect(error.message).toBe("Parse error");
    });

    test("should create with all optional fields", () => {
      const error = new StreamLoadError({
        table: "events",
        message: "Data quality issue",
        status: "FAILED",
        httpStatus: 500,
        errorUrl: "http://localhost:8040/api/_load_error_log",
        numberFilteredRows: 42,
      });

      expect(error.status).toBe("FAILED");
      expect(error.httpStatus).toBe(500);
      expect(error.errorUrl).toBe("http://localhost:8040/api/_load_error_log");
      expect(error.numberFilteredRows).toBe(42);
    });

    test("should include HTTP status in formatted message", () => {
      const error = new StreamLoadError({
        table: "events",
        message: "Internal Server Error",
        httpStatus: 500,
      });

      expect(error.formattedMessage).toContain("HTTP 500");
    });

    test("should generate formatted message with all context", () => {
      const error = new StreamLoadError({
        table: "users",
        message: "Invalid JSON",
        status: "FAILED",
        numberFilteredRows: 10,
        errorUrl: "http://example.com/error",
      });

      const msg = error.formattedMessage;
      expect(msg).toContain("users");
      expect(msg).toContain("Invalid JSON");
      expect(msg).toContain("FAILED");
      expect(msg).toContain("10 rows filtered");
      expect(msg).toContain("http://example.com/error");
    });

    test("should generate minimal message without optional fields", () => {
      const error = new StreamLoadError({
        table: "events",
        message: "Network error",
      });

      expect(error.formattedMessage).toBe(
        "Stream load to 'events' failed: Network error"
      );
    });
  });

  describe("TransactionError", () => {
    test("should create with required fields", () => {
      const error = new TransactionError({
        label: "txn_123",
        phase: "commit",
        cause: "Timeout",
      });

      expect(error._tag).toBe("TransactionError");
      expect(error.label).toBe("txn_123");
      expect(error.phase).toBe("commit");
      expect(error.cause).toBe("Timeout");
    });

    test("should accept all valid phases", () => {
      const phases = ["begin", "load", "prepare", "commit", "abort"] as const;

      for (const phase of phases) {
        const error = new TransactionError({
          label: "test",
          phase,
          cause: "test",
        });
        expect(error.phase).toBe(phase);
      }
    });

    test("should create with all optional fields", () => {
      const error = new TransactionError({
        label: "txn_456",
        phase: "prepare",
        cause: "Duplicate key",
        txnId: 12345,
        table: "orders",
        status: "LABEL_ALREADY_EXISTS",
        httpStatus: 409,
      });

      expect(error.txnId).toBe(12345);
      expect(error.table).toBe("orders");
      expect(error.status).toBe("LABEL_ALREADY_EXISTS");
      expect(error.httpStatus).toBe(409);
    });

    test("should include HTTP status in formatted message", () => {
      const error = new TransactionError({
        label: "txn_789",
        phase: "commit",
        cause: "Service Unavailable",
        httpStatus: 503,
      });

      expect(error.formattedMessage).toContain("HTTP 503");
    });

    test("should generate formatted message with all context", () => {
      const error = new TransactionError({
        label: "daily_load_20240101",
        phase: "load",
        cause: "Invalid data format",
        txnId: 99999,
        table: "events",
        status: "FAILED",
      });

      const msg = error.formattedMessage;
      expect(msg).toContain("daily_load_20240101");
      expect(msg).toContain("load phase");
      expect(msg).toContain("Invalid data format");
      expect(msg).toContain("txnId: 99999");
      expect(msg).toContain("table: events");
      expect(msg).toContain("status: FAILED");
    });
  });

  describe("ArchiveError", () => {
    test("should create with required fields", () => {
      const error = new ArchiveError({
        operation: "export",
        target: "s3://bucket/path",
        cause: "Permission denied",
      });

      expect(error._tag).toBe("ArchiveError");
      expect(error.operation).toBe("export");
      expect(error.target).toBe("s3://bucket/path");
      expect(error.cause).toBe("Permission denied");
    });

    test("should accept all valid operations", () => {
      const operations = ["export", "retention", "status"] as const;

      for (const operation of operations) {
        const error = new ArchiveError({
          operation,
          target: "test",
          cause: "test",
        });
        expect(error.operation).toBe(operation);
      }
    });

    test("should generate formatted message", () => {
      const error = new ArchiveError({
        operation: "export",
        target: "hdfs://cluster/data",
        cause: "Storage quota exceeded",
      });

      expect(error.formattedMessage).toBe(
        "Archive export to 'hdfs://cluster/data' failed: Storage quota exceeded"
      );
    });
  });

  describe("MigrationError", () => {
    test("should create with required fields", () => {
      const error = new MigrationError({
        migrationId: "001_initial",
        cause: "Table already exists",
      });

      expect(error._tag).toBe("MigrationError");
      expect(error.migrationId).toBe("001_initial");
      expect(error.cause).toBe("Table already exists");
    });

    test("should create with step field", () => {
      const error = new MigrationError({
        migrationId: "002_add_indexes",
        step: "create_user_email_idx",
        cause: "Index creation failed",
      });

      expect(error.step).toBe("create_user_email_idx");
    });

    test("should generate formatted message with step", () => {
      const error = new MigrationError({
        migrationId: "003_update_schema",
        step: "add_column_status",
        cause: "Column already exists",
      });

      const msg = error.formattedMessage;
      expect(msg).toContain("003_update_schema");
      expect(msg).toContain("Column already exists");
      expect(msg).toContain("at step: add_column_status");
    });

    test("should generate formatted message without step", () => {
      const error = new MigrationError({
        migrationId: "004_cleanup",
        cause: "Migration checksum mismatch",
      });

      expect(error.formattedMessage).toBe(
        "Migration '004_cleanup' failed: Migration checksum mismatch"
      );
    });
  });

  describe("MaterializedViewError", () => {
    test("should create with required fields", () => {
      const error = new MaterializedViewError({
        viewName: "event_stats_mv",
        operation: "refresh",
        cause: "Source table not found",
      });

      expect(error._tag).toBe("MaterializedViewError");
      expect(error.viewName).toBe("event_stats_mv");
      expect(error.operation).toBe("refresh");
      expect(error.cause).toBe("Source table not found");
    });

    test("should accept all valid operations", () => {
      const operations = ["create", "refresh", "drop", "status"] as const;

      for (const operation of operations) {
        const error = new MaterializedViewError({
          viewName: "test_mv",
          operation,
          cause: "test",
        });
        expect(error.operation).toBe(operation);
      }
    });

    test("should generate formatted message", () => {
      const error = new MaterializedViewError({
        viewName: "daily_aggregates",
        operation: "create",
        cause: "Invalid query syntax",
      });

      expect(error.formattedMessage).toBe(
        "Materialized view 'daily_aggregates' create failed: Invalid query syntax"
      );
    });
  });

  describe("QueryError", () => {
    test("should create with required fields", () => {
      const error = new QueryError({
        operation: "select",
        reason: "Invalid column reference",
      });

      expect(error._tag).toBe("QueryError");
      expect(error.operation).toBe("select");
      expect(error.reason).toBe("Invalid column reference");
    });

    test("should accept all valid operations", () => {
      const operations = ["select", "insert", "update", "delete"] as const;

      for (const operation of operations) {
        const error = new QueryError({
          operation,
          reason: "test",
        });
        expect(error.operation).toBe(operation);
      }
    });

    test("should create with table field", () => {
      const error = new QueryError({
        operation: "insert",
        table: "users",
        reason: "Duplicate key violation",
      });

      expect(error.table).toBe("users");
    });

    test("should generate formatted message with table", () => {
      const error = new QueryError({
        operation: "delete",
        table: "orders",
        reason: "Foreign key constraint",
      });

      const msg = error.formattedMessage;
      expect(msg).toContain("delete");
      expect(msg).toContain("Foreign key constraint");
      expect(msg).toContain("table: orders");
    });

    test("should generate formatted message without table", () => {
      const error = new QueryError({
        operation: "select",
        reason: "Syntax error",
      });

      expect(error.formattedMessage).toBe("Query select failed: Syntax error");
    });
  });
});

// ============================================================================
// Error Catchability Tests (Effect Integration)
// ============================================================================

describe("Error Catchability with Effect", () => {
  describe("catchTags", () => {
    test("should catch ConnectionError by tag", async () => {
      const program = Effect.gen(function* () {
        yield* Effect.fail(
          new ConnectionError({
            host: "localhost",
            port: 9030,
            cause: "test",
          })
        );
        return "success";
      }).pipe(
        Effect.catchTags({
          ConnectionError: (e) => Effect.succeed(`caught: ${e.host}:${e.port}`),
        })
      );

      const result = await Effect.runPromise(program);
      expect(result).toBe("caught: localhost:9030");
    });

    test("should catch StreamLoadError by tag", async () => {
      const program = Effect.gen(function* () {
        yield* Effect.fail(
          new StreamLoadError({
            table: "events",
            message: "test error",
          })
        );
        return "success";
      }).pipe(
        Effect.catchTags({
          StreamLoadError: (e) => Effect.succeed(`caught: ${e.table}`),
        })
      );

      const result = await Effect.runPromise(program);
      expect(result).toBe("caught: events");
    });

    test("should catch TransactionError by tag", async () => {
      const program = Effect.gen(function* () {
        yield* Effect.fail(
          new TransactionError({
            label: "txn_test",
            phase: "commit",
            cause: "test",
          })
        );
        return "success";
      }).pipe(
        Effect.catchTags({
          TransactionError: (e) =>
            Effect.succeed(`caught: ${e.label} at ${e.phase}`),
        })
      );

      const result = await Effect.runPromise(program);
      expect(result).toBe("caught: txn_test at commit");
    });

    test("should catch MigrationError by tag", async () => {
      const program = Effect.gen(function* () {
        yield* Effect.fail(
          new MigrationError({
            migrationId: "001",
            cause: "test",
          })
        );
        return "success";
      }).pipe(
        Effect.catchTags({
          MigrationError: (e) => Effect.succeed(`caught: ${e.migrationId}`),
        })
      );

      const result = await Effect.runPromise(program);
      expect(result).toBe("caught: 001");
    });

    test("should catch MaterializedViewError by tag", async () => {
      const program = Effect.gen(function* () {
        yield* Effect.fail(
          new MaterializedViewError({
            viewName: "test_mv",
            operation: "refresh",
            cause: "test",
          })
        );
        return "success";
      }).pipe(
        Effect.catchTags({
          MaterializedViewError: (e) =>
            Effect.succeed(`caught: ${e.viewName} ${e.operation}`),
        })
      );

      const result = await Effect.runPromise(program);
      expect(result).toBe("caught: test_mv refresh");
    });

    test("should catch QueryError by tag", async () => {
      const program = Effect.gen(function* () {
        yield* Effect.fail(
          new QueryError({
            operation: "select",
            reason: "test",
          })
        );
        return "success";
      }).pipe(
        Effect.catchTags({
          QueryError: (e) => Effect.succeed(`caught: ${e.operation}`),
        })
      );

      const result = await Effect.runPromise(program);
      expect(result).toBe("caught: select");
    });

    test("should catch ArchiveError by tag", async () => {
      const program = Effect.gen(function* () {
        yield* Effect.fail(
          new ArchiveError({
            operation: "export",
            target: "s3://test",
            cause: "test",
          })
        );
        return "success";
      }).pipe(
        Effect.catchTags({
          ArchiveError: (e) => Effect.succeed(`caught: ${e.target}`),
        })
      );

      const result = await Effect.runPromise(program);
      expect(result).toBe("caught: s3://test");
    });
  });

  describe("Multiple error types", () => {
    test("should handle multiple error types with catchTags", async () => {
      const failWithConnectionError = Effect.fail(
        new ConnectionError({
          host: "localhost",
          port: 9030,
          cause: "test",
        })
      );

      const failWithStreamLoadError = Effect.fail(
        new StreamLoadError({
          table: "events",
          message: "test",
        })
      );

      const handler = Effect.catchTags({
        ConnectionError: (e) => Effect.succeed(`connection: ${e.host}`),
        StreamLoadError: (e) => Effect.succeed(`stream: ${e.table}`),
      });

      const result1 = await Effect.runPromise(
        failWithConnectionError.pipe(handler)
      );
      expect(result1).toBe("connection: localhost");

      const result2 = await Effect.runPromise(
        failWithStreamLoadError.pipe(handler)
      );
      expect(result2).toBe("stream: events");
    });
  });
});

// ============================================================================
// Error Message Quality Tests
// ============================================================================

describe("Error Message Quality", () => {
  describe("Contextual information", () => {
    test("ConnectionError includes host and port", () => {
      const error = new ConnectionError({
        host: "db.example.com",
        port: 9030,
        cause: "DNS resolution failed",
      });

      const msg = error.formattedMessage;
      expect(msg).toContain("db.example.com");
      expect(msg).toContain("9030");
      expect(msg).toContain("DNS resolution failed");
    });

    test("StreamLoadError includes table name", () => {
      const error = new StreamLoadError({
        table: "important_data",
        message: "Schema mismatch",
      });

      expect(error.formattedMessage).toContain("important_data");
    });

    test("TransactionError includes label and phase", () => {
      const error = new TransactionError({
        label: "daily_etl_20240115",
        phase: "prepare",
        cause: "Lock timeout",
      });

      const msg = error.formattedMessage;
      expect(msg).toContain("daily_etl_20240115");
      expect(msg).toContain("prepare");
    });

    test("MigrationError includes migration ID", () => {
      const error = new MigrationError({
        migrationId: "20240115_add_indexes",
        cause: "Table not found",
      });

      expect(error.formattedMessage).toContain("20240115_add_indexes");
    });
  });

  describe("Readable format", () => {
    test("Error messages should be human-readable", () => {
      const errors = [
        new ConnectionError({
          host: "localhost",
          port: 9030,
          cause: "Test",
        }),
        new StreamLoadError({
          table: "test",
          message: "Test",
        }),
        new TransactionError({
          label: "test",
          phase: "begin",
          cause: "Test",
        }),
        new ArchiveError({
          operation: "export",
          target: "test",
          cause: "Test",
        }),
        new MigrationError({
          migrationId: "test",
          cause: "Test",
        }),
        new MaterializedViewError({
          viewName: "test",
          operation: "create",
          cause: "Test",
        }),
        new QueryError({
          operation: "select",
          reason: "Test",
        }),
      ];

      for (const error of errors) {
        const msg = error.formattedMessage;
        // Should be a complete sentence (starts with uppercase, contains action words)
        expect(msg.length).toBeGreaterThan(10);
        // Should contain the word "failed" to indicate an error state
        expect(msg.toLowerCase()).toContain("failed");
      }
    });
  });

  describe("Special characters in error context", () => {
    test("should handle special characters in host", () => {
      const error = new ConnectionError({
        host: "db-server-01.internal.example.com",
        port: 9030,
        cause: "test",
      });

      expect(error.formattedMessage).toContain(
        "db-server-01.internal.example.com"
      );
    });

    test("should handle special characters in table name", () => {
      const error = new StreamLoadError({
        table: "my_database.schema_name.table_with_underscores",
        message: "test",
      });

      expect(error.formattedMessage).toContain(
        "my_database.schema_name.table_with_underscores"
      );
    });

    test("should handle special characters in cause message", () => {
      const error = new ConnectionError({
        host: "localhost",
        port: 9030,
        cause: "Error: Connection refused (ECONNREFUSED) - check if server is running",
      });

      expect(error.formattedMessage).toContain("ECONNREFUSED");
    });

    test("should handle unicode in error messages", () => {
      const error = new StreamLoadError({
        table: "events",
        message: "Invalid UTF-8 data: café résumé",
      });

      expect(error.formattedMessage).toContain("café résumé");
    });
  });
});

// ============================================================================
// Error Tag Uniqueness Tests
// ============================================================================

describe("Error Tag Uniqueness", () => {
  test("all error types should have unique tags", () => {
    const tags = new Set([
      new ConnectionError({ host: "", port: 0, cause: "" })._tag,
      new StreamLoadError({ table: "", message: "" })._tag,
      new TransactionError({ label: "", phase: "begin", cause: "" })._tag,
      new ArchiveError({ operation: "export", target: "", cause: "" })._tag,
      new MigrationError({ migrationId: "", cause: "" })._tag,
      new MaterializedViewError({ viewName: "", operation: "create", cause: "" })._tag,
      new QueryError({ operation: "select", reason: "" })._tag,
    ]);

    // All 7 error types should have unique tags
    expect(tags.size).toBe(7);
  });

  test("error tags should match class names", () => {
    expect(
      new ConnectionError({ host: "", port: 0, cause: "" })._tag
    ).toBe("ConnectionError");
    expect(
      new StreamLoadError({ table: "", message: "" })._tag
    ).toBe("StreamLoadError");
    expect(
      new TransactionError({ label: "", phase: "begin", cause: "" })._tag
    ).toBe("TransactionError");
    expect(
      new ArchiveError({ operation: "export", target: "", cause: "" })._tag
    ).toBe("ArchiveError");
    expect(
      new MigrationError({ migrationId: "", cause: "" })._tag
    ).toBe("MigrationError");
    expect(
      new MaterializedViewError({ viewName: "", operation: "create", cause: "" })._tag
    ).toBe("MaterializedViewError");
    expect(
      new QueryError({ operation: "select", reason: "" })._tag
    ).toBe("QueryError");
  });
});

// ============================================================================
// Config Error Integration Tests
// ============================================================================

describe("Config Error Integration", () => {
  test("StarRocksConfigFromEnv should fail with ConnectionError when env vars missing", async () => {
    // Save and clear env vars
    const saved = {
      host: process.env.STARROCKS_HOST,
      port: process.env.STARROCKS_HTTP_PORT,
      user: process.env.STARROCKS_USER,
    };
    delete process.env.STARROCKS_HOST;
    delete process.env.STARROCKS_HTTP_PORT;
    delete process.env.STARROCKS_USER;

    try {
      const program = Effect.gen(function* () {
        yield* Effect.void;
        return "should not reach";
      }).pipe(
        Effect.provide(StarRocksConfigFromEnv),
        Effect.catchTags({
          ConnectionError: (e) => Effect.succeed(`caught: ${e.cause}`),
        }),
        // Catch the defect that Layer failures produce
        Effect.catchAll((e) => {
          if (e instanceof ConnectionError) {
            return Effect.succeed(`caught: ${e.cause}`);
          }
          return Effect.fail(e);
        })
      );

      const result = await Effect.runPromise(program);
      expect(result).toContain("Missing required environment variables");
    } finally {
      // Restore env vars
      if (saved.host) process.env.STARROCKS_HOST = saved.host;
      if (saved.port) process.env.STARROCKS_HTTP_PORT = saved.port;
      if (saved.user) process.env.STARROCKS_USER = saved.user;
    }
  });
});
