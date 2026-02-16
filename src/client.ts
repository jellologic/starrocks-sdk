import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import type {
  StarRocksConfig,
  TableOptions,
  LegacyTableOptions,
  ColumnDef,
  DataType,
  IndexDef,
  BitmapIndex,
  BloomFilterIndex,
  InvertedIndex,
  VectorIndex,
  PartitionConfig,
  DistributionConfig,
  TableProperties,
  LoadJobInfo,
  ColumnInfo,
  PartitionInfo,
  TableStats,
  TableInfo,
} from "./types";
import { MaterializedViewManager } from "./materialized-views";
import { StreamLoadClient, type StreamLoadConfig } from "./stream-load";

export class StarRocksClient {
  private pool: mysql.Pool;
  private _db: MySql2Database;
  private config: StarRocksConfig;

  constructor(config: StarRocksConfig) {
    this.config = config;
    this.pool = mysql.createPool({
      host: config.host,
      port: config.mysqlPort,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      // Network resilience settings
      connectTimeout: 30000, // 30 seconds for initial connection (for cloud environments)
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });

    this._db = drizzle({ client: this.pool });
  }

  get db(): MySql2Database {
    return this._db;
  }

  /**
   * Get a MaterializedViewManager for managing async materialized views
   */
  get materializedViews(): MaterializedViewManager {
    return new MaterializedViewManager(
      (sql) => this.execute(sql),
      (sql) => this.raw(sql)
    );
  }

  /**
   * Create a StreamLoadClient for bulk HTTP-based data loading
   */
  createStreamLoader(): StreamLoadClient {
    const config: StreamLoadConfig = {
      host: this.config.host,
      httpPort: this.config.httpPort,
      user: this.config.user,
      password: this.config.password,
    };
    return new StreamLoadClient(config);
  }

  async raw<T = unknown>(sql: string): Promise<T[]> {
    // Use query instead of execute - StarRocks doesn't support prepared statements for many commands
    const [rows] = await this.pool.query(sql);
    return rows as T[];
  }

  async execute(sql: string): Promise<void> {
    // Use query instead of execute - StarRocks doesn't support prepared statements for DDL
    await this.pool.query(sql);
  }

  // ============================================================================
  // Database Operations
  // ============================================================================

  async createDatabase(name: string, ifNotExists = true): Promise<void> {
    const clause = ifNotExists ? "IF NOT EXISTS" : "";
    await this.execute(`CREATE DATABASE ${clause} ${name}`);
  }

  async dropDatabase(name: string, ifExists = true): Promise<void> {
    const clause = ifExists ? "IF EXISTS" : "";
    await this.execute(`DROP DATABASE ${clause} ${name}`);
  }

  async useDatabase(name: string): Promise<void> {
    await this.execute(`USE ${name}`);
  }

  async showDatabases(): Promise<string[]> {
    const rows = await this.raw<{ Database: string }>("SHOW DATABASES");
    return rows.map((r) => r.Database);
  }

  // ============================================================================
  // Table Operations
  // ============================================================================

  async createTable(
    tableName: string,
    columns: ColumnDef[],
    options: TableOptions | LegacyTableOptions,
    ifNotExists = true
  ): Promise<void> {
    // Handle legacy options format
    if ("distributedBy" in options) {
      return this.createTableLegacy(tableName, columns, options, ifNotExists);
    }

    const columnDefs = columns.map((col) => this.formatColumnDef(col));
    const existsClause = ifNotExists ? "IF NOT EXISTS" : "";

    let sql = `CREATE TABLE ${existsClause} ${tableName} (\n  ${columnDefs.join(",\n  ")}\n)`;

    // Key type and keys
    sql += `\n${options.keyType} KEY(${options.keys.join(", ")})`;

    // Sort key (ORDER BY) - only if different from keys
    // Note: In StarRocks, ORDER BY comes after distribution for some versions
    // We'll place it before DISTRIBUTED which is the standard format
    if (options.orderBy && options.orderBy.length > 0) {
      sql += `\nORDER BY (${options.orderBy.join(", ")})`;
    }

    // Partitioning
    if (options.partition) {
      sql += this.formatPartition(options.partition);
    }

    // Distribution
    sql += this.formatDistribution(options.distribution);

    // Properties
    if (options.properties) {
      sql += this.formatProperties(options.properties);
    }

    // Comment
    if (options.comment) {
      sql += `\nCOMMENT '${options.comment}'`;
    }

    await this.execute(sql);

    // Create indexes after table creation
    if (options.indexes) {
      for (const index of options.indexes) {
        await this.createIndex(tableName, index);
      }
    }
  }

