# Contributing to @jellologic/starrocks-sdk

## Development Setup

```bash
# Clone and install
git clone https://github.com/jellologic/starrocks-sdk.git
cd starrocks-sdk
bun install
```

## Running Tests

```bash
bun test          # Starts StarRocks Docker container automatically
bun run build     # TypeScript compilation check
bun run lint      # Biome linting
```

Tests require Docker. The test harness auto-starts a StarRocks container and cleans up after.

## Commit Message Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature description
fix: correct bug description
docs: update documentation
test: add or update tests
refactor: restructure without behavior change
chore: maintenance tasks
```

Reference issues: `feat: add ALTER TABLE support (issue #39)`

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with tests
3. Ensure `bun test` and `bun run build` pass
4. Submit a PR against `main`
5. PRs require passing CI before merge

## Architecture

See [CLAUDE.md](./CLAUDE.md) for architecture overview, key patterns, and directory structure.

## Code Style

- **Effect.ts** for service/layer architecture (ports and adapters)
- **Tagged errors** via `Schema.TaggedError` for typed error handling
- **Biome** for linting and formatting (run `bun run lint` to check)
- Avoid `any` in `src/` (except `src/schema/` where generic type parameters are idiomatic)
- No non-null assertions (`!`) in `src/`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
