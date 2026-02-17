/**
 * Unit tests for Transaction service — withTransaction, handle enrichment,
 * and load() return type.
 *
 * These tests use a mock TransactionService implementation to verify
 * behaviour without requiring a running StarRocks instance.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import {
  Transaction,
  type TransactionService,
  type TransactionHandle,
  type TransactionResult,
} from "../src/services/transaction.service"
import { TransactionError } from "../src/errors"

// ============================================================================
// Mock helpers
// ============================================================================

const okResult = (label: string, txnId: number = 1): TransactionResult => ({
  txnId,
  label,
  status: "OK",
  message: "OK",
  numberTotalRows: 2,
  numberLoadedRows: 2,
  numberFilteredRows: 0,
  numberUnselectedRows: 0,
  loadBytes: 128,
  loadTimeMs: 10,
})

function makeHandle(overrides?: Partial<TransactionHandle>): TransactionHandle {
  return {
    label: "test_label",
    txnId: 42,
    database: "test_db",
    table: "test_table",
    multiTable: false,
    ...overrides,
  }
}

/**
 * Build a mock TransactionService layer.
 * Individual methods can be overridden via `overrides`.
 */
function mockLayer(overrides: Partial<TransactionService> = {}) {
  const handle = makeHandle()

  const service: TransactionService = {
    begin: () => Effect.succeed(handle),
    load: () => Effect.succeed(okResult(handle.label, handle.txnId)),
    prepare: () => Effect.succeed(okResult(handle.label, handle.txnId)),
    commit: () => Effect.succeed(okResult(handle.label, handle.txnId)),
    abort: () => Effect.void,
    withTransaction: (options, fn) =>
      Effect.acquireUseRelease(
        service.begin(options),
        (h) => fn(h).pipe(Effect.tap(() => service.commit(h))),
        (h, exit) =>
          exit._tag === "Failure"
            ? service.abort(h).pipe(Effect.catchAll(() => Effect.void))
            : Effect.void,
      ),
    ...overrides,
  }

  return Layer.succeed(Transaction, service)
}

// ============================================================================
// withTransaction
// ============================================================================

describe("withTransaction", () => {
  test("should return user value on success", async () => {
    const layer = mockLayer()

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      return yield* tx.withTransaction(
        { database: "db", table: "tbl", label: "lbl" },
        () => Effect.succeed("hello")
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(result).toBe("hello")
  })

  test("should call commit on success", async () => {
    let committed = false
    const layer = mockLayer({
      commit: () => {
        committed = true
        return Effect.succeed(okResult("lbl"))
      },
    })

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      yield* tx.withTransaction(
        { database: "db", table: "tbl", label: "lbl" },
        () => Effect.succeed("done")
      )
    })

    await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(committed).toBe(true)
  })

  test("should call abort on user function failure", async () => {
    let aborted = false
    const layer = mockLayer({
      abort: () => {
        aborted = true
        return Effect.void
      },
    })

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      yield* tx.withTransaction(
        { database: "db", table: "tbl", label: "lbl" },
        () => Effect.fail(new Error("user error"))
      )
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(layer),
        Effect.catchAll(() => Effect.void)
      )
    )
    expect(aborted).toBe(true)
  })

  test("should propagate user error, not abort error", async () => {
    const layer = mockLayer({
      abort: () =>
        Effect.fail(
          new TransactionError({
            label: "lbl",
            phase: "abort",
            cause: "abort network error",
          })
        ),
    })

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      yield* tx.withTransaction(
        { database: "db", table: "tbl", label: "lbl" },
        () => Effect.fail(new Error("original error"))
      )
    })

    const error = await Effect.runPromise(
      program.pipe(
        Effect.provide(layer),
        Effect.flip
      )
    )

    // Should get the original user error, NOT the abort error
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("original error")
  })

  test("should not call abort on success", async () => {
    let aborted = false
    const layer = mockLayer({
      abort: () => {
        aborted = true
        return Effect.void
      },
    })

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      yield* tx.withTransaction(
        { database: "db", table: "tbl", label: "lbl" },
        () => Effect.succeed(42)
      )
    })

    await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(aborted).toBe(false)
  })

  test("should not call commit on user function failure", async () => {
    let committed = false
    const layer = mockLayer({
      commit: () => {
        committed = true
        return Effect.succeed(okResult("lbl"))
      },
    })

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      yield* tx.withTransaction(
        { database: "db", table: "tbl", label: "lbl" },
        () => Effect.fail(new Error("fail"))
      )
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(layer),
        Effect.catchAll(() => Effect.void)
      )
    )
    expect(committed).toBe(false)
  })

  test("should pass handle to user function", async () => {
    let receivedHandle: TransactionHandle | null = null
    const expectedHandle = makeHandle({ label: "passed_handle", txnId: 99 })

    const layer = mockLayer({
      begin: () => Effect.succeed(expectedHandle),
    })

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      yield* tx.withTransaction(
        { database: "test_db", table: "test_table", label: "passed_handle" },
        (handle) => {
          receivedHandle = handle
          return Effect.succeed("ok")
        }
      )
    })

    await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(receivedHandle).not.toBeNull()
    expect(receivedHandle!.label).toBe("passed_handle")
    expect(receivedHandle!.txnId).toBe(99)
  })

  test("should propagate begin failure", async () => {
    const layer = mockLayer({
      begin: () =>
        Effect.fail(
          new TransactionError({
            label: "lbl",
            phase: "begin",
            cause: "connection refused",
          })
        ),
    })

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      yield* tx.withTransaction(
        { database: "db", table: "tbl", label: "lbl" },
        () => Effect.succeed("unreachable")
      )
    })

    const error = await Effect.runPromise(
      program.pipe(
        Effect.provide(layer),
        Effect.flip
      )
    )

    expect(error).toBeInstanceOf(TransactionError)
    expect((error as TransactionError).phase).toBe("begin")
  })

  test("should propagate commit failure", async () => {
    const layer = mockLayer({
      commit: () =>
        Effect.fail(
          new TransactionError({
            label: "lbl",
            phase: "commit",
            cause: "commit timeout",
          })
        ),
    })

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      yield* tx.withTransaction(
        { database: "db", table: "tbl", label: "lbl" },
        () => Effect.succeed("data loaded")
      )
    })

    const error = await Effect.runPromise(
      program.pipe(
        Effect.provide(layer),
        Effect.catchAll((e) => Effect.succeed(e))
      )
    )

    // Commit failure should propagate (abort will be called on failure path)
    expect(error).toBeInstanceOf(TransactionError)
    expect((error as TransactionError).phase).toBe("commit")
  })
})

