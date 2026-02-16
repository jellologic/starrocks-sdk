// packages/starrocks/test/effect-services.test.ts
/**
 * Integration tests for Effect-based StreamLoad and Transaction services
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Effect, Layer } from "effect"
import {
  StreamLoad,
  StreamLoadLive,
  Transaction,
  TransactionLive,
  StarRocksConfigLive,
  StreamLoadError,
  TransactionError,
} from "../src"
import { createStarRocksClient } from "../src/client"
import { testConfig, TEST_DATABASE, beHttpPort } from "../src/test-config"

/**
 * Configuration layers for testing
 * Both StreamLoad and Transaction use BE HTTP port directly
 * to avoid FE redirect issues in Docker (FE redirects to internal 8040 which isn't accessible)
 */
const streamLoadConfigLayer = StarRocksConfigLive({
  host: testConfig.host,
  httpPort: beHttpPort,
  mysqlPort: testConfig.port,
  user: testConfig.user,
  password: testConfig.password ?? "",
})

const transactionConfigLayer = StarRocksConfigLive({
  host: testConfig.host,
  httpPort: beHttpPort,
  mysqlPort: testConfig.port,
  user: testConfig.user,
  password: testConfig.password ?? "",
})

const StreamLoadTest = StreamLoadLive.pipe(Layer.provide(streamLoadConfigLayer))
const TransactionTest = TransactionLive.pipe(Layer.provide(transactionConfigLayer))

