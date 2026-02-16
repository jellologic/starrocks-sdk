# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Fix SQL injection: validate all SQL identifiers and escape user input in client.ts (#9)
- Fix credential exposure: prevent credential leakage in error messages (#10)

### Added

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

### Changed

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
