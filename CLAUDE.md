# @jellologic/starrocks-sdk

StarRocks database client with Effect.ts integration. Provides type-safe DDL, Stream Load, 2PC transactions, and materialized view management.

## Architecture

**Hybrid design:** Raw Drizzle for ORM consumers, Effect Services for everything else.

| Layer | Pattern | Use Case |
|-------|---------|----------|
| `db`, `schema` | Raw Drizzle | Better-Auth, direct queries |
| `StreamLoad`, `Transaction`, etc. | Effect Service + Layer | Application code |

## Directory Structure

```
src/
├── services/          # Effect Service interfaces (ports)
│   ├── stream-load.service.ts
│   └── transaction.service.ts
├── layers/            # Effect Layer implementations (adapters)
│   ├── stream-load.layer.ts
│   └── transaction.layer.ts
├── errors/            # Tagged errors (Effect Schema)
│   └── index.ts
├── config/            # StarRocksConfig service tag
│   └── starrocks.config.ts
├── drizzle/           # Raw Drizzle connection + schema
│   ├── connection.ts
│   └── schema.ts
├── schema/            # Type-safe DDL DSL
└── index.ts           # Barrel exports
```

## Key Patterns

- **Service = Port**: `StreamLoad`, `Transaction` are interfaces (Context.Tag)
- **Layer = Adapter**: `StreamLoadLive`, `TransactionLive` are implementations
- **Tagged Errors**: All failures are `Schema.TaggedError` for `catchTags()`
- **Config via DI**: All layers depend on `StarRocksConfig`, not env vars

## Quick Reference

```typescript
// Stream Load
import { StreamLoad, StreamLoadLive, StarRocksConfigLive } from "@jellologic/starrocks-sdk"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const loader = yield* StreamLoad
  yield* loader.loadObjects(data, { database: "mydb", table: "events" })
}).pipe(
  Effect.provide(StreamLoadLive),
  Effect.provide(StarRocksConfigLive({ host, httpPort, user }))
)

// 2PC Transaction
const txProgram = Effect.gen(function* () {
  const tx = yield* Transaction
  const handle = yield* tx.begin({ database, table, label: "my-load" })
  yield* tx.load(handle, data)
  yield* tx.commit(handle)
})

// Error handling
program.pipe(
  Effect.catchTags({
    StreamLoadError: (e) => Effect.log(`Load failed: ${e.table} - ${e.message}`),
    TransactionError: (e) => Effect.log(`Txn ${e.label} failed at ${e.phase}`),
  })
)
```

## Testing

```bash
bun run db:up        # Start StarRocks container (port 19030)
bun test             # Run integration tests
bun run db:down      # Stop container
```

## Critical Files

- `src/services/*.service.ts` - Service interfaces (ports)
- `src/layers/*.layer.ts` - Layer implementations (adapters)
- `src/errors/index.ts` - All tagged errors
- `src/config/starrocks.config.ts` - Configuration service
- `src/schema/` - DDL DSL (table definitions, views, MVs)

## Migration from Legacy API

```typescript
// OLD (class-based)
import { StreamLoadClient } from "@jellologic/starrocks-sdk"
const client = new StreamLoadClient({ host, httpPort, user })
await client.loadObjects(data, { database, table })

// NEW (Effect-based)
import { StreamLoad, StreamLoadLive, StarRocksConfigLive } from "@jellologic/starrocks-sdk"
const program = Effect.gen(function* () {
  const loader = yield* StreamLoad
  yield* loader.loadObjects(data, { database, table })
})
Effect.runPromise(program.pipe(
  Effect.provide(StreamLoadLive),
  Effect.provide(StarRocksConfigLive({ host, httpPort, user }))
))
```
