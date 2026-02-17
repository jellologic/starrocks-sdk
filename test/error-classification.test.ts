import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { StreamLoadError, TransactionError } from "../src/errors"
import {
  isRetryableError as isStreamLoadRetryable,
  parseResponse as parseStreamLoadResponse,
  validateLoadOptions,
} from "../src/layers/stream-load.layer"
import {
  isRetryableError as isTransactionRetryable,
  parseResponse as parseTransactionResponse,
} from "../src/layers/transaction.layer"

// ============================================================================
// StreamLoad: isRetryableError
// ============================================================================

describe("StreamLoad isRetryableError", () => {
  const make = (message: string, httpStatus?: number) =>
    new StreamLoadError({ table: "t", message, httpStatus })

  test("retries on HTTP 429", () => {
    expect(isStreamLoadRetryable(make("Too Many Requests", 429))).toBe(true)
  })

  test("retries on HTTP 500", () => {
    expect(isStreamLoadRetryable(make("Internal Server Error", 500))).toBe(true)
  })

  test("retries on HTTP 502", () => {
    expect(isStreamLoadRetryable(make("Bad Gateway", 502))).toBe(true)
  })

  test("retries on HTTP 503", () => {
    expect(isStreamLoadRetryable(make("Service Unavailable", 503))).toBe(true)
  })

  test("retries on HTTP 504", () => {
    expect(isStreamLoadRetryable(make("Gateway Timeout", 504))).toBe(true)
  })

  test("does NOT retry on HTTP 400", () => {
    expect(isStreamLoadRetryable(make("Bad Request", 400))).toBe(false)
  })

  test("does NOT retry on HTTP 401", () => {
    expect(isStreamLoadRetryable(make("Unauthorized", 401))).toBe(false)
  })

  test("does NOT retry on HTTP 403", () => {
    expect(isStreamLoadRetryable(make("Forbidden", 403))).toBe(false)
  })

  test("does NOT retry on HTTP 404", () => {
    expect(isStreamLoadRetryable(make("Not Found", 404))).toBe(false)
  })

  test("retries on timeout message (no HTTP status)", () => {
    expect(isStreamLoadRetryable(make("Connection timeout after 30s"))).toBe(true)
  })

  test("retries on ECONNRESET", () => {
    expect(isStreamLoadRetryable(make("read ECONNRESET"))).toBe(true)
  })

  test("retries on ECONNREFUSED", () => {
    expect(isStreamLoadRetryable(make("connect ECONNREFUSED 127.0.0.1:8040"))).toBe(true)
  })

  test("retries on ETIMEDOUT", () => {
    expect(isStreamLoadRetryable(make("connect ETIMEDOUT"))).toBe(true)
  })

  test("retries on socket hang up", () => {
    expect(isStreamLoadRetryable(make("socket hang up"))).toBe(true)
  })

  test("retries on network error", () => {
    expect(isStreamLoadRetryable(make("network error"))).toBe(true)
  })

  test("retries on service unavailable message", () => {
    expect(isStreamLoadRetryable(make("Service Unavailable"))).toBe(true)
  })

  test("retries on rate limit message", () => {
    expect(isStreamLoadRetryable(make("rate limit exceeded"))).toBe(true)
  })

  test("retries on busy message", () => {
    expect(isStreamLoadRetryable(make("server is busy"))).toBe(true)
  })

  test("retries on transaction not found", () => {
    expect(isStreamLoadRetryable(make("transaction not found"))).toBe(true)
  })

  test("does NOT retry on data format error", () => {
    expect(isStreamLoadRetryable(make("Invalid column separator"))).toBe(false)
  })

  test("does NOT retry on generic failure", () => {
    expect(isStreamLoadRetryable(make("Unknown column 'foo'"))).toBe(false)
  })
})

// ============================================================================
// Transaction: isRetryableError
// ============================================================================

describe("Transaction isRetryableError", () => {
  const make = (cause: string, httpStatus?: number) =>
    new TransactionError({ label: "test_txn", phase: "begin", cause, httpStatus })

  test("retries on HTTP 429", () => {
    expect(isTransactionRetryable(make("Too Many Requests", 429))).toBe(true)
  })

  test("retries on HTTP 503", () => {
    expect(isTransactionRetryable(make("Service Unavailable", 503))).toBe(true)
  })

  test("does NOT retry on HTTP 400", () => {
    expect(isTransactionRetryable(make("Bad Request", 400))).toBe(false)
  })

  test("does NOT retry on HTTP 401", () => {
    expect(isTransactionRetryable(make("Unauthorized", 401))).toBe(false)
  })

  test("retries on timeout cause", () => {
    expect(isTransactionRetryable(make("HTTP request timed out after 120000ms"))).toBe(true)
  })

  test("retries on connection refused", () => {
    expect(isTransactionRetryable(make("connect ECONNREFUSED"))).toBe(true)
  })

  test("does NOT retry on generic failure", () => {
    expect(isTransactionRetryable(make("label already exists"))).toBe(false)
  })
})

