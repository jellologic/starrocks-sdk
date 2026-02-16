/**
 * StarRocks Type-Safe Schema
 *
 * Drizzle-style type-safe table definitions, query builder, and expressions.
 */

// Column types
export {
  // Column type
  type Column,
  type Columns,
  type AggregateFunction,
  type InferColumnType,
  type InferSelectType,
  type InferInsertType,

  // Numeric
  bigint,
  int,
  smallint,
  tinyint,
  largeint,
  double,
  float,
  decimal,

  // String
  varchar,
  char,
  string,

  // Date/Time
  date,
  datetime,

  // Boolean
  boolean,

  // JSON
  json,

  // Complex
  array,
  map,
  struct,

  // Special
  hll,
  bitmap,
} from "./columns";

// Table definitions
export {
  // Table
  starrocksTable,
  generateCreateTableSQL,
  type Table,
  type TableWithRefs,
  type ColumnRef,
  type TableConfig,
  type TableProperties,

  // Key types
  primaryKey,
  duplicateKey,
  aggregateKey,
  uniqueKey,
  type KeyType,
  type KeyConfig,

  // Distribution
  hash,
  random,
  type DistributionType,
  type DistributionConfig,
  type HashDistributionConfig,
  type RandomDistributionConfig,

  // Partitioning
  rangePartition,
  listPartition,
  expressionPartition,
  type PartitionType,
  type PartitionConfig,
  type RangePartitionConfig,
  type ListPartitionConfig,
  type ExpressionPartitionConfig,
} from "./table";

// Expressions
export {
  // Expression types
  type Expression,
  type BooleanExpression,

  // SQL template
  sql,

  // Comparison
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,

  // Logical
  and,
  or,
  not,

  // IN / BETWEEN / LIKE
  inArray,
  notInArray,
  between,
  like,
  ilike,

  // NULL
  isNull,
  isNotNull,

  // CASE/WHEN + Conditionals
  type WhenClause,
  type CaseBuilder,
  when,
  caseWhen,
  caseExpr,
  ifExpr,
  coalesce,
  ifNull,
  nullIf,
} from "./expressions";

// Aggregates
export {
  type AggregateExpression,

  // Basic
  count,
  countDistinct,
  sum,
  avg,
  min,
  max,

  // Statistical
  stddev,
  variance,

  // StarRocks specific
  approxCountDistinct,
  hllUnionAgg,
  bitmapUnion,
  bitmapCount,
  groupConcat,
  arrayAgg,
} from "./aggregates";

// Query builder
export {
  QueryBuilder,
  createQueryInterface,
  asc,
  desc,
  type SelectedFields,
  type InferSelectedType,
  type OrderDirection,
  type OrderSpec,
  type JoinType,
  type JoinSpec,
  type Subquery,
  type SetOperationType,
} from "./query-builder";

// Window functions
export {
  type WindowExpression,
  type WindowFunctionBuilder,
  type WindowSpec,
  type WindowFrame,
  type FrameBound,

  // Frame boundaries
  unboundedPreceding,
  preceding,
  currentRow,
  following,
  unboundedFollowing,
  rows,
  range,

  // Window spec helpers
  partitionBy,
  windowOrderBy,

  // Ranking functions
  rowNumber,
  rank,
  denseRank,
  ntile,

  // Value functions
  lag,
  lead,
  firstValue,
  lastValue,
} from "./window";

// Views
export {
  // View builder
  createView,
  generateCreateViewSQL,
  generateDropViewSQL,
  generateReplaceViewSQL,
  type View,
  type ViewWithRefs,
  type ViewSecurity,
  type ViewConfig,
} from "./view";

// Materialized Views
export {
  // MV builder
  createMaterializedView,
  generateCreateMaterializedViewSQL,
  generateDropMaterializedViewSQL,
  generateAlterRefreshSQL,
  createMVOperations,
  createMVQueryInterface,
  type MaterializedView,
  type MaterializedViewWithRefs,
  type MaterializedViewConfig,
  type MaterializedViewProperties,
  type MaterializedViewStatus,
  type MVOperations,
  type RefreshType,
  type RefreshInterval,
  type RefreshStrategy,
  type RefreshState,
} from "./materialized-view";

// Schema Definition
export {
  defineSchema,
  type Schema,
  type SchemaDefinition,
} from "./define-schema";

// Schema Introspection
export {
  createSchemaIntrospector,
  type SchemaIntrospector,
  type IntrospectedSchema,
  type IntrospectedTable,
  type IntrospectedView,
  type IntrospectedMaterializedView,
  type IntrospectedColumn,
} from "./introspector";

// Schema Diffing
export {
  diffSchema,
  summarizeDiff,
  type SchemaDiff,
  type TableChange,
  type ColumnChange,
  type ViewChange,
  type MaterializedViewChange,
} from "./differ";

// Schema Snapshot (offline introspection from code)
export {
  schemaToIntrospected,
  emptyIntrospectedSchema,
} from "./schema-snapshot";

// Migration Generation
export {
  generateMigration,
  generateMigrationSQL,
  generateDryRunOutput,
  type Migration,
  type MigrationStatement,
  type GeneratedMigration,
} from "./migration-generator";

// Knex-Style Query Builder
export {
  KnexBuilder,
  createKnexDatabase,
  type KnexDatabase,
} from "./knex-builder";

// Drizzle ORM Adapter
export { toDrizzle } from "./drizzle-adapter";

// SQL Utilities (for safe SQL generation)
export {
  escapeString,
  quoteString,
  escapeDoubleQuoted,
  quoteIdentifier,
  validateIdentifier,
  validatePartitionName,
  validateIntervalUnit,
  validatePositiveInteger,
  formatDefaultValue,
} from "./sql-utils";