// ============================================================================
// TransactionHandle: timeoutMs propagation
// ============================================================================

describe("TransactionHandle timeoutMs", () => {
  test("should be present in handle interface", () => {
    const handle: TransactionHandle = {
      label: "test",
      txnId: 1,
      database: "db",
      table: "tbl",
      multiTable: false,
      timeoutMs: 30_000,
    }

    expect(handle.timeoutMs).toBe(30_000)
  })

  test("should be optional (undefined by default)", () => {
    const handle: TransactionHandle = {
      label: "test",
      txnId: 1,
      database: "db",
      table: "tbl",
      multiTable: false,
    }

    expect(handle.timeoutMs).toBeUndefined()
  })
})

// ============================================================================
// load() return type
// ============================================================================

describe("load() returns TransactionResult", () => {
  test("mock service load returns result with metrics", async () => {
    const expectedResult: TransactionResult = {
      txnId: 42,
      label: "load_test",
      status: "OK",
      message: "OK",
      numberTotalRows: 5,
      numberLoadedRows: 5,
      numberFilteredRows: 0,
      loadBytes: 256,
    }

    const layer = mockLayer({
      load: () => Effect.succeed(expectedResult),
    })

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      return yield* tx.load(
        makeHandle({ label: "load_test" }),
        [{ id: 1 }]
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(result.status).toBe("OK")
    expect(result.numberLoadedRows).toBe(5)
    expect(result.numberTotalRows).toBe(5)
    expect(result.loadBytes).toBe(256)
  })

  test("load result can be chained with further operations", async () => {
    const layer = mockLayer()

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      const handle = yield* tx.begin({ database: "db", table: "tbl", label: "chain" })
      const loadResult = yield* tx.load(handle, [{ id: 1 }])
      const commitResult = yield* tx.commit(handle)
      return { loadResult, commitResult }
    })

    const { loadResult, commitResult } = await Effect.runPromise(
      program.pipe(Effect.provide(layer))
    )
    expect(loadResult.status).toBe("OK")
    expect(commitResult.status).toBe("OK")
  })
})

// ============================================================================
// TransactionError: status field
// ============================================================================

describe("TransactionError status field", () => {
  test("status field is accessible on error", () => {
    const error = new TransactionError({
      label: "test",
      phase: "begin",
      cause: "duplicate",
      status: "LABEL_ALREADY_EXISTS",
    })

    expect(error.status).toBe("LABEL_ALREADY_EXISTS")
    expect(error._tag).toBe("TransactionError")
  })

  test("status field is optional", () => {
    const error = new TransactionError({
      label: "test",
      phase: "begin",
      cause: "some error",
    })

    expect(error.status).toBeUndefined()
  })

  test("formattedMessage includes status when present", () => {
    const error = new TransactionError({
      label: "dup",
      phase: "begin",
      cause: "Label exists",
      status: "LABEL_ALREADY_EXISTS",
    })

    expect(error.formattedMessage).toContain("LABEL_ALREADY_EXISTS")
  })

  test("formattedMessage includes httpStatus when present", () => {
    const error = new TransactionError({
      label: "http_err",
      phase: "load",
      cause: "Server error",
      httpStatus: 503,
    })

    expect(error.formattedMessage).toContain("HTTP 503")
  })
})

// ============================================================================
// prepare() with TransactionPrepareOptions
// ============================================================================

describe("prepare with TransactionPrepareOptions", () => {
  test("prepare accepts options parameter", async () => {
    let receivedOptions: { preparedTimeout?: number } | undefined
    const layer = mockLayer({
      prepare: (_handle, options) => {
        receivedOptions = options
        return Effect.succeed(okResult("lbl"))
      },
    })

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      const handle = yield* tx.begin({ database: "db", table: "tbl", label: "lbl" })
      yield* tx.prepare(handle, { preparedTimeout: 3600 })
    })

    await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(receivedOptions?.preparedTimeout).toBe(3600)
  })

  test("prepare works without options", async () => {
    const layer = mockLayer()

    const program = Effect.gen(function* () {
      const tx = yield* Transaction
      const handle = yield* tx.begin({ database: "db", table: "tbl", label: "lbl" })
      const result = yield* tx.prepare(handle)
      return result
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(result.status).toBe("OK")
  })
})