// ============================================================================
// StreamLoad: parseResponse
// ============================================================================

describe("StreamLoad parseResponse", () => {
  test("parses successful response", () => {
    const result = parseStreamLoadResponse({
      TxnId: 12345,
      Label: "my_load_001",
      Status: "Success",
      Message: "OK",
      NumberLoadedRows: 100,
      NumberFilteredRows: 2,
      NumberUnselectedRows: 0,
      NumberTotalRows: 102,
      LoadBytes: 4096,
      LoadTimeMs: 150,
    })

    expect(result.txnId).toBe(12345)
    expect(result.label).toBe("my_load_001")
    expect(result.status).toBe("Success")
    expect(result.numberLoadedRows).toBe(100)
    expect(result.numberFilteredRows).toBe(2)
    expect(result.numberTotalRows).toBe(102)
    expect(result.loadBytes).toBe(4096)
    expect(result.loadTimeMs).toBe(150)
  })

  test("defaults missing numeric fields to 0", () => {
    const result = parseStreamLoadResponse({
      Status: "Success",
      Message: "OK",
    })

    expect(result.txnId).toBe(0)
    expect(result.numberLoadedRows).toBe(0)
    expect(result.numberFilteredRows).toBe(0)
    expect(result.loadBytes).toBe(0)
  })

  test("calculates numberTotalRows when missing", () => {
    const result = parseStreamLoadResponse({
      Status: "Success",
      NumberLoadedRows: 50,
      NumberFilteredRows: 10,
      NumberUnselectedRows: 5,
    })

    expect(result.numberTotalRows).toBe(65)
  })

  test("maps unknown status to Fail", () => {
    const result = parseStreamLoadResponse({
      Status: "SomethingWeird",
    })

    expect(result.status).toBe("Fail")
  })

  test("handles Publish Timeout status", () => {
    const result = parseStreamLoadResponse({
      Status: "Publish Timeout",
    })

    expect(result.status).toBe("Publish Timeout")
  })

  test("handles Label Already Exists status", () => {
    const result = parseStreamLoadResponse({
      Status: "Label Already Exists",
    })

    expect(result.status).toBe("Label Already Exists")
  })

  test("parses ErrorURL when present", () => {
    const result = parseStreamLoadResponse({
      Status: "Fail",
      ErrorURL: "http://starrocks:8040/api/_load_error_log?file=error_123",
    })

    expect(result.errorUrl).toBe("http://starrocks:8040/api/_load_error_log?file=error_123")
  })

  test("handles non-string Status gracefully", () => {
    const result = parseStreamLoadResponse({
      Status: 123,
    })

    expect(result.status).toBe("Fail")
  })
})

// ============================================================================
// Transaction: parseResponse
// ============================================================================

describe("Transaction parseResponse", () => {
  test("parses successful begin response", async () => {
    const result = await Effect.runPromise(
      parseTransactionResponse(
        { Status: "OK", TxnId: 42, Label: "txn_001", Message: "Begin succeeded" },
        "txn_001",
        "begin"
      )
    )

    expect(result.status).toBe("OK")
    expect(result.txnId).toBe(42)
    expect(result.label).toBe("txn_001")
  })

  test("fails on FAILED status", async () => {
    const error = await Effect.runPromise(
      parseTransactionResponse(
        { Status: "FAILED", Message: "Something broke" },
        "txn_fail",
        "commit"
      ).pipe(Effect.flip)
    )

    expect(error._tag).toBe("TransactionError")
    expect(error.label).toBe("txn_fail")
    expect(error.phase).toBe("commit")
  })

  test("fails on LABEL_ALREADY_EXISTS", async () => {
    const error = await Effect.runPromise(
      parseTransactionResponse(
        { Status: "LABEL_ALREADY_EXISTS", Message: "Label already exists" },
        "dup_label",
        "begin"
      ).pipe(Effect.flip)
    )

    expect(error._tag).toBe("TransactionError")
    expect(error.label).toBe("dup_label")
  })

  test("fails on TXN_NOT_EXISTS", async () => {
    const error = await Effect.runPromise(
      parseTransactionResponse(
        { Status: "TXN_NOT_EXISTS", TxnId: 999 },
        "missing_txn",
        "commit"
      ).pipe(Effect.flip)
    )

    expect(error._tag).toBe("TransactionError")
    expect(error.txnId).toBe(999)
  })

  test("extracts timing metrics from response", async () => {
    const result = await Effect.runPromise(
      parseTransactionResponse(
        {
          Status: "OK",
          TxnId: 100,
          Label: "txn_metrics",
          NumberLoadedRows: 500,
          LoadBytes: 8192,
          LoadTimeMs: 200,
          BeginTxnTimeMs: 10,
          StreamLoadPlanTimeMs: 5,
          ReadDataTimeMs: 50,
          WriteDataTimeMs: 100,
          CommitAndPublishTimeMs: 35,
        },
        "txn_metrics",
        "commit"
      )
    )

    expect(result.numberLoadedRows).toBe(500)
    expect(result.loadBytes).toBe(8192)
    expect(result.loadTimeMs).toBe(200)
    expect(result.beginTxnTimeMs).toBe(10)
    expect(result.commitAndPublishTimeMs).toBe(35)
  })
})