  /** @deprecated Use createTable with new TableOptions format */
  private async createTableLegacy(
    tableName: string,
    columns: ColumnDef[],
    options: LegacyTableOptions,
    ifNotExists = true
  ): Promise<void> {
    const columnDefs = columns.map((col) => this.formatColumnDef(col));
    const existsClause = ifNotExists ? "IF NOT EXISTS" : "";

    let sql = `CREATE TABLE ${existsClause} ${tableName} (\n  ${columnDefs.join(",\n  ")}\n)`;
    sql += `\n${options.keyType} KEY(${options.keys.join(", ")})`;

    if (options.partitionBy) {
      sql += `\nPARTITION BY ${options.partitionBy.type}(${options.partitionBy.column})`;
      if (options.partitionBy.partitions?.length) {
        const partDefs = options.partitionBy.partitions.map((p) => {
          const vals = Array.isArray(p.values) ? p.values.join(", ") : p.values;
          return `PARTITION ${p.name} VALUES ${options.partitionBy!.type === "RANGE" ? `[${vals})` : `IN (${vals})`}`;
        });
        sql += ` (\n  ${partDefs.join(",\n  ")}\n)`;
      }
    }

    sql += `\nDISTRIBUTED BY HASH(${options.distributedBy.join(", ")})`;
    if (options.buckets) sql += ` BUCKETS ${options.buckets}`;

    if (options.properties && Object.keys(options.properties).length > 0) {
      const props = Object.entries(options.properties)
        .map(([k, v]) => `"${k}" = "${v}"`)
        .join(",\n  ");
      sql += `\nPROPERTIES (\n  ${props}\n)`;
    }

    if (options.comment) {
      sql += `\nCOMMENT '${options.comment}'`;
    }

    await this.execute(sql);
  }

  async dropTable(tableName: string, ifExists = true): Promise<void> {
    const clause = ifExists ? "IF EXISTS" : "";
    await this.execute(`DROP TABLE ${clause} ${tableName}`);
  }

  async showTables(database?: string): Promise<string[]> {
    const sql = database ? `SHOW TABLES FROM ${database}` : "SHOW TABLES";
    const rows = await this.raw<Record<string, string>>(sql);
    return rows.map((r) => Object.values(r)[0]).filter((v): v is string => v !== undefined);
  }

  async describeTable(tableName: string): Promise<unknown[]> {
    return this.raw(`DESC ${tableName}`);
  }

  async getTableSchema(tableName: string): Promise<string> {
    const rows = await this.raw<{ "Create Table": string }>(`SHOW CREATE TABLE ${tableName}`);
    return rows[0]?.["Create Table"] ?? "";
  }

  // ============================================================================
  // Index Operations
  // ============================================================================

  /**
   * Create an index on a table
   */
  async createIndex(tableName: string, index: IndexDef): Promise<void> {
    switch (index.type) {
      case "BITMAP":
        await this.createBitmapIndex(tableName, index);
        break;
      case "BLOOM_FILTER":
        await this.createBloomFilterIndex(tableName, index);
        break;
      case "INVERTED":
        await this.createInvertedIndex(tableName, index);
        break;
      case "VECTOR":
        await this.createVectorIndex(tableName, index);
        break;
    }
  }

  /**
   * Create a bitmap index for low/medium cardinality columns
   */
  async createBitmapIndex(tableName: string, index: BitmapIndex): Promise<void> {
    let sql = `CREATE INDEX ${index.name} ON ${tableName} (${index.column}) USING BITMAP`;
    if (index.comment) {
      sql += ` COMMENT '${index.comment}'`;
    }
    await this.execute(sql);
  }

  /**
   * Create bloom filter index via table properties ALTER
   * Note: Bloom filter is set via table properties, not CREATE INDEX
   */
  async createBloomFilterIndex(tableName: string, index: BloomFilterIndex): Promise<void> {
    const sql = `ALTER TABLE ${tableName} SET ("bloom_filter_columns" = "${index.columns.join(",")}")`;
    await this.execute(sql);
  }

  /**
   * Create an inverted (GIN) index for full-text search
   * Note: GIN index in StarRocks doesn't support PROPERTIES clause in CREATE INDEX
   */
  async createInvertedIndex(tableName: string, index: InvertedIndex): Promise<void> {
    let sql = `CREATE INDEX ${index.name} ON ${tableName} (${index.columns.join(", ")}) USING GIN`;

    if (index.comment) {
      sql += ` COMMENT '${index.comment}'`;
    }

    await this.execute(sql);
  }

