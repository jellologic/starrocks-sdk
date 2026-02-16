import { Context, Effect, Layer } from "effect"
import { Schema } from "@effect/schema"

/**
 * StarRocks connection configuration schema with validation
 */
export const StarRocksConfigSchema = Schema.Struct({
  /** FE or BE host */
  host: Schema.String,
  /** HTTP port for Stream Load (default 8030 for FE, 8040 for BE) */
  httpPort: Schema.Number.pipe(Schema.int(), Schema.positive()),
  /** MySQL protocol port (default 9030) */
  mysqlPort: Schema.optionalWith(
    Schema.Number.pipe(Schema.int(), Schema.positive()),
    { default: () => 9030 }
  ),
  /** Username */
  user: Schema.String,
  /** Password (optional, defaults to empty string) */
  password: Schema.optionalWith(Schema.String, { default: () => "" }),
  /** Default database */
  database: Schema.optional(Schema.String),
})

export type StarRocksConfigType = Schema.Schema.Type<typeof StarRocksConfigSchema>

/**
 * Configuration service tag for dependency injection
 */
export class StarRocksConfig extends Context.Tag("@starrocks/Config")<
  StarRocksConfig,
  StarRocksConfigType
>() {}

/**
 * Create config layer from explicit config object
 *
 * @example
 * ```typescript
 * const config = StarRocksConfigLive({
 *   host: "localhost",
 *   httpPort: 8030,
 *   user: "root",
 * })
 * ```
 */
export const StarRocksConfigLive = (config: StarRocksConfigType) =>
  Layer.succeed(StarRocksConfig, config)

/**
 * Create config layer from environment variables
 *
 * Reads: STARROCKS_HOST, STARROCKS_HTTP_PORT, STARROCKS_PORT, STARROCKS_USER, STARROCKS_PASSWORD, STARROCKS_DATABASE
 */
export const StarRocksConfigFromEnv = Layer.effect(
  StarRocksConfig,
  Effect.gen(function* () {
    const host = process.env.STARROCKS_HOST
    const httpPort = process.env.STARROCKS_HTTP_PORT
    const mysqlPort = process.env.STARROCKS_PORT
    const user = process.env.STARROCKS_USER

    if (!host || !httpPort || !user) {
      return yield* Effect.fail(
        new Error(
          "Missing required environment variables: STARROCKS_HOST, STARROCKS_HTTP_PORT, STARROCKS_USER"
        )
      )
    }

    return {
      host,
      httpPort: parseInt(httpPort, 10),
      mysqlPort: mysqlPort ? parseInt(mysqlPort, 10) : 9030,
      user,
      password: process.env.STARROCKS_PASSWORD ?? "",
      database: process.env.STARROCKS_DATABASE,
    }
  })
)
