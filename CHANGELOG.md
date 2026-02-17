# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- ALTER TABLE DDL builder with fluent immutable API (#39)
- Observability hooks: Effect Metrics and Spans for StreamLoad and Transaction layers (#28)
- Test coverage reporting via `bun test --coverage` in CI (#36)
- 54 unit tests for error classification, response parsing, and input validation (#36)
- Sub-path exports for focused imports: `./schema/columns`, `./schema/expressions`, etc. (#47)
- Shared option interfaces between StreamLoad and Transaction (`BaseLoadOptions`, `CsvLoadOptions`, `JsonLoadOptions`) (#44)
- Payload size warnings (>100MB) and data loss detection for filtered rows (#41)
- Safe JSON serialization with descriptive errors for circular refs and BigInt (#41)
- Input validation for StreamLoad and Transaction parameters
- Full pipeline integration test (#14)
- Introspector, differ, and migration generator edge case tests (#14)

### Fixed

- "Timed out" errors now correctly classified as retryable in both layers (#36)
- Tightened Biome lint rules: `noNonNullAssertion` and `noExplicitAny` enforced in src/ (#46)
- CI security: pinned Docker image, added `--frozen-lockfile`, removed unsafe scripts (#37)
- HTTP response status validation with `httpStatus` on error types
- Tagged `ConnectionError` in config validation instead of plain `Error`

### Changed

- Documented `sql` template tag parameterization safety (#40)
- Clarified retry schedule semantics and documented retryable error conditions (#35)

### Security

- Fix SQL injection: validate all SQL identifiers and escape user input in client.ts (#9)
- Fix credential exposure: prevent credential leakage in error messages (#10)

### Infrastructure

- Biome linting and formatting with recommended rules (#11)
- CI workflow for typecheck, lint, and build (#12)
- HTTP timeouts on all fetch calls with AbortSignal (#15)
- Runtime type validation for Stream Load and Transaction responses (#17)
- Resource lifecycle management (Layer.scoped + finalizers) for Effect layers (#18)
- Retry logic for Transaction load, prepare, and commit operations (#27)
- Input validation for column definitions (VARCHAR, CHAR, DECIMAL) (#26)
- Configurable connection pool settings via StarRocksConfig.pool (#22)
- SHA-256 checksums for migration integrity (#23)
- Explicit subpath exports in package.json (#25)
- Replace incomplete reserved word list with unconditional backtick quoting (#26)
- Replace console.warn with structured Effect logging (#20)

## [0.1.0] - 2026-02-16

### Added

- Initial release
- StarRocks client with DDL, Stream Load, 2PC transactions
- Effect.ts service/layer architecture
- Schema DSL for type-safe table definitions
- Materialized view management
- Migration system with checkpoints and dry-run
- Data archive (S3/HDFS export)
- Drizzle ORM integration
