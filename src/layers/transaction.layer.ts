// packages/starrocks/src/layers/transaction.layer.ts
import { Effect, Layer } from "effect"
import {
  Transaction,
  type TransactionService,
  type TransactionHandle,
  type TransactionResult,
} from "../services/transaction.service"
import { TransactionError } from "../errors"
import { StarRocksConfig } from "../config/starrocks.config"

/**
 * Parse transaction response from StarRocks
 * Returns Effect to properly handle errors in the Effect error channel
 */
function parseResponse(
  result: Record<string, unknown>,
  label: string,
  phase: "begin" | "load" | "prepare" | "commit" | "abort"
): Effect.Effect<TransactionResult, TransactionError> {
  const status = (result.Status as string) ?? "FAILED"
  const message = (result.Message as string) ?? ""

  const errorStatuses = [
    "FAILED",
    "LABEL_ALREADY_EXISTS",
    "TXN_NOT_EXISTS",
    "ANALYSIS_ERROR",
    "INTERNAL_ERROR",
  ]

  if (errorStatuses.includes(status)) {
    return Effect.fail(
      new TransactionError({
        label,
        phase,
        txnId: result.TxnId as number | undefined,
        cause: message || `Transaction ${phase} failed with status: ${status}`,
      })
    )
  }

  return Effect.succeed({
    txnId: (result.TxnId as number) ?? 0,
    label: (result.Label as string) ?? label,
    status: status === "OK" ? "OK" : "FAILED",
    message,
    numberLoadedRows: result.NumberLoadedRows as number | undefined,
    numberFilteredRows: result.NumberFilteredRows as number | undefined,
    loadBytes: result.LoadBytes as number | undefined,
  })
}

/**
 * Transaction live layer implementation
 */
export const TransactionLive = Layer.effect(
  Transaction,
  Effect.gen(function* () {
    const config = yield* StarRocksConfig

    const baseUrl = `http://${config.host}:${config.httpPort}/api/transaction`
    const auth = Buffer.from(`${config.user}:${config.password ?? ""}`).toString("base64")

    const makeHeaders = (
      label: string,
      database: string,
      table?: string,
      extra?: Record<string, string>
    ): Record<string, string> => ({
      Authorization: `Basic ${auth}`,
      Expect: "100-continue",
      label,
      db: database,
      ...(table && { table }),
      ...extra,
    })

    return {
      begin: (options) =>
        Effect.gen(function* () {
          const headers = makeHeaders(options.label, options.database, options.table, {
            ...(options.timeout && { timeout: String(options.timeout) }),
            ...(options.idleTimeout && { idle_transaction_timeout: String(options.idleTimeout) }),
            ...(options.multiTable && { transaction_type: "multi" }),
          })

          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/begin`, { method: "POST", headers }),
            catch: (e) =>
              new TransactionError({
                label: options.label,
                phase: "begin",
                cause: e instanceof Error ? e.message : "HTTP request failed",
              }),
          })

          const result = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new TransactionError({
                label: options.label,
                phase: "begin",
                cause: "Failed to parse response",
              }),
          })

          const parsed = yield* parseResponse(result, options.label, "begin")

          return {
            label: options.label,
            txnId: parsed.txnId,
            database: options.database,
            table: options.table,
            multiTable: options.multiTable ?? false,
          } satisfies TransactionHandle
        }),

      load: (handle, data, options) =>
        Effect.gen(function* () {
          const table = options?.table ?? handle.table
          const body = Array.isArray(data) ? JSON.stringify(data) : data
          const format = options?.format ?? (Array.isArray(data) ? "json" : "csv")

          const headers = makeHeaders(handle.label, handle.database, table, {
            "Content-Type": "text/plain",
            ...(format === "json" && { format: "json", strip_outer_array: "true" }),
            ...(options?.columns && { columns: options.columns.join(", ") }),
            ...(options?.columnSeparator && { column_separator: options.columnSeparator }),
            ...(options?.partialUpdate && { partial_update: "true" }),
            ...(options?.partialUpdateMode && { partial_update_mode: options.partialUpdateMode }),
          })

          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/load`, { method: "PUT", headers, body }),
            catch: (e) =>
              new TransactionError({
                label: handle.label,
                phase: "load",
                txnId: handle.txnId,
                cause: e instanceof Error ? e.message : "HTTP request failed",
              }),
          })

          const result = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new TransactionError({
                label: handle.label,
                phase: "load",
                txnId: handle.txnId,
                cause: "Failed to parse response",
              }),
          })

          yield* parseResponse(result, handle.label, "load")
        }),

      prepare: (handle) =>
        Effect.gen(function* () {
          const headers = makeHeaders(handle.label, handle.database, undefined, {
            ...(handle.multiTable && { transaction_type: "multi" }),
          })

          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/prepare`, { method: "POST", headers }),
            catch: (e) =>
              new TransactionError({
                label: handle.label,
                phase: "prepare",
                txnId: handle.txnId,
                cause: e instanceof Error ? e.message : "HTTP request failed",
              }),
          })

          const result = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new TransactionError({
                label: handle.label,
                phase: "prepare",
                txnId: handle.txnId,
                cause: "Failed to parse response",
              }),
          })

          yield* parseResponse(result, handle.label, "prepare")
        }),

      commit: (handle) =>
        Effect.gen(function* () {
          const headers = makeHeaders(handle.label, handle.database, undefined, {
            ...(handle.multiTable && { transaction_type: "multi" }),
          })

          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/commit`, { method: "POST", headers }),
            catch: (e) =>
              new TransactionError({
                label: handle.label,
                phase: "commit",
                txnId: handle.txnId,
                cause: e instanceof Error ? e.message : "HTTP request failed",
              }),
          })

          const result = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new TransactionError({
                label: handle.label,
                phase: "commit",
                txnId: handle.txnId,
                cause: "Failed to parse response",
              }),
          })

          return yield* parseResponse(result, handle.label, "commit")
        }),

      abort: (handle) =>
        Effect.gen(function* () {
          const headers = makeHeaders(handle.label, handle.database, undefined, {
            ...(handle.multiTable && { transaction_type: "multi" }),
          })

          const response = yield* Effect.tryPromise({
            try: () => fetch(`${baseUrl}/rollback`, { method: "POST", headers }),
            catch: (e) =>
              new TransactionError({
                label: handle.label,
                phase: "abort",
                txnId: handle.txnId,
                cause: e instanceof Error ? e.message : "HTTP request failed",
              }),
          })

          const result = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new TransactionError({
                label: handle.label,
                phase: "abort",
                txnId: handle.txnId,
                cause: "Failed to parse response",
              }),
          })

          yield* parseResponse(result, handle.label, "abort")
        }),
    } satisfies TransactionService
  })
)
