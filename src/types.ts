import type { MySql2Database } from "drizzle-orm/mysql2";

export interface StarRocksConfig {
  host: string;
  mysqlPort: number;
  httpPort: number;
  user: string;
  password?: string;
  database?: string;
  pool?: {
    connectionLimit?: number;
    queueLimit?: number;
    connectTimeout?: number;
  };
}

export interface StarRocksConnection {
  db: MySql2Database;
  raw: <T = unknown>(sql: string) => Promise<T[]>;
  close: () => Promise<void>;
}

// ============================================================================
// Table Key Types
// ============================================================================

export type KeyType = "DUPLICATE" | "AGGREGATE" | "UNIQUE" | "PRIMARY";

// ============================================================================
// Data Types
// ============================================================================

/** Basic StarRocks data types */
export type BasicDataType =
  | "BOOLEAN"
  | "TINYINT"
  | "SMALLINT"
  | "INT"
  | "BIGINT"
  | "LARGEINT"
  | "FLOAT"
  | "DOUBLE"
  | "DECIMAL"
  | "DATE"
  | "DATETIME"
  | "CHAR"
  | "VARCHAR"
  | "STRING"
  | "TEXT"
  | "JSON"
  | "HLL"
  | "BITMAP"
  | "PERCENTILE"
  | "BINARY"
  | "VARBINARY";

/** Complex data types with nested type definitions */
export interface ArrayType {
  type: "ARRAY";
  elementType: DataType;
}

export interface MapType {
  type: "MAP";
  keyType: BasicDataType;
  valueType: DataType;
}

export interface StructField {
  name: string;
  type: DataType;
}

export interface StructType {
  type: "STRUCT";
  fields: StructField[];
}

/** Vector type for AI/ML embeddings */
export interface VectorType {
  type: "VECTOR";
  dimension: number;
}

export type DataType = BasicDataType | ArrayType | MapType | StructType | VectorType;

// ============================================================================
// Aggregate Functions (for AGGREGATE KEY tables)
// ============================================================================

/** Aggregate functions for value columns in AGGREGATE KEY tables */
export type AggregateFunction =
  | "SUM"
  | "MIN"
  | "MAX"
  | "REPLACE"
  | "REPLACE_IF_NOT_NULL"
  | "HLL_UNION"
  | "BITMAP_UNION"
  | "PERCENTILE_UNION";

// ============================================================================
// Column Definition
// ============================================================================

export interface ColumnDef {
  name: string;
  type: DataType;
  /** Length for CHAR, VARCHAR */
  length?: number;
  /** Precision for DECIMAL */
  precision?: number;
  /** Scale for DECIMAL */
  scale?: number;
  /** Whether the column allows NULL values */
  nullable?: boolean;
  /** Default value expression */
  defaultValue?: string;
  /** Column comment */
  comment?: string;
  /** Aggregate function for AGGREGATE KEY tables */
  aggregateType?: AggregateFunction;
  /** Auto-increment column (only for PRIMARY KEY tables) */
  autoIncrement?: boolean;
  /** Generated column expression */
  generatedAs?: string;
}

// ============================================================================
// Index Types
// ============================================================================

/** Bitmap index for low/medium cardinality columns */
export interface BitmapIndex {
  type: "BITMAP";
  name: string;
  column: string;
  comment?: string;
}

/** Bloom filter index for high cardinality columns with equality/IN queries */
export interface BloomFilterIndex {
  type: "BLOOM_FILTER";
  columns: string[];
}

/** Tokenizer types for inverted (GIN) indexes */
export type TokenizerType = "none" | "english" | "chinese" | "standard";

/** Inverted (GIN) index for full-text search */
export interface InvertedIndex {
  type: "INVERTED";
  name: string;
  columns: string[];
  tokenizer?: TokenizerType;
  /** Properties like gram_size for n-grams */
  properties?: Record<string, string>;
  comment?: string;
}

/** Vector index type */
export type VectorIndexType = "HNSW" | "IVFPQ";

/** HNSW vector index parameters */
export interface HNSWParams {
  M?: number; // Max connections per node (default 16)
  efConstruction?: number; // Construction-time search breadth (default 40)
}

/** IVFPQ vector index parameters */
export interface IVFPQParams {
  nlist?: number; // Number of cluster centers
  nbits?: number; // Bits per sub-quantizer (default 8)
  nprobe?: number; // Clusters to search at query time
}

/** Vector index for approximate nearest neighbor search */
export interface VectorIndex {
  type: "VECTOR";
  name: string;
  column: string;
  indexType: VectorIndexType;
  metric: "L2_DISTANCE" | "COSINE_SIMILARITY";
  dimension: number;
  params?: HNSWParams | IVFPQParams;
  comment?: string;
}

export type IndexDef = BitmapIndex | BloomFilterIndex | InvertedIndex | VectorIndex;

// ============================================================================
// Partitioning
// ============================================================================

/** Range partition definition */
export interface RangePartition {
  name: string;
  /** Less than value: PARTITION p1 VALUES LESS THAN ("2024-01-01") */
  lessThan?: string | string[];
  /** Fixed range: PARTITION p1 VALUES [("2024-01-01"), ("2024-02-01")) */
  range?: [string | string[], string | string[]];
}