// ============================================================================
// StreamLoad: validateLoadOptions
// ============================================================================

describe("StreamLoad validateLoadOptions", () => {
  const baseOpts = { database: "test_db", table: "test_table" }

  test("accepts valid options", async () => {
    await Effect.runPromise(validateLoadOptions(baseOpts))
  })

  test("rejects invalid database name", async () => {
    const error = await Effect.runPromise(
      validateLoadOptions({ ...baseOpts, database: "123-bad" }).pipe(Effect.flip)
    )
    expect(error.message).toContain("Invalid database name")
  })

  test("rejects empty database name", async () => {
    const error = await Effect.runPromise(
      validateLoadOptions({ ...baseOpts, database: "" }).pipe(Effect.flip)
    )
    expect(error.message).toContain("Invalid database name")
  })

  test("rejects invalid table name", async () => {
    const error = await Effect.runPromise(
      validateLoadOptions({ ...baseOpts, table: "has spaces" }).pipe(Effect.flip)
    )
    expect(error.message).toContain("Invalid table name")
  })

  test("rejects maxFilterRatio > 1", async () => {
    const error = await Effect.runPromise(
      validateLoadOptions({ ...baseOpts, maxFilterRatio: 1.5 }).pipe(Effect.flip)
    )
    expect(error.message).toContain("maxFilterRatio")
  })

  test("rejects negative maxFilterRatio", async () => {
    const error = await Effect.runPromise(
      validateLoadOptions({ ...baseOpts, maxFilterRatio: -0.1 }).pipe(Effect.flip)
    )
    expect(error.message).toContain("maxFilterRatio")
  })

  test("accepts maxFilterRatio = 0", async () => {
    await Effect.runPromise(validateLoadOptions({ ...baseOpts, maxFilterRatio: 0 }))
  })

  test("accepts maxFilterRatio = 1", async () => {
    await Effect.runPromise(validateLoadOptions({ ...baseOpts, maxFilterRatio: 1 }))
  })

  test("rejects non-positive timeout", async () => {
    const error = await Effect.runPromise(
      validateLoadOptions({ ...baseOpts, timeout: 0 }).pipe(Effect.flip)
    )
    expect(error.message).toContain("timeout")
  })

  test("rejects Infinity timeout", async () => {
    const error = await Effect.runPromise(
      validateLoadOptions({ ...baseOpts, timeout: Infinity }).pipe(Effect.flip)
    )
    expect(error.message).toContain("timeout")
  })

  test("rejects negative retry maxRetries", async () => {
    const error = await Effect.runPromise(
      validateLoadOptions({ ...baseOpts, retry: { maxRetries: -1 } }).pipe(Effect.flip)
    )
    expect(error.message).toContain("maxRetries")
  })

  test("rejects non-positive retry initialDelayMs", async () => {
    const error = await Effect.runPromise(
      validateLoadOptions({ ...baseOpts, retry: { initialDelayMs: 0 } }).pipe(Effect.flip)
    )
    expect(error.message).toContain("initialDelayMs")
  })

  test("rejects non-positive retry maxDelayMs", async () => {
    const error = await Effect.runPromise(
      validateLoadOptions({ ...baseOpts, retry: { maxDelayMs: -100 } }).pipe(Effect.flip)
    )
    expect(error.message).toContain("maxDelayMs")
  })
})
