/**
 * @jellologic/starrocks-sdk - StarRocks infrastructure tooling with Effect.ts integration
 *
 * Pure StarRocks-specific features: Stream Load, 2PC Transactions,
 * Materialized Views, Schema DSL, Migrations, Data Archive.
 *
 * For Drizzle ORM connection, schema, and query builders, use the Drizzle adapter.
 */

// =============================================================================
// Drizzle / mysql2 compatibility
// =============================================================================
export { wrapPoolForStarRocks } from "./pool"

// =============================================================================
// Effect Services (Ports) - Service tags for dependency injection
// =============================================================================
export {
  StreamLoad,
  type StreamLoadService,
  type StreamLoadResult as EffectStreamLoadResult,
  type StreamLoadOptions as EffectStreamLoadOptions,
  type StreamLoadCsvOptions,
} from "./services/stream-load.service"

export {
  Transaction,
  type TransactionService,
  type TransactionHandle,
  type TransactionResult as EffectTransactionResult,
  type TransactionLoadOptions as EffectTransactionLoadOptions,
  type TransactionBeginOptions,
} from "./services/transaction.service"

// =============================================================================
// Effect Layers (Adapters) - Concrete implementations
// =============================================================================
export { StreamLoadLive } from "./layers/stream-load.layer"
export { TransactionLive } from "./layers/transaction.layer"

// =============================================================================
// Configuration
// =============================================================================
export {
  StarRocksConfig,
  StarRocksConfigLive,
  StarRocksConfigFromEnv,
  StarRocksConfigSchema,
  type StarRocksConfigType,
} from "./config/starrocks.config"

// =============================================================================
// Errors (Tagged)
// =============================================================================
export * from "./errors"

// =============================================================================
// Schema DSL (Unchanged) - Type-safe table definitions
// =============================================================================
export * from "./schema"

// =============================================================================
// StarRocks Client (for DDL, Stream Load, Migrations)
// =============================================================================

// Client
export { StarRocksClient, createStarRocksClient } from "./client"

// Stream Load
export {
  StreamLoadClient,
  createStreamLoadClient,
  type StreamLoadConfig,
  type StreamLoadOptions,
  type StreamLoadResult,
} from "./stream-load"

// Stream Load Transaction (2PC)
export {
  StreamLoadTransactionClient,
  createStreamLoadTransactionClient,
  LegacyTransactionError,
  type TransactionConfig,
  type TransactionLoadOptions,
  type TransactionResult,
} from "./stream-load-transaction"

// Data Archive (S3/HDFS export)
export {
  DataArchiveClient,
  createDataArchiveClient,
  type S3Destination,
  type HDFSDestination,
  type ArchiveDestination,
  type ArchiveFormat,
  type ArchiveCompression,
  type ArchiveOptions,
  type ArchiveResult,
  type ArchivePolicySource,
  type ArchivePolicyConfig,
  type ArchivePolicy,
  type PurgeOptions,
  type PurgeResult,
} from "./data-archive"

// Materialized Views
export {
  MaterializedViewManager,
  type MaterializedViewOptions,
  type MaterializedViewProperties,
  type MaterializedViewInfo,
  type RefreshTaskInfo,
  type RefreshStrategy,
  type ManualRefresh,
  type AsyncRefresh,
} from "./materialized-views"

// Schema Diff / Validation
export {
  SchemaIntrospector,
  SchemaDiffer,
  SchemaValidator,
  type TableSchema,
  type SchemaDefinition,
  type IntrospectedColumn,
  type IntrospectedTable,
  type IntrospectedSchema,
  type SchemaDiff,
  type SchemaDiffResult,
  type DiffSeverity,
} from "./schema-diff"

// Migrations
export {
  MigrationRunner,
  MigrationBuilder,
  createMigration,
  type Migration,
  type MigrationStep,
  type MigrationRecord,
  type MigrationResult,
  type MigrationPlan,
  type DryRunResult,
} from "./migrations"

// Types
export type {
  // Configuration
  StarRocksConfig as StarRocksClientConfig,
  StarRocksConnection,
  // Key types
  KeyType,
  // Data types
  BasicDataType,
  DataType,
  ArrayType,
  MapType,
  StructType,
  StructField,
  VectorType,
  // Aggregate functions
  AggregateFunction,
  // Column definitions
  ColumnDef,
  // Index types
  IndexDef,
  BitmapIndex,
  BloomFilterIndex,
  InvertedIndex,
  VectorIndex,
  VectorIndexType,
  HNSWParams,
  IVFPQParams,
  TokenizerType,
  // Partitioning
  PartitionConfig,
  RangePartitionConfig,
  ListPartitionConfig,
  ExpressionPartition,
  RangePartition,
  ListPartition,
  // Distribution
  DistributionConfig,
  HashDistribution,
  RandomDistribution,
  // Table options
  TableOptions,
  TableProperties,
  LegacyTableOptions,
  // Load job info
  LoadJobInfo,
  // Schema introspection
  ColumnInfo,
  PartitionInfo,
  TableStats,
  TableInfo,
} from "./types"