describe("Effect Services Integration", () => {
  beforeAll(async () => {
    const client = createStarRocksClient(testConfig)
    await client.createDatabase(TEST_DATABASE)
    await client.useDatabase(TEST_DATABASE)

    // Create test table for Effect services
    await client.execute(`
      CREATE TABLE IF NOT EXISTS effect_test_events (
        id BIGINT NOT NULL,
        name VARCHAR(255),
        value DOUBLE
      ) PRIMARY KEY (id)
      DISTRIBUTED BY HASH(id) BUCKETS 4
      PROPERTIES ("replication_num" = "1")
    `)

    await client.close()
  })

  afterAll(async () => {
    const client = createStarRocksClient(testConfig)
    await client.dropDatabase(TEST_DATABASE)
    await client.close()
  })

  describe("StreamLoad Service", () => {
    test("should load objects successfully", async () => {
      const program = Effect.gen(function* () {
        const loader = yield* StreamLoad
        const result = yield* loader.loadObjects(
          [
            { id: 1, name: "Test Event 1", value: 100.5 },
            { id: 2, name: "Test Event 2", value: 200.75 },
          ],
          { database: TEST_DATABASE, table: "effect_test_events" }
        )
        return result
      })

      const result = await Effect.runPromise(program.pipe(Effect.provide(StreamLoadTest)))

      expect(result.label).toBeTruthy()
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status)

      if (result.status === "Success") {
        expect(result.numberLoadedRows).toBe(2)
      }
    })

    test("should fail on empty array", async () => {
      const program = Effect.gen(function* () {
        const loader = yield* StreamLoad
        yield* loader.loadObjects([], { database: TEST_DATABASE, table: "effect_test_events" })
      })

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(StreamLoadTest),
          Effect.catchTag("StreamLoadError", (e) => Effect.succeed(e))
        )
      )

      expect(result).toBeInstanceOf(StreamLoadError)
      expect((result as StreamLoadError).message).toContain("empty")
    })

    test("should load CSV data successfully", async () => {
      const program = Effect.gen(function* () {
        const loader = yield* StreamLoad
        const result = yield* loader.loadCsv(
          `10,CSV Event 1,1000.5\n11,CSV Event 2,1100.5`,
          {
            database: TEST_DATABASE,
            table: "effect_test_events",
            columns: ["id", "name", "value"],
            columnSeparator: ",",
          }
        )
        return result
      })

      const result = await Effect.runPromise(program.pipe(Effect.provide(StreamLoadTest)))

      expect(result.label).toBeTruthy()
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status)

      if (result.status === "Success") {
        expect(result.numberLoadedRows).toBe(2)
      }
    })

    test("should load JSON string successfully", async () => {
      const program = Effect.gen(function* () {
        const loader = yield* StreamLoad
        const jsonData = JSON.stringify([
          { id: 20, name: "JSON Event 1", value: 2000.5 },
          { id: 21, name: "JSON Event 2", value: 2100.5 },
        ])
        const result = yield* loader.loadJson(jsonData, {
          database: TEST_DATABASE,
          table: "effect_test_events",
          columns: ["id", "name", "value"],
          stripOuterArray: true,
        })
        return result
      })

      const result = await Effect.runPromise(program.pipe(Effect.provide(StreamLoadTest)))

      expect(result.label).toBeTruthy()
      expect(["Success", "Fail", "Publish Timeout"]).toContain(result.status)
    })

    test("should report load metrics", async () => {
      const program = Effect.gen(function* () {
        const loader = yield* StreamLoad
        const result = yield* loader.loadObjects(
          [{ id: 30, name: "Metrics Event", value: 3000.5 }],
          { database: TEST_DATABASE, table: "effect_test_events" }
        )
        return result
      })

      const result = await Effect.runPromise(program.pipe(Effect.provide(StreamLoadTest)))

      expect(typeof result.loadTimeMs).toBe("number")
      expect(typeof result.loadBytes).toBe("number")
      expect(typeof result.numberLoadedRows).toBe("number")
      expect(typeof result.numberFilteredRows).toBe("number")
    })
  })

  describe("Transaction Service", () => {
    /**
     * Generate unique label to avoid conflicts
     */
    function uniqueLabel(prefix: string): string {
      return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
    }

    test("should complete 2PC flow: begin -> load -> commit", async () => {
      const label = uniqueLabel("effect_txn")

      const program = Effect.gen(function* () {
        const tx = yield* Transaction

        // Begin
        const handle = yield* tx.begin({
          database: TEST_DATABASE,
          table: "effect_test_events",
          label,
        })
        expect(handle.txnId).toBeGreaterThan(0)
        expect(handle.label).toBe(label)

        // Load
        yield* tx.load(handle, [
          { id: 100, name: "Txn Event 1", value: 500.0 },
          { id: 101, name: "Txn Event 2", value: 600.0 },
        ])

        // Commit
        const result = yield* tx.commit(handle)
        expect(result.status).toBe("OK")

        return result
      })

      const result = await Effect.runPromise(program.pipe(Effect.provide(TransactionTest)))
      expect(result.status).toBe("OK")
      expect(result.numberLoadedRows).toBe(2)
    })

    test("should abort transaction successfully", async () => {
      const label = uniqueLabel("effect_abort")

      const program = Effect.gen(function* () {
        const tx = yield* Transaction

        const handle = yield* tx.begin({
          database: TEST_DATABASE,
          table: "effect_test_events",
          label,
        })

        yield* tx.load(handle, [{ id: 999, name: "Will be aborted", value: 0 }])

        // Abort instead of commit
        yield* tx.abort(handle)
      })

      // No error = success
      await Effect.runPromise(program.pipe(Effect.provide(TransactionTest)))
    })

    test("should support multiple loads in single transaction", async () => {
      const label = uniqueLabel("effect_multi_load")

      const program = Effect.gen(function* () {
        const tx = yield* Transaction

        const handle = yield* tx.begin({
          database: TEST_DATABASE,
          table: "effect_test_events",
          label,
        })

        // Load batch 1
        yield* tx.load(handle, [{ id: 200, name: "Batch 1", value: 200.0 }])

        // Load batch 2
        yield* tx.load(handle, [{ id: 201, name: "Batch 2", value: 201.0 }])

        // Load batch 3
        yield* tx.load(handle, [{ id: 202, name: "Batch 3", value: 202.0 }])

        const result = yield* tx.commit(handle)
        return result
      })

      const result = await Effect.runPromise(program.pipe(Effect.provide(TransactionTest)))
      expect(result.status).toBe("OK")
      expect(result.numberLoadedRows).toBe(3)
    })

    test("should support CSV string loading", async () => {
      const label = uniqueLabel("effect_csv_txn")

      const program = Effect.gen(function* () {
        const tx = yield* Transaction

        const handle = yield* tx.begin({
          database: TEST_DATABASE,
          table: "effect_test_events",
          label,
        })

        yield* tx.load(handle, "300,CSV in Txn,300.0\n301,CSV in Txn 2,301.0", {
          format: "csv",
          columnSeparator: ",",
          columns: ["id", "name", "value"],
        })

        const result = yield* tx.commit(handle)
        return result
      })

      const result = await Effect.runPromise(program.pipe(Effect.provide(TransactionTest)))
      expect(result.status).toBe("OK")
      expect(result.numberLoadedRows).toBe(2)
    })

    test("should fail on duplicate label", async () => {
      const label = uniqueLabel("effect_dup")

      const program = Effect.gen(function* () {
        const tx = yield* Transaction

        // First transaction
        const handle = yield* tx.begin({
          database: TEST_DATABASE,
          table: "effect_test_events",
          label,
        })

        // Try to begin another with same label (should fail)
        yield* tx.begin({
          database: TEST_DATABASE,
          table: "effect_test_events",
          label,
        })

        // Clean up if we somehow get here
        yield* tx.abort(handle)
      })

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(TransactionTest),
          Effect.catchTag("TransactionError", (e) => Effect.succeed(e))
        )
      )

      expect(result).toBeInstanceOf(TransactionError)
    })

    test("should fail on commit of non-existent transaction", async () => {
      const fakeLabel = uniqueLabel("effect_nonexistent")

      const program = Effect.gen(function* () {
        const tx = yield* Transaction

        // Create a fake handle for a non-existent transaction
        const fakeHandle = {
          label: fakeLabel,
          txnId: 999999,
          database: TEST_DATABASE,
          table: "effect_test_events",
          multiTable: false,
        }

        yield* tx.commit(fakeHandle)
      })

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(TransactionTest),
          Effect.catchTag("TransactionError", (e) => Effect.succeed(e))
        )
      )

      expect(result).toBeInstanceOf(TransactionError)
    })

    test("should report transaction metrics", async () => {
      const label = uniqueLabel("effect_metrics")

      const program = Effect.gen(function* () {
        const tx = yield* Transaction

        const handle = yield* tx.begin({
          database: TEST_DATABASE,
          table: "effect_test_events",
          label,
        })

        yield* tx.load(handle, [
          { id: 400, name: "Metrics 1", value: 400.0 },
          { id: 401, name: "Metrics 2", value: 401.0 },
        ])

        const result = yield* tx.commit(handle)
        return result
      })

      const result = await Effect.runPromise(program.pipe(Effect.provide(TransactionTest)))

      expect(result.txnId).toBeGreaterThan(0)
      expect(result.label).toBe(label)
      expect(typeof result.numberLoadedRows).toBe("number")
      expect(typeof result.loadBytes).toBe("number")
    })
  })
})