/** List partition definition */
export interface ListPartition {
  name: string;
  values: string | string[];
}

/** Expression partitioning (automatic) */
export interface ExpressionPartition {
  type: "EXPRESSION";
  /** Time functions: date_trunc, time_slice */
  expression: string;
  /** For dynamic partitions */
  start?: string;
  end?: string;
  interval?: string;
}

/** Range partitioning */
export interface RangePartitionConfig {
  type: "RANGE";
  columns: string[];
  partitions?: RangePartition[];
  /** Dynamic partition properties */
  dynamic?: {
    enable: boolean;
    timeUnit: "DAY" | "WEEK" | "MONTH" | "YEAR";
    start: number;
    end: number;
    prefix: string;
  };
}

/** List partitioning */
export interface ListPartitionConfig {
  type: "LIST";
  columns: string[];
  partitions?: ListPartition[];
}

export type PartitionConfig = ExpressionPartition | RangePartitionConfig | ListPartitionConfig;

// ============================================================================
// Distribution
// ============================================================================

export interface HashDistribution {
  type: "HASH";
  columns: string[];
  buckets?: number;
}

export interface RandomDistribution {
  type: "RANDOM";
  buckets?: number;
}

export type DistributionConfig = HashDistribution | RandomDistribution;

// ============================================================================
// Table Properties
// ============================================================================

/** Common StarRocks table properties */
export interface TableProperties {
  /** Number of replicas (default 3 for production) */
  replication_num?: number;
  /** Enable persistent index for PRIMARY KEY tables */
  enable_persistent_index?: boolean;
  /** Persistent index type: LOCAL or CLOUD_NATIVE */
  persistent_index_type?: "LOCAL" | "CLOUD_NATIVE";
  /** Storage type: column (default), column_with_row (hybrid) */
  storage_type?: "column" | "column_with_row";
  /** Bloom filter columns */
  bloom_filter_columns?: string[];
  /** Colocate with another table group */
  colocate_with?: string;
  /** Storage medium: SSD or HDD */
  storage_medium?: "SSD" | "HDD";
  /** Data compression: LZ4, ZSTD, ZLIB, SNAPPY */
  compression?: "LZ4" | "ZSTD" | "ZLIB" | "SNAPPY";
  /** Fast schema evolution */
  fast_schema_evolution?: boolean;
  /** Custom properties */
  [key: string]: unknown;
}

// ============================================================================
// Table Options
// ============================================================================

export interface TableOptions {
  /** Table key type */
  keyType: KeyType;
  /** Key columns */
  keys: string[];
  /** Sort key columns (defaults to key columns if not specified) */
  orderBy?: string[];
  /** Distribution configuration */
  distribution: DistributionConfig;
  /** Partition configuration */
  partition?: PartitionConfig;
  /** Table properties */
  properties?: TableProperties;
  /** Table comment */
  comment?: string;
  /** Indexes to create with table */
  indexes?: IndexDef[];
}

// Legacy compatibility - deprecated
/** @deprecated Use TableOptions with distribution config instead */
export interface LegacyTableOptions {
  keyType: KeyType;
  keys: string[];
  distributedBy: string[];
  buckets?: number;
  partitionBy?: {
    column: string;
    type: "RANGE" | "LIST";
    partitions?: Array<{
      name: string;
      values: string | string[];
    }>;
  };
  properties?: Record<string, string>;
  comment?: string;
}

// ============================================================================
// Load Job Info
// ============================================================================

/** Information about a load job from information_schema.loads */
export interface LoadJobInfo {
  jobId: string;
  label: string;
  databaseName: string;
  state: string;
  progress: string;
  type: string;
  priority: string;
  scanRows: number;
  filteredRows: number;
  unselectedRows: number;
  sinkRows: number;
  etlInfo?: string;
  taskInfo?: string;
  createTime: string;
  etlStartTime?: string;
  etlFinishTime?: string;
  loadStartTime?: string;
  loadFinishTime?: string;
  jobDetails?: string;
  errorMsg?: string;
  trackingUrl?: string;
  trackingSql?: string;
}

// ============================================================================
// Schema Introspection Types
// ============================================================================

/** Column information from DESC table */
export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  isKey: boolean;
  defaultValue?: string;
  extra?: string;
}

/** Partition information from SHOW PARTITIONS */
export interface PartitionInfo {
  partitionId: string;
  partitionName: string;
  visibleVersion: number;
  visibleVersionTime?: string;
  state: string;
  partitionKey?: string;
  range?: string;
  distributionKey?: string;
  buckets: number;
  replicationNum: number;
  storageMedium?: string;
  dataSize?: string;
  rowCount: number;
}

/** Table statistics */
export interface TableStats {
  tableName: string;
  rowCount: number;
  partitionCount: number;
  totalBuckets: number;
}

/** Table info from SHOW FULL TABLES */
export interface TableInfo {
  name: string;
  type: string;
}
