# @jellologic/starrocks-sdk

Type-safe StarRocks SDK for TypeScript with Effect.ts integration. Schema DSL, Stream Load, 2PC transactions, query builder, migrations, and more.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Effect.ts](https://img.shields.io/badge/Effect.ts-3.x-purple)](https://effect.website/)
[![StarRocks](https://img.shields.io/badge/StarRocks-3.x-orange)](https://www.starrocks.io/)
[![Bun](https://img.shields.io/badge/Bun-1.x-black?logo=bun)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)
[![Stability: Beta](https://img.shields.io/badge/Stability-Beta-yellow)](https://github.com/jellologic/starrocks-sdk)

> **ESM-only** — This package is published as ES Modules only. It requires Node.js 18+ or Bun 1.x with `"type": "module"` in your `package.json`.

## Features

- **Schema DSL** — Drizzle-style type-safe table definitions with full StarRocks support (key types, distribution, partitioning)
- **Query Builder** — Type-safe SELECT with joins, CTEs, set operations, window functions, and CASE/WHEN
- **Stream Load** — Effect.ts service for bulk data loading (JSON, CSV, objects) with retry support
- **2PC Transactions** — Effect.ts service for two-phase commit data loading with multi-table support
- **Migrations** — Forward-only migration system with dry-run, checkpoints, and dependency tracking
- **Materialized Views** — Async MV creation, refresh strategies, and management operations
- **Data Archive** — Export to S3/HDFS in Parquet, CSV, or ORC with compression and retention policies
- **Drizzle ORM Adapter** — Bridge StarRocks DDL to Drizzle `mysqlTable` for a single source of truth
- **Views** — Logical view builder with security modes
- **Effect.ts DI** — Service/Layer pattern with tagged errors and `catchTags()` support

## Install

```bash
bun add github:jellologic/starrocks-sdk
```

## Quick Start

```typescript
import {
  starrocksTable, bigint, varchar, datetime,
  primaryKey, hash, rangePartition,
  generateCreateTableSQL,
} from "@jellologic/starrocks-sdk/schema"

// 1. Define a table
const events = starrocksTable("events", {
  id: bigint("id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  venue: varchar("venue", { length: 255 }),
  eventDate: datetime("event_date").notNull(),
}, (t) => ({
  pk: primaryKey(t.id),
  dist: hash(t.id, { buckets: 8 }),
  part: rangePartition(t.eventDate, { interval: "MONTH" }),
}))

// 2. Generate DDL
const ddl = generateCreateTableSQL(events)

// 3. Stream Load data via Effect service
import { StreamLoad, StreamLoadLive, StarRocksConfigLive } from "@jellologic/starrocks-sdk"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const loader = yield* StreamLoad
  const result = yield* loader.loadObjects(
    [{ id: 1n, name: "Concert", venue: "Arena", event_date: "2024-06-15" }],
    { database: "mydb", table: "events" }
  )
  yield* Effect.log(`Loaded ${result.numberLoadedRows} rows`)
})

Effect.runPromise(
  program.pipe(
    Effect.provide(StreamLoadLive),
    Effect.provide(StarRocksConfigLive({ host: "localhost", httpPort: 8030, user: "root" }))
  )
)
```

## Schema DSL

### Table Definition

Define tables with `starrocksTable()`. The config callback receives column references for type-safe key/distribution definitions:

```typescript
import {
  starrocksTable, bigint, varchar, int, datetime, decimal, boolean, json,
  primaryKey, duplicateKey, aggregateKey, uniqueKey,
  hash, random,
  rangePartition, listPartition, expressionPartition,
  generateCreateTableSQL,
} from "@jellologic/starrocks-sdk/schema"

const orders = starrocksTable("orders", {
  id: bigint("id").notNull(),
  userId: bigint("user_id").notNull(),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  createdAt: datetime("created_at").notNull(),
}, (t) => ({
  pk: primaryKey(t.id),
  dist: hash(t.id, { buckets: 16 }),
  part: rangePartition(t.createdAt, { interval: "DAY" }),
  properties: { replication_num: 3, storage_medium: "SSD" },
}))

console.log(generateCreateTableSQL(orders))
```

### Column Types

| Function | StarRocks Type | TypeScript Type |
|----------|---------------|-----------------|
| `bigint(name)` | BIGINT | `bigint` |
| `int(name)` | INT | `number` |
| `smallint(name)` | SMALLINT | `number` |
| `tinyint(name)` | TINYINT | `number` |
| `largeint(name)` | LARGEINT | `bigint` |
| `double(name)` | DOUBLE | `number` |
| `float(name)` | FLOAT | `number` |
| `decimal(name, { precision, scale })` | DECIMAL(p,s) | `string` |
| `varchar(name, { length })` | VARCHAR(n) | `string` |
| `char(name, { length })` | CHAR(n) | `string` |
| `string(name)` | STRING | `string` |
| `date(name)` | DATE | `Date` |
| `datetime(name)` | DATETIME | `Date` |
| `boolean(name)` | BOOLEAN | `boolean` |
| `json(name)` | JSON | `unknown` |
| `array(name, elementCol)` | ARRAY\<T\> | `T[]` |
| `map(name, keyCol, valCol)` | MAP\<K,V\> | `Map<K,V>` |
| `struct(name, fields)` | STRUCT\<...\> | `{ ... }` |
| `hll(name)` | HLL | `unknown` |
| `bitmap(name)` | BITMAP | `unknown` |

Column modifiers: `.notNull()`, `.default(value)`, `.aggregate(fn)`

### Key Types

```typescript
// PRIMARY KEY — upsert semantics, latest value wins
primaryKey(t.id)

// DUPLICATE KEY — append-only, allows duplicates (best for logs/events)
duplicateKey(t.eventDate, t.id)

// AGGREGATE KEY — pre-aggregation on insert
aggregateKey(t.userId, t.date)

// UNIQUE KEY — unique constraint with replace semantics
uniqueKey(t.orderId)
```

### Distribution

```typescript
// HASH distribution — deterministic placement by column(s)
hash(t.id, { buckets: 16 })
hash([t.userId, t.eventId], { buckets: 32 })

// RANDOM distribution — even spread across buckets
random({ buckets: 8 })
```

### Partitioning

```typescript
// RANGE with auto intervals
rangePartition(t.createdAt, { interval: "DAY" })

// RANGE with explicit partitions
rangePartition(t.createdAt, {
  partitions: [
    { name: "p2024", lessThan: "2025-01-01" },
    { name: "p2025", lessThan: "2026-01-01" },
    { name: "pmax", lessThan: "MAXVALUE" },
  ],
})

// LIST partitioning
listPartition(t.region, {
  p_us: ["US", "CA"],
  p_eu: ["UK", "DE", "FR"],
})

// Expression partitioning (raw SQL)
expressionPartition("date_trunc('month', created_at)")
```

### Type Inference

```typescript
// Infer TypeScript types from table definitions
type OrderSelect = typeof orders.$inferSelect
// { id: bigint; userId: bigint; amount: string; status: string; createdAt: Date }

type OrderInsert = typeof orders.$inferInsert
// Required: { id: bigint; userId: bigint; amount: string; status: string; createdAt: Date }
// Optional (nullable/defaulted columns): ...
```

## Query Builder

Type-safe query builder with parameterized values for safe SQL generation:

```typescript
import {
  QueryBuilder, createQueryInterface,
  eq, gt, and, or, like, inArray, between, isNotNull,
  sum, count, avg, countDistinct,
  asc, desc,
  sql,
} from "@jellologic/starrocks-sdk/schema"
```

### SELECT, WHERE, ORDER, LIMIT

```typescript
const db = createQueryInterface(pool)

const results = await db.select({
    id: orders.id,
    amount: orders.amount,
    status: orders.status,
  })
  .from(orders)
  .where(and(
    gt(orders.amount, 100),
    eq(orders.status, "completed"),
  ))
  .orderBy(desc(orders.amount))
  .limit(50)
  .execute()
```

### JOINs

```typescript
const query = new QueryBuilder()
  .select({
    orderId: orders.id,
    userName: users.name,
    amount: orders.amount,
  })
  .from(orders)
  .innerJoin(users, eq(orders.userId, users.id))
  .where(gt(orders.amount, 0))
```

Supported join types: `innerJoin`, `leftJoin`, `rightJoin`, `fullJoin`

### GROUP BY / HAVING

```typescript
const query = db.select({
    userId: orders.userId,
    totalSpent: sum(orders.amount),
    orderCount: count(orders.id),
  })
  .from(orders)
  .groupBy(orders.userId)
  .having(gt(count(orders.id), 5))
```

### CTEs (WITH clause)

```typescript
const query = new QueryBuilder(pool)
  .with("big_spenders", (qb) =>
    qb.select({ userId: orders.userId, total: sum(orders.amount) })
      .from(orders)
      .groupBy(orders.userId)
      .having(gt(sum(orders.amount), 10000))
  )
  .selectAll()
  .from(sql`big_spenders`)
```

### Set Operations

```typescript
const active = new QueryBuilder().select({ id: users.id }).from(users).where(eq(users.active, true))
const admins = new QueryBuilder().select({ id: users.id }).from(users).where(eq(users.role, "admin"))

const combined = active.union(admins)         // UNION (distinct)
const all = active.unionAll(admins)           // UNION ALL
const both = active.intersect(admins)         // INTERSECT
const onlyActive = active.except(admins)      // EXCEPT
```

### Window Functions

```typescript
import {
  rowNumber, rank, denseRank, ntile,
  lag, lead, firstValue, lastValue,
  partitionBy, windowOrderBy,
  rows, unboundedPreceding, currentRow,
} from "@jellologic/starrocks-sdk/schema"

const query = db.select({
    id: orders.id,
    amount: orders.amount,
    rowNum: rowNumber().over(
      partitionBy(orders.userId),
      windowOrderBy(desc(orders.amount)),
    ),
    runningTotal: sum(orders.amount).over(
      partitionBy(orders.userId),
      windowOrderBy(orders.createdAt),
      rows(unboundedPreceding(), currentRow()),
    ),
    prevAmount: lag(orders.amount, 1).over(
      partitionBy(orders.userId),
      windowOrderBy(orders.createdAt),
    ),
  })
  .from(orders)
```

### CASE/WHEN Expressions

```typescript
import { caseWhen, caseExpr, when, ifExpr, coalesce } from "@jellologic/starrocks-sdk/schema"

// Searched CASE
const tier = caseWhen(
  when(gt(orders.amount, 1000), "premium"),
  when(gt(orders.amount, 100), "standard"),
).else("basic")

// Simple CASE
const label = caseExpr(orders.status,
  when("active", "Active"),
  when("cancelled", "Cancelled"),
).else("Unknown")

// IF / COALESCE / IFNULL / NULLIF
const flag = ifExpr(gt(orders.amount, 0), "positive", "non-positive")
const safe = coalesce(orders.venue, "N/A")
```

### Subqueries

```typescript
const topUsers = new QueryBuilder()
  .select({ userId: orders.userId, total: sum(orders.amount) })
  .from(orders)
  .groupBy(orders.userId)
  .limit(100)
  .as("top_users")

const query = new QueryBuilder(pool)
  .selectAll()
  .from(topUsers)
```

### Raw SQL

```typescript
const db = createQueryInterface(pool)
const rows = await db.raw<{ count: number }>("SELECT COUNT(*) as count FROM events")
await db.execute("TRUNCATE TABLE staging_events")
```

## Stream Load (Effect.ts)

Bulk data loading via StarRocks HTTP Stream Load API using Effect.ts services:

```typescript
import { StreamLoad, StreamLoadLive, StarRocksConfigLive } from "@jellologic/starrocks-sdk"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const loader = yield* StreamLoad

  // Load array of objects
  const result = yield* loader.loadObjects(
    [{ id: 1, name: "Event A" }, { id: 2, name: "Event B" }],
    { database: "mydb", table: "events" }
  )

  // Load CSV string
  yield* loader.loadCsv(
    "1,Event A\n2,Event B",
    { database: "mydb", table: "events", columnSeparator: "," }
  )

  // Load JSON string
  yield* loader.loadJson(
    '[{"id": 1, "name": "Event A"}]',
    { database: "mydb", table: "events", stripOuterArray: true }
  )
})

// Provide dependencies and run
Effect.runPromise(
  program.pipe(
    Effect.provide(StreamLoadLive),
    Effect.provide(StarRocksConfigLive({
      host: "localhost",
      httpPort: 8030,
      user: "root",
    })),
  )
)
```

### Stream Load Options

```typescript
loader.loadObjects(data, {
  database: "mydb",
  table: "events",
  label: "load-20240615",       // Unique label (auto-generated if omitted)
  columns: ["id", "name"],      // Column mapping
  timeout: 600,                 // Timeout in seconds
  maxFilterRatio: 0.1,          // Allow up to 10% row failures
  partialUpdate: true,          // Partial update for PRIMARY KEY tables
  partialUpdateMode: "row",     // "row" (real-time) or "column" (batch)
  retry: {                      // Retry config for transient failures
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
  },
})
```

## 2PC Transactions (Effect.ts)

Two-phase commit for atomically loading data across tables:

```typescript
import { Transaction, TransactionLive, StarRocksConfigLive } from "@jellologic/starrocks-sdk"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const tx = yield* Transaction

  // Begin transaction
  const handle = yield* tx.begin({
    database: "mydb",
    table: "orders",
    label: "daily-load-20240615",
    timeout: 600,
  })

  // Load data (can be called multiple times)
  yield* tx.load(handle, [
    { id: 1, amount: 99.99 },
    { id: 2, amount: 149.50 },
  ])

  // Prepare (makes data durable)
  yield* tx.prepare(handle)

  // Commit (makes data visible)
  const result = yield* tx.commit(handle)
  yield* Effect.log(`Committed ${result.numberLoadedRows} rows`)
})

Effect.runPromise(
  program.pipe(
    Effect.provide(TransactionLive),
    Effect.provide(StarRocksConfigLive({ host: "localhost", httpPort: 8030, user: "root" })),
  )
)
```

### Multi-Table Transactions

```typescript
const handle = yield* tx.begin({
  database: "mydb",
  table: "orders",
  label: "multi-table-load",
  multiTable: true,
})

// Load to different tables within the same transaction
yield* tx.load(handle, orderData)
yield* tx.load(handle, lineItemData, { table: "order_items" })
yield* tx.prepare(handle)
yield* tx.commit(handle)
```

### Aborting a Transaction

```typescript
yield* tx.abort(handle)  // Discards all data
```

## Migrations

Forward-only migration system designed for StarRocks (no DDL transactions):

```typescript
import { createMigration, MigrationRunner, StarRocksClient } from "@jellologic/starrocks-sdk"

// Define a migration
const migration = createMigration("20240615_001_create_events", "Create events table")
  .createTable("events", `
    CREATE TABLE IF NOT EXISTS events (
      id BIGINT NOT NULL,
      name VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL
    )
    PRIMARY KEY (id)
    DISTRIBUTED BY HASH(id) BUCKETS 8
    PROPERTIES ("replication_num" = "1")
  `)
  .addColumn("events", "venue VARCHAR(255)")
  .checkpoint("added_venue_column")
  .build()

// Run migrations
const client = new StarRocksClient(config)
const runner = new MigrationRunner(client, "mydb")
await runner.initialize()

// Preview changes with dry run
const results = await runner.migrate([migration], { dryRun: true })

// Apply migrations
const results = await runner.migrate([migration])

// Check status
const status = await runner.status()
console.log(`Applied: ${status.appliedCount}, Failed: ${status.failedMigrations.length}`)
```

### Migration Builder Methods

```typescript
createMigration(id, description)
  .createTable(name, sql)        // CREATE TABLE IF NOT EXISTS
  .dropTable(name)               // DROP TABLE IF EXISTS
  .addColumn(table, columnDef)   // ALTER TABLE ADD COLUMN
  .dropColumn(table, column)     // ALTER TABLE DROP COLUMN
  .modifyColumn(table, def)      // ALTER TABLE MODIFY COLUMN
  .sql(name, rawSql)             // Raw SQL step
  .addStep(name, sql, opts)      // Generic step with options
  .checkpoint(name)              // Recovery checkpoint
  .down(name, sql)               // Rollback step (documentation)
  .build(dependsOn?)             // Build Migration object
```

### Migration Dependencies

```typescript
const m1 = createMigration("001_users", "Create users").createTable("users", sql).build()
const m2 = createMigration("002_orders", "Create orders").createTable("orders", sql).build(["001_users"])
// m2 will always run after m1
```

## Materialized Views

### Schema DSL Materialized Views

Type-safe MV definitions using the schema DSL:

```typescript
import {
  createMaterializedView, bigint, double,
  count, sum, generateCreateMaterializedViewSQL,
} from "@jellologic/starrocks-sdk/schema"

const eventsByVenue = createMaterializedView("events_by_venue")
  .columns({
    venueId: bigint("venue_id"),
    eventCount: bigint("event_count"),
    totalRevenue: double("total_revenue"),
  })
  .distributed({ type: "HASH", columns: ["venue_id"], buckets: 8 })
  .refresh({ type: "ASYNC", every: { value: 1, unit: "HOUR" } })
  .properties({
    replication_num: 1,
    query_rewrite_consistency: "loose",
  })
  .comment("Aggregated statistics by venue")
  .as((qb) =>
    qb.select({
      venueId: events.venueId,
      eventCount: count(events.id),
      totalRevenue: sum(events.price),
    })
    .from(events)
    .groupBy(events.venueId)
  )

const ddl = generateCreateMaterializedViewSQL(eventsByVenue)
```

### MV Manager (Imperative API)

```typescript
import { MaterializedViewManager } from "@jellologic/starrocks-sdk"

const mvManager = new MaterializedViewManager(
  (sql) => client.execute(sql),
  (sql) => client.raw(sql),
)

// Create
await mvManager.create({
  name: "daily_summary",
  query: "SELECT date, SUM(amount) as total FROM orders GROUP BY date",
  refresh: { type: "ASYNC", every: { value: 1, unit: "HOUR" } },
})

// Refresh
await mvManager.refresh("daily_summary", { syncMode: true })

// List all MVs
const views = await mvManager.list()

// Alter refresh strategy
await mvManager.alter("daily_summary", {
  refresh: { type: "ASYNC", every: { value: 30, unit: "MINUTE" } },
})

// Drop
await mvManager.drop("daily_summary")
```

### MV Operations (Pool-based)

```typescript
import { createMVOperations } from "@jellologic/starrocks-sdk/schema"

const ops = createMVOperations(pool, eventsByVenue)
await ops.refresh({ sync: true })
await ops.setRefresh({ type: "ASYNC", every: { value: 5, unit: "MINUTE" } })
const status = await ops.status()
```

## Data Archive

Export data to S3 or HDFS using StarRocks `INSERT INTO FILES`:

```typescript
import { DataArchiveClient } from "@jellologic/starrocks-sdk"

const archive = new DataArchiveClient({
  host: "localhost", port: 9030, user: "root",
})

// Ad-hoc archive
const result = await archive.archive({
  query: "SELECT * FROM events WHERE event_date < '2024-01-01'",
  destination: {
    type: "s3",
    path: "s3://my-bucket/archive/events/",
    credentials: {
      accessKey: "...",
      secretKey: "...",
      region: "us-east-1",
    },
  },
  format: "parquet",
  compression: "zstd",
  partitionBy: "event_date",
})
console.log(`Archived ${result.totalRows} rows to ${result.files.length} files`)
```

### Archive Policies

```typescript
const policy = archive.definePolicy({
  name: "monthly_events",
  source: {
    database: "mydb",
    table: "events",
    filter: "event_date < DATE_SUB(NOW(), INTERVAL 90 DAY)",
  },
  destination: {
    type: "s3",
    path: "s3://my-bucket/archive/events/",
    pathTemplate: "s3://my-bucket/archive/events/{year}/{month}/",
    credentials: { accessKey: "...", secretKey: "...", region: "us-east-1" },
  },
  format: "parquet",
  compression: "snappy",
})

// Execute policy
await archive.executePolicy(policy)

// Purge archived data (requires filter for safety)
await archive.purgeArchived({
  database: "mydb",
  table: "events",
  filter: "event_date < DATE_SUB(NOW(), INTERVAL 90 DAY)",
  dryRun: true,  // Preview first
})
```

### Supported Formats & Compression

| Format | Compression Options |
|--------|-------------------|
| `parquet` | `uncompressed`, `snappy`, `zstd`, `lz4`, `gzip` |
| `csv` | `uncompressed`, `gzip` |
| `orc` | `uncompressed`, `snappy`, `zstd`, `lz4` |

## Drizzle ORM Adapter

Bridge StarRocks table definitions to Drizzle ORM for a single source of truth:

```typescript
import { starrocksTable, varchar, bigint, primaryKey, hash, toDrizzle } from "@jellologic/starrocks-sdk/schema"

// Define once with StarRocks DDL features
const srUser = starrocksTable("user", {
  id: varchar("id", { length: 36 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
}, (t) => ({
  pk: primaryKey(t.id),
  dist: hash(t.id, { buckets: 4 }),
}))

// Derive Drizzle table for ORM operations
export const user = toDrizzle(srUser)

// Use with Drizzle ORM
import { drizzle } from "drizzle-orm/mysql2"
const db = drizzle(pool)
const users = await db.select().from(user).where(eq(user.name, "Alice"))
```

### StarRocks Pool Wrapper

StarRocks uses the MySQL wire protocol but doesn't support all MySQL SQL syntax. The pool wrapper patches known incompatibilities:

```typescript
import { wrapPoolForStarRocks } from "@jellologic/starrocks-sdk"
import { createPool } from "mysql2/promise"

const rawPool = createPool({ host: "localhost", port: 9030, user: "root" })
const pool = wrapPoolForStarRocks(rawPool)

// Now Drizzle INSERT statements work with StarRocks
const db = drizzle(pool)
```

## Views

Type-safe logical view definitions:

```typescript
import { createView, generateCreateViewSQL } from "@jellologic/starrocks-sdk/schema"

const recentEvents = createView("recent_events")
  .columns({
    id: bigint("id"),
    name: varchar("name", { length: 255 }),
  })
  .security("INVOKER")
  .comment("Events from the last 7 days")
  .as((qb) =>
    qb.select({ id: events.id, name: events.name })
      .from(events)
      .where(gt(events.createdAt, sql`NOW() - INTERVAL 7 DAY`))
  )

const ddl = generateCreateViewSQL(recentEvents)
```

SQL generation functions: `generateCreateViewSQL`, `generateDropViewSQL`, `generateReplaceViewSQL`

## Configuration

### Explicit Configuration

```typescript
import { StarRocksConfigLive } from "@jellologic/starrocks-sdk"

const config = StarRocksConfigLive({
  host: "localhost",
  httpPort: 8030,    // FE HTTP port (for Stream Load)
  mysqlPort: 9030,   // MySQL protocol port (default: 9030)
  user: "root",
  password: "",
  database: "mydb",
})

program.pipe(Effect.provide(config))
```

### Environment Variables

```typescript
import { StarRocksConfigFromEnv } from "@jellologic/starrocks-sdk"

// Reads: STARROCKS_HOST, STARROCKS_HTTP_PORT, STARROCKS_PORT,
//        STARROCKS_USER, STARROCKS_PASSWORD, STARROCKS_DATABASE
program.pipe(Effect.provide(StarRocksConfigFromEnv))
```

### mysql2 Connection Pool

For the Query Builder, Drizzle adapter, and MV operations:

```typescript
import { createPool } from "mysql2/promise"
import { wrapPoolForStarRocks } from "@jellologic/starrocks-sdk"

const pool = wrapPoolForStarRocks(createPool({
  host: "localhost",
  port: 9030,
  user: "root",
  database: "mydb",
}))
```

## Error Types

All errors are `Schema.TaggedError` from `@effect/schema`, enabling structured error handling with `catchTags()`:

| Error | Fields | Description |
|-------|--------|-------------|
| `ConnectionError` | `host`, `port`, `cause` | Connection/configuration failures |
| `StreamLoadError` | `table`, `message`, `status`, `errorUrl`, `numberFilteredRows` | Stream Load failures |
| `TransactionError` | `label`, `phase`, `txnId`, `cause`, `status`, `table` | 2PC transaction failures (phase: begin/load/prepare/commit/abort) |
| `ArchiveError` | `operation`, `target`, `cause` | S3/HDFS export failures |
| `MigrationError` | `migrationId`, `step`, `cause` | Migration execution failures |
| `MaterializedViewError` | `viewName`, `operation`, `cause` | MV operation failures |
| `QueryError` | `operation`, `table`, `reason` | Query builder validation failures |

### Error Handling

```typescript
import { Effect } from "effect"

program.pipe(
  Effect.catchTags({
    StreamLoadError: (e) =>
      Effect.logError(`Load to '${e.table}' failed: ${e.message}`),
    TransactionError: (e) =>
      Effect.logError(`Txn '${e.label}' failed at ${e.phase}: ${e.cause}`),
    ConnectionError: (e) =>
      Effect.logError(`Cannot connect to ${e.host}:${e.port}`),
  })
)
```

## Testing

### Local StarRocks Container

The SDK includes a Docker Compose file for running StarRocks locally:

```bash
# Start StarRocks (MySQL on :19030, FE HTTP on :18030, BE HTTP on :18040)
bun run db:up

# Run tests
bun test

# Stop StarRocks
bun run db:down
```

### Docker Compose Ports

| Port | Service |
|------|---------|
| 19030 | MySQL protocol (queries) |
| 18030 | FE HTTP (Stream Load) |
| 18040 | BE HTTP |

## Export Map

```typescript
// Main entry — Effect services, clients, errors, schema DSL
import { StreamLoad, Transaction, StarRocksConfigLive, ... } from "@jellologic/starrocks-sdk"

// Schema DSL — tables, columns, expressions, query builder, views, MVs, Drizzle adapter
import { starrocksTable, varchar, eq, QueryBuilder, toDrizzle, ... } from "@jellologic/starrocks-sdk/schema"

// Deep imports — individual modules
import { ... } from "@jellologic/starrocks-sdk/stream-load"
import { ... } from "@jellologic/starrocks-sdk/migrations"
import { ... } from "@jellologic/starrocks-sdk/data-archive"
import { ... } from "@jellologic/starrocks-sdk/materialized-views"
```

## Compatibility

| Dependency | Required Version | Notes |
|------------|-----------------|-------|
| StarRocks | 3.0+ | Tested with 3.5-latest in CI |
| Node.js | 18+ | ESM-only (`"type": "module"`) |
| Bun | 1.x | Primary runtime for development/testing |
| TypeScript | 5.0+ | Strict mode recommended |
| Effect.ts | 3.x | Core dependency for service/layer architecture |
| mysql2 | 3.x | Required for Query Builder, Drizzle, and MV operations |

## API Reference

See [CLAUDE.md](./CLAUDE.md) for the full export reference, architecture overview, and key patterns.

## License

MIT