  /**
   * Create a vector index for approximate nearest neighbor search
   */
  async createVectorIndex(tableName: string, index: VectorIndex): Promise<void> {
    const props: string[] = [
      `"index_type" = "${index.indexType}"`,
      `"dim" = "${index.dimension}"`,
      `"metric_type" = "${index.metric}"`,
    ];

    // Add algorithm-specific parameters
    if (index.params) {
      if (index.indexType === "HNSW") {
        const p = index.params as { M?: number; efConstruction?: number };
        if (p.M !== undefined) props.push(`"M" = "${p.M}"`);
        if (p.efConstruction !== undefined) props.push(`"efconstruction" = "${p.efConstruction}"`);
      } else if (index.indexType === "IVFPQ") {
        const p = index.params as { nlist?: number; nbits?: number; nprobe?: number };
        if (p.nlist !== undefined) props.push(`"nlist" = "${p.nlist}"`);
        if (p.nbits !== undefined) props.push(`"nbits" = "${p.nbits}"`);
      }
    }

    let sql = `CREATE INDEX ${index.name} ON ${tableName} (${index.column}) USING VECTOR (${props.join(", ")})`;

    if (index.comment) {
      sql += ` COMMENT '${index.comment}'`;
    }

    await this.execute(sql);
  }

  /**
   * Drop an index from a table
   */
  async dropIndex(tableName: string, indexName: string): Promise<void> {
    await this.execute(`DROP INDEX ${indexName} ON ${tableName}`);
  }

  /**
   * Show indexes on a table
   */
  async showIndexes(tableName: string): Promise<unknown[]> {
    return this.raw(`SHOW INDEX FROM ${tableName}`);
  }

  // ============================================================================
  // Insert Operations
  // ============================================================================

  /**
   * Insert a single row into a table
   */
  async insert(
    tableName: string,
    data: Record<string, unknown>,
    options?: { label?: string }
  ): Promise<void> {
    const columns = Object.keys(data);
    const values = Object.values(data).map((v) => this.formatValue(v));

    let sql = `INSERT INTO ${tableName}`;
    if (options?.label) {
      sql += `\nWITH LABEL ${options.label}`;
    }
    sql += ` (${columns.join(", ")}) VALUES (${values.join(", ")})`;

    await this.execute(sql);
  }

  /**
   * Insert multiple rows into a table
   */
  async insertMany(
    tableName: string,
    data: Record<string, unknown>[],
    options?: { label?: string; batchSize?: number }
  ): Promise<void> {
    if (data.length === 0) return;

    const columns = Object.keys(data[0]!);
    const batchSize = options?.batchSize ?? 1000;

    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      const valuesList = batch
        .map((row) => {
          const values = columns.map((col) => this.formatValue(row[col]));
          return `(${values.join(", ")})`;
        })
        .join(",\n");

      let sql = `INSERT INTO ${tableName}`;
      if (options?.label) {
        sql += `\nWITH LABEL ${options.label}_${i}`;
      }
      sql += ` (${columns.join(", ")}) VALUES\n${valuesList}`;

      await this.execute(sql);
    }
  }

  /**
   * Insert data from a SELECT query
   */
  async insertSelect(
    tableName: string,
    selectQuery: string,
    options?: { label?: string; columns?: string[]; partitions?: string[] }
  ): Promise<void> {
    let sql = `INSERT INTO ${tableName}`;

    if (options?.partitions?.length) {
      sql += ` PARTITION(${options.partitions.join(", ")})`;
    }

    if (options?.label) {
      sql += `\nWITH LABEL ${options.label}`;
    }

    if (options?.columns?.length) {
      sql += ` (${options.columns.join(", ")})`;
    }

    sql += `\n${selectQuery}`;

    await this.execute(sql);
  }

  /**
   * Overwrite table data with INSERT OVERWRITE
   */
  async insertOverwrite(
    tableName: string,
    selectQuery: string,
    options?: { partitions?: string[]; dynamicOverwrite?: boolean }
  ): Promise<void> {
    let sql = "";

    if (options?.dynamicOverwrite) {
      sql = `INSERT /*+set_var(dynamic_overwrite = true)*/ OVERWRITE ${tableName}`;
    } else {
      sql = `INSERT OVERWRITE ${tableName}`;
    }

    if (options?.partitions?.length) {
      sql += ` PARTITION(${options.partitions.join(", ")})`;
    }

    sql += `\n${selectQuery}`;

    await this.execute(sql);
  }

  // ============================================================================
  // Load Job Management
  // ============================================================================

  /**
   * Query load job status from information_schema.loads
   */
  async getLoadJobs(options?: {
    database?: string;
    label?: string;
    state?: "PENDING" | "ETL" | "LOADING" | "FINISHED" | "CANCELLED";
    limit?: number;
  }): Promise<LoadJobInfo[]> {
    let sql = "SELECT * FROM information_schema.loads WHERE 1=1";

    if (options?.database) {
      // Column is DB_NAME in StarRocks 4.x
      sql += ` AND DB_NAME = '${options.database}'`;
    }
    if (options?.label) {
      sql += ` AND LABEL = '${options.label}'`;
    }
    if (options?.state) {
      sql += ` AND STATE = '${options.state}'`;
    }

    sql += " ORDER BY CREATE_TIME DESC";

    if (options?.limit) {
      sql += ` LIMIT ${options.limit}`;
    }

    const rows = await this.raw<Record<string, unknown>>(sql);

    return rows.map((row) => ({
      jobId: String(row.JOB_ID ?? row.ID ?? ""),
      label: String(row.LABEL ?? ""),
      databaseName: String(row.DB_NAME ?? ""),
      state: String(row.STATE ?? ""),
      progress: String(row.PROGRESS ?? ""),
      type: String(row.TYPE ?? ""),
      priority: String(row.PRIORITY ?? ""),
      scanRows: Number(row.SCAN_ROWS ?? 0),
      filteredRows: Number(row.FILTERED_ROWS ?? 0),
      unselectedRows: Number(row.UNSELECTED_ROWS ?? 0),
      sinkRows: Number(row.SINK_ROWS ?? 0),
      etlInfo: undefined, // Not available in StarRocks 4.x
      taskInfo: undefined, // Not available in StarRocks 4.x
      createTime: String(row.CREATE_TIME ?? ""),
      etlStartTime: undefined, // Not available in StarRocks 4.x
      etlFinishTime: undefined, // Not available in StarRocks 4.x
      loadStartTime: (row.LOAD_START_TIME) as string | undefined,
      loadFinishTime: (row.LOAD_FINISH_TIME) as string | undefined,
      jobDetails: row.RUNTIME_DETAILS ? JSON.stringify(row.RUNTIME_DETAILS) : undefined,
      errorMsg: (row.ERROR_MSG) as string | undefined,
      trackingUrl: undefined, // Not available in StarRocks 4.x
      trackingSql: (row.TRACKING_SQL) as string | undefined,
    }));
  }

  /**
   * Cancel a load job by label
   */
  async cancelLoad(database: string, label: string): Promise<void> {
    await this.execute(`CANCEL LOAD FROM ${database} WHERE LABEL = "${label}"`);
  }

  // ============================================================================
  // Schema Introspection
  // ============================================================================

  /**
   * Get detailed column information for a table
   */
  async getColumns(tableName: string): Promise<ColumnInfo[]> {
    const rows = await this.raw<Record<string, unknown>>(`DESC ${tableName}`);

    return rows.map((row) => ({
      name: String(row.Field ?? row.field ?? ""),
      type: String(row.Type ?? row.type ?? ""),
      nullable: String(row.Null ?? row.null ?? "YES") === "YES",
      isKey: String(row.Key ?? row.key ?? "") === "true",
      defaultValue: (row.Default ?? row.default) as string | undefined,
      extra: (row.Extra ?? row.extra) as string | undefined,
    }));
  }

  /**
   * Get partition information for a table
   */
  async getPartitions(tableName: string): Promise<PartitionInfo[]> {
    const rows = await this.raw<Record<string, unknown>>(
      `SHOW PARTITIONS FROM ${tableName}`
    );

    return rows.map((row) => ({
      partitionId: String(row.PartitionId ?? row.partition_id ?? ""),
      partitionName: String(row.PartitionName ?? row.partition_name ?? ""),
      visibleVersion: Number(row.VisibleVersion ?? row.visible_version ?? 0),
      visibleVersionTime: (row.VisibleVersionTime ?? row.visible_version_time) as string | undefined,
      state: String(row.State ?? row.state ?? ""),
      partitionKey: (row.PartitionKey ?? row.partition_key) as string | undefined,
      range: (row.Range ?? row.range) as string | undefined,
      distributionKey: (row.DistributionKey ?? row.distribution_key) as string | undefined,
      buckets: Number(row.Buckets ?? row.buckets ?? 0),
      replicationNum: Number(row.ReplicationNum ?? row.replication_num ?? 0),
      storageMedium: (row.StorageMedium ?? row.storage_medium) as string | undefined,
      dataSize: (row.DataSize ?? row.data_size) as string | undefined,
      rowCount: Number(row.RowCount ?? row.row_count ?? 0),
    }));
  }

  /**
   * Get table statistics
   */
  async getTableStats(tableName: string): Promise<TableStats> {
    // Get row count
    const countResult = await this.raw<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM ${tableName}`
    );
    const rowCount = countResult[0]?.cnt ?? 0;

    // Get data size from partitions
    const partitions = await this.getPartitions(tableName).catch(() => []);
    const totalRows = partitions.reduce((sum, p) => sum + p.rowCount, 0);
    const totalBuckets = partitions.reduce((sum, p) => sum + p.buckets, 0);

    return {
      tableName,
      rowCount: rowCount || totalRows,
      partitionCount: partitions.length,
      totalBuckets,
    };
  }

  /**
   * Get all tables with their types
   */
  async getTableInfos(database?: string): Promise<TableInfo[]> {
    const sql = database
      ? `SHOW FULL TABLES FROM ${database}`
      : "SHOW FULL TABLES";
    const rows = await this.raw<Record<string, unknown>>(sql);

    return rows.map((row) => {
      const values = Object.values(row);
      return {
        name: String(values[0] ?? ""),
        type: String(values[1] ?? "BASE TABLE"),
      };
    });
  }

  /**
   * Check if a table exists
   */
  async tableExists(tableName: string, database?: string): Promise<boolean> {
    const tables = await this.showTables(database);
    return tables.includes(tableName);
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Format a value for SQL insertion
   */
  private formatValue(value: unknown): string {
    if (value === null || value === undefined) {
      return "NULL";
    }
    if (typeof value === "string") {
      // Escape single quotes
      return `'${value.replace(/'/g, "''")}'`;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      return String(value);
    }
    if (typeof value === "boolean") {
      return value ? "TRUE" : "FALSE";
    }
    if (value instanceof Date) {
      return `'${value.toISOString().slice(0, 19).replace("T", " ")}'`;
    }
    if (Array.isArray(value)) {
      return `[${value.map((v) => this.formatValue(v)).join(", ")}]`;
    }
    if (typeof value === "object") {
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    }
    return String(value);
  }

  /**
   * Format a column definition for CREATE TABLE
   */
  private formatColumnDef(col: ColumnDef): string {
    let def = `${col.name} ${this.formatDataType(col.type, col)}`;

    if (col.nullable === false) def += " NOT NULL";
    if (col.autoIncrement) def += " AUTO_INCREMENT";
    if (col.defaultValue !== undefined) def += ` DEFAULT ${col.defaultValue}`;
    if (col.generatedAs) def += ` AS ${col.generatedAs}`;
    if (col.aggregateType) def += ` ${col.aggregateType}`;
    if (col.comment) def += ` COMMENT '${col.comment}'`;

    return def;
  }

  /**
   * Format a data type for SQL
   */
  private formatDataType(type: DataType, col?: ColumnDef): string {
    // Handle basic string types
    if (typeof type === "string") {
      switch (type) {
        case "VARCHAR":
        case "CHAR":
        case "VARBINARY":
          return `${type}(${col?.length ?? 255})`;
        case "DECIMAL":
          return `${type}(${col?.precision ?? 10}, ${col?.scale ?? 2})`;
        default:
          return type;
      }
    }

    // Handle complex types
    switch (type.type) {
      case "ARRAY":
        return `ARRAY<${this.formatDataType(type.elementType)}>`;
      case "MAP":
        return `MAP<${this.formatDataType(type.keyType)}, ${this.formatDataType(type.valueType)}>`;
      case "STRUCT": {
        const fields = type.fields.map((f) => `${f.name} ${this.formatDataType(f.type)}`).join(", ");
        return `STRUCT<${fields}>`;
      }
      case "VECTOR":
        return `ARRAY<FLOAT>`;  // Vector is stored as ARRAY<FLOAT> in StarRocks
      default:
        return "VARCHAR(255)";
    }
  }

  /**
   * Format partition configuration for CREATE TABLE
   */
  private formatPartition(partition: PartitionConfig): string {
    let sql = "";

    switch (partition.type) {
      case "EXPRESSION":
        sql = `\nPARTITION BY (${partition.expression})`;
        break;

      case "RANGE":
        sql = `\nPARTITION BY RANGE(${partition.columns.join(", ")})`;
        if (partition.partitions?.length) {
          const partDefs = partition.partitions.map((p) => {
            if (p.lessThan !== undefined) {
              const val = Array.isArray(p.lessThan)
                ? p.lessThan.map((v) => `"${v}"`).join(", ")
                : `"${p.lessThan}"`;
              return `PARTITION ${p.name} VALUES LESS THAN (${val})`;
            } else if (p.range) {
              const start = Array.isArray(p.range[0])
                ? p.range[0].map((v) => `"${v}"`).join(", ")
                : `"${p.range[0]}"`;
              const end = Array.isArray(p.range[1])
                ? p.range[1].map((v) => `"${v}"`).join(", ")
                : `"${p.range[1]}"`;
              return `PARTITION ${p.name} VALUES [(${start}), (${end}))`;
            }
            return "";
          });
          sql += ` (\n  ${partDefs.join(",\n  ")}\n)`;
        }
        break;

      case "LIST":
        sql = `\nPARTITION BY LIST(${partition.columns.join(", ")})`;
        if (partition.partitions?.length) {
          const partDefs = partition.partitions.map((p) => {
            const vals = Array.isArray(p.values)
              ? p.values.map((v) => `"${v}"`).join(", ")
              : `"${p.values}"`;
            return `PARTITION ${p.name} VALUES IN (${vals})`;
          });
          sql += ` (\n  ${partDefs.join(",\n  ")}\n)`;
        }
        break;
    }

    return sql;
  }

  /**
   * Format distribution configuration for CREATE TABLE
   */
  private formatDistribution(distribution: DistributionConfig): string {
    let sql = "";

    switch (distribution.type) {
      case "HASH":
        sql = `\nDISTRIBUTED BY HASH(${distribution.columns.join(", ")})`;
        if (distribution.buckets) sql += ` BUCKETS ${distribution.buckets}`;
        break;
      case "RANDOM":
        sql = "\nDISTRIBUTED BY RANDOM";
        if (distribution.buckets) sql += ` BUCKETS ${distribution.buckets}`;
        break;
    }

    return sql;
  }

  /**
   * Format table properties for CREATE TABLE
   */
  private formatProperties(properties: TableProperties): string {
    const props: string[] = [];

    // Handle known properties with proper formatting
    if (properties.replication_num !== undefined) {
      props.push(`"replication_num" = "${properties.replication_num}"`);
    }
    if (properties.enable_persistent_index !== undefined) {
      props.push(`"enable_persistent_index" = "${properties.enable_persistent_index}"`);
    }
    if (properties.persistent_index_type !== undefined) {
      props.push(`"persistent_index_type" = "${properties.persistent_index_type}"`);
    }
    if (properties.storage_type !== undefined) {
      props.push(`"storage_type" = "${properties.storage_type}"`);
    }
    if (properties.bloom_filter_columns !== undefined) {
      props.push(`"bloom_filter_columns" = "${properties.bloom_filter_columns.join(",")}"`);
    }
    if (properties.colocate_with !== undefined) {
      props.push(`"colocate_with" = "${properties.colocate_with}"`);
    }
    if (properties.storage_medium !== undefined) {
      props.push(`"storage_medium" = "${properties.storage_medium}"`);
    }
    if (properties.compression !== undefined) {
      props.push(`"compression" = "${properties.compression}"`);
    }
    if (properties.fast_schema_evolution !== undefined) {
      props.push(`"fast_schema_evolution" = "${properties.fast_schema_evolution}"`);
    }

    // Handle any custom properties
    for (const [key, value] of Object.entries(properties)) {
      const knownKeys = [
        "replication_num",
        "enable_persistent_index",
        "persistent_index_type",
        "storage_type",
        "bloom_filter_columns",
        "colocate_with",
        "storage_medium",
        "compression",
        "fast_schema_evolution",
      ];
      if (!knownKeys.includes(key) && value !== undefined) {
        props.push(`"${key}" = "${value}"`);
      }
    }

    if (props.length === 0) return "";
    return `\nPROPERTIES (\n  ${props.join(",\n  ")}\n)`;
  }
}

export function createStarRocksClient(config: StarRocksConfig): StarRocksClient {
  return new StarRocksClient(config);
}
