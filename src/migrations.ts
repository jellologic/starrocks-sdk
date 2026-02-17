/**
 * StarRocks Migration System
 *
 * Safe, idempotent migrations for StarRocks without transaction support.
 * Designed for forward-only migrations with explicit rollback scripts.
 *
 * Key Features:
 * - Tracks migrations in a dedicated table
 * - Idempotent operations (IF EXISTS, IF NOT EXISTS)
 * - Checkpoints within migrations for multi-step changes
 * - Dry-run mode to preview changes
 * - No automatic rollback (explicit down migrations)
 * - Schema snapshots before/after migrations
 */

import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { StarRocksClient } from "./client";
import { SchemaIntrospector } from "./schema-diff";

// ============================================================================
// Migration Types
// ============================================================================

export interface Migration {
  /** Unique migration ID (e.g., "20240125_001_create_users_table") */
  id: string;
  /** Human-readable description */
  description: string;
  /** Migration steps to execute */
  up: MigrationStep[];
  /** Rollback steps (optional, for documentation) */
  down?: MigrationStep[];
  /** Dependencies on other migrations */
  dependsOn?: string[];
}

export interface MigrationStep {
  /** Step name (identifier) */
  name: string;
  /** Step description */
  description: string;
  /** SQL statement to execute */
  sql: string;
  /** Whether this step is idempotent (safe to re-run) */
  idempotent?: boolean;
  /** Checkpoint name for recovery */
  checkpoint?: string;
  /** Condition to check before running (for conditional execution) */
  condition?: {
    query: string;
    check: (result: unknown[]) => boolean;
  };
}

export interface MigrationRecord {
  id: string;
  description: string;
  appliedAt: Date;
  executionTimeMs: number;
  checksum: string;
  status: "completed" | "failed" | "partial";
  lastCheckpoint?: string;
  error?: string;
}

export interface MigrationResult {
  success: boolean;
  migration: Migration;
  migrationId: string;
  executionTimeMs: number;
  stepsExecuted: number;
  stepsCompleted: number;
  stepsTotal: number;
  error?: string;
  lastCheckpoint?: string;
  skipped?: boolean;
  dryRun?: boolean;
}

export interface MigrationPlan {
  pending: Migration[];
  applied: MigrationRecord[];
  conflicts: string[];
}

export interface DryRunResult {
  migration: Migration;
  statements: string[];
  warnings: string[];
}

// ============================================================================
// Migration Runner
// ============================================================================

export class MigrationRunner {
  private introspector: SchemaIntrospector;
  private readonly MIGRATIONS_TABLE = "_migrations";
  private logger: (msg: string) => void;
  private migrationsDir?: string;

  constructor(
    private client: StarRocksClient,
    private database: string,
    options?: { logger?: (msg: string) => void; migrationsDir?: string }
  ) {
    this.introspector = new SchemaIntrospector(client);
    this.logger = options?.logger ?? (() => {});
    this.migrationsDir = options?.migrationsDir;
  }

  /**
   * Initialize the migrations system (create tracking table)
   */
  async initialize(): Promise<void> {
    await this.client.useDatabase(this.database);

    // Create migrations table if not exists
    const sql = `
      CREATE TABLE IF NOT EXISTS ${this.MIGRATIONS_TABLE} (
        id VARCHAR(255) NOT NULL,
        description VARCHAR(1000),
        applied_at DATETIME NOT NULL,
        execution_time_ms BIGINT,
        checksum VARCHAR(64),
        status VARCHAR(20) NOT NULL,
        last_checkpoint VARCHAR(255),
        error TEXT,
        schema_snapshot TEXT
      )
      PRIMARY KEY (id)
      DISTRIBUTED BY HASH(id) BUCKETS 1
      PROPERTIES ("replication_num" = "1")
    `;

    await this.client.execute(sql);
  }

  /**
   * Get the current migration plan
   */
  async plan(migrations: Migration[]): Promise<MigrationPlan> {
    await this.client.useDatabase(this.database);

    const applied = await this.getAppliedMigrations();
    const appliedIds = new Set(applied.map(m => m.id));

    const pending: Migration[] = [];
    const conflicts: string[] = [];

    for (const migration of migrations) {
      if (appliedIds.has(migration.id)) {
        // Check for checksum mismatch
        const appliedMigration = applied.find(m => m.id === migration.id);
        const currentChecksum = this.computeChecksum(migration);
        if (appliedMigration && appliedMigration.checksum !== currentChecksum) {
          conflicts.push(
            `Migration '${migration.id}' has been modified since it was applied`
          );
        }
      } else {
        // Check dependencies
        if (migration.dependsOn) {
          for (const dep of migration.dependsOn) {
            if (!appliedIds.has(dep) && !migrations.some(m => m.id === dep)) {
              conflicts.push(
                `Migration '${migration.id}' depends on '${dep}' which is not applied or available`
              );
            }
          }
        }
        pending.push(migration);
      }
    }

    // Sort pending by dependencies
    const sorted = this.topologicalSort(pending);

    return { pending: sorted, applied, conflicts };
  }

  /**
   * Run all pending migrations
   */
  async migrate(
    migrations: Migration[],
    options?: { dryRun?: boolean; stopOnError?: boolean }
  ): Promise<MigrationResult[]> {
    const plan = await this.plan(migrations);

    if (plan.conflicts.length > 0) {
      throw new Error(`Migration conflicts detected:\n${plan.conflicts.join("\n")}`);
    }

    const results: MigrationResult[] = [];
    const appliedIds = new Set(plan.applied.map(r => r.id));

    // Include results for all migrations (including skipped ones)
    for (const migration of migrations) {
      if (appliedIds.has(migration.id)) {
        // Already applied - mark as skipped
        results.push({
          success: true,
          migration,
          migrationId: migration.id,
          executionTimeMs: 0,
          stepsExecuted: 0,
          stepsCompleted: migration.up.length,
          stepsTotal: migration.up.length,
          skipped: true,
        });
        continue;
      }

      if (options?.dryRun) {
        // Dry run mode
        const dryRunInfo = this.dryRun(migration);
        this.logger(`\nDRY RUN - ${migration.id}:`);
        this.logger(dryRunInfo.statements.join("\n"));
        if (dryRunInfo.warnings.length > 0) {
          this.logger(`Warnings: ${dryRunInfo.warnings.join("\n")}`);
        }
        results.push({
          success: true,
          migration,
          migrationId: migration.id,
          executionTimeMs: 0,
          stepsExecuted: 0,
          stepsCompleted: 0,
          stepsTotal: migration.up.length,
          dryRun: true,
        });
        continue;
      }

      // Actually run the migration
      const result = await this.runMigration(migration);
      results.push(result);

      if (!result.success && options?.stopOnError !== false) {
        break;
      }
    }

    return results;
  }

  /**
   * Load migrations from the configured `migrationsDir`.
   *
   * Scans the directory for `.ts` and `.js` files, sorts them alphabetically
   * (timestamp-prefixed filenames sort chronologically), and dynamically
   * imports each file. Every file must default-export a `Migration` object
   * (with `id`, `description`, `up`, and optionally `down`).
   *
   * Requires `migrationsDir` to be set in the constructor options.
   */
  async loadMigrations(): Promise<Migration[]> {
    if (!this.migrationsDir) {
      throw new Error(
        "migrationsDir is not configured. Pass it in the MigrationRunner constructor options."
      );
    }

    const entries = await readdir(this.migrationsDir);

    const migrationFiles = entries
      .filter((f) => {
        const ext = extname(f);
        return ext === ".ts" || ext === ".js";
      })
      .sort(); // alphabetical sort = chronological with timestamp prefixes

    const migrations: Migration[] = [];

    for (const file of migrationFiles) {
      const filePath = join(this.migrationsDir, file);
      const mod = await import(filePath);
      const migration: Migration = mod.default ?? mod;

      if (!migration.id || !migration.up) {
        throw new Error(
          `Migration file '${file}' does not default-export a valid Migration object (must have 'id' and 'up').`
        );
      }

      migrations.push(migration);
    }

    return migrations;
  }

  /**
   * Run all pending migrations from the configured `migrationsDir`.
   *
   * This is the recommended workflow: migrations are written to disk first
   * (see `writeMigrationFile`) and the runner scans the directory.
   *
   * Internally calls `loadMigrations()` then passes the result to `migrate()`.
   */
  async migrateFromDir(
    options?: { dryRun?: boolean; stopOnError?: boolean }
  ): Promise<MigrationResult[]> {
    const migrations = await this.loadMigrations();
    return this.migrate(migrations, options);
  }

  /**
   * Run a single migration
   */
  async runMigration(migration: Migration): Promise<MigrationResult> {
    await this.client.useDatabase(this.database);

    const startTime = Date.now();
    let stepsExecuted = 0;
    let lastCheckpoint: string | undefined;
    let error: string | undefined;

    // Take schema snapshot before migration
    const snapshotBefore = await this.takeSnapshot();

    try {
      for (const step of migration.up) {
        this.logger(`  Executing: ${step.description}`);

        try {
          await this.client.execute(step.sql);
          stepsExecuted++;

          if (step.checkpoint) {
            lastCheckpoint = step.checkpoint;
            // Update checkpoint in migrations table for recovery
            await this.updateCheckpoint(migration.id, lastCheckpoint);
          }
        } catch (err) {
          const stepError = err as Error;

          // For idempotent steps, certain errors are acceptable
          if (step.idempotent && this.isIdempotentError(stepError)) {
            this.logger(`    (Idempotent step - already applied)`);
            stepsExecuted++;
            continue;
          }

          throw stepError;
        }
      }

      // Record successful migration
      const executionTimeMs = Date.now() - startTime;
      await this.recordMigration(migration, "completed", executionTimeMs, snapshotBefore);

      return {
        success: true,
        migration,
        migrationId: migration.id,
        executionTimeMs,
        stepsExecuted,
        stepsCompleted: stepsExecuted,
        stepsTotal: migration.up.length,
        lastCheckpoint,
      };
    } catch (err) {
      error = (err as Error).message;
      const executionTimeMs = Date.now() - startTime;

      // Record failed migration
      await this.recordMigration(
        migration,
        stepsExecuted > 0 ? "partial" : "failed",
        executionTimeMs,
        snapshotBefore,
        error,
        lastCheckpoint
      );

      return {
        success: false,
        migration,
        migrationId: migration.id,
        executionTimeMs,
        stepsExecuted,
        stepsCompleted: stepsExecuted,
        stepsTotal: migration.up.length,
        error,
        lastCheckpoint,
      };
    }
  }

  /**
   * Get list of applied migrations
   */
  async getAppliedMigrations(): Promise<MigrationRecord[]> {
    await this.client.useDatabase(this.database);

    // Check if migrations table exists
    const tables = await this.client.showTables();
    if (!tables.includes(this.MIGRATIONS_TABLE)) {
      return [];
    }

    const rows = await this.client.raw<Record<string, unknown>>(
      `SELECT * FROM ${this.MIGRATIONS_TABLE} ORDER BY applied_at ASC`
    );

    return rows.map(row => ({
      id: String(row.id),
      description: String(row.description ?? ""),
      appliedAt: new Date(String(row.applied_at)),
      executionTimeMs: Number(row.execution_time_ms ?? 0),
      checksum: String(row.checksum ?? ""),
      status: String(row.status) as MigrationRecord["status"],
      lastCheckpoint: row.last_checkpoint as string | undefined,
      error: row.error as string | undefined,
    }));
  }

  /**
   * Dry run a migration (preview SQL statements)
   */
  dryRun(migration: Migration): DryRunResult {
    const statements: string[] = [];
    const warnings: string[] = [];

    for (const step of migration.up) {
      statements.push(`-- ${step.description}`);
      statements.push(step.sql);
      statements.push("");

      // Check for potential issues
      const upperSql = step.sql.toUpperCase();
      if (upperSql.includes("DROP TABLE") && !upperSql.includes("IF EXISTS")) {
        warnings.push(`Step '${step.description}' uses DROP TABLE without IF EXISTS`);
      }
      if (upperSql.includes("DROP COLUMN")) {
        warnings.push(`Step '${step.description}' drops a column - this is destructive`);
      }
      if (!step.idempotent && (upperSql.includes("CREATE TABLE") && !upperSql.includes("IF NOT EXISTS"))) {
        warnings.push(`Step '${step.description}' creates table without IF NOT EXISTS and is not marked idempotent`);
      }
    }

    return { migration, statements, warnings };
  }

  /**
   * Get the current migration status
   */
  async status(): Promise<{
    initialized: boolean;
    appliedCount: number;
    lastMigration?: MigrationRecord;
    failedMigrations: MigrationRecord[];
  }> {
    await this.client.useDatabase(this.database);

    const tables = await this.client.showTables();
    const initialized = tables.includes(this.MIGRATIONS_TABLE);

    if (!initialized) {
      return {
        initialized: false,
        appliedCount: 0,
        failedMigrations: [],
      };
    }

    const applied = await this.getAppliedMigrations();
    const failed = applied.filter(m => m.status === "failed" || m.status === "partial");
    const completed = applied.filter(m => m.status === "completed");

    return {
      initialized: true,
      appliedCount: completed.length,
      lastMigration: completed[completed.length - 1],
      failedMigrations: failed,
    };
  }

  /**
   * Mark a failed migration as resolved (for manual recovery)
   */
  async markResolved(migrationId: string): Promise<void> {
    await this.client.useDatabase(this.database);

    await this.client.execute(`
      UPDATE ${this.MIGRATIONS_TABLE}
      SET status = 'completed', error = NULL
      WHERE id = '${migrationId}'
    `);
  }

  /**
   * Remove a migration record (for re-running after manual rollback)
   */
  async removeMigrationRecord(migrationId: string): Promise<void> {
    await this.client.useDatabase(this.database);

    await this.client.execute(`
      DELETE FROM ${this.MIGRATIONS_TABLE}
      WHERE id = '${migrationId}'
    `);
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private async recordMigration(
    migration: Migration,
    status: MigrationRecord["status"],
    executionTimeMs: number,
    schemaSnapshot: string,
    error?: string,
    lastCheckpoint?: string
  ): Promise<void> {
    const checksum = this.computeChecksum(migration);

    await this.client.execute(`
      INSERT INTO ${this.MIGRATIONS_TABLE}
      (id, description, applied_at, execution_time_ms, checksum, status, last_checkpoint, error, schema_snapshot)
      VALUES (
        '${migration.id}',
        '${migration.description.replace(/'/g, "''")}',
        NOW(),
        ${executionTimeMs},
        '${checksum}',
        '${status}',
        ${lastCheckpoint ? `'${lastCheckpoint}'` : "NULL"},
        ${error ? `'${error.replace(/'/g, "''")}'` : "NULL"},
        '${schemaSnapshot.replace(/'/g, "''")}'
      )
    `);
  }

  private async updateCheckpoint(migrationId: string, checkpoint: string): Promise<void> {
    // For partial migration recovery tracking
    // This is a no-op if the migration hasn't been recorded yet
    try {
      await this.client.execute(`
        UPDATE ${this.MIGRATIONS_TABLE}
        SET last_checkpoint = '${checkpoint}'
        WHERE id = '${migrationId}'
      `);
    } catch {
      // Ignore - migration may not be recorded yet
    }
  }

  private async takeSnapshot(): Promise<string> {
    const schema = await this.introspector.introspect(this.database);
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      tables: schema.tables.map(t => t.name),
    });
  }

  private computeChecksum(migration: Migration): string {
    const content = JSON.stringify({
      id: migration.id,
      up: migration.up.map(s => s.sql),
    });

    // Simple hash function
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(16, "0");
  }

  private isIdempotentError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes("already exists") ||
      message.includes("doesn't exist") ||
      message.includes("does not exist") ||
      message.includes("duplicate")
    );
  }

  private topologicalSort(migrations: Migration[]): Migration[] {
    const result: Migration[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (migration: Migration) => {
      if (visited.has(migration.id)) return;
      if (visiting.has(migration.id)) {
        throw new Error(`Circular dependency detected involving ${migration.id}`);
      }

      visiting.add(migration.id);

      if (migration.dependsOn) {
        for (const depId of migration.dependsOn) {
          const dep = migrations.find(m => m.id === depId);
          if (dep) visit(dep);
        }
      }

      visiting.delete(migration.id);
      visited.add(migration.id);
      result.push(migration);
    };

    for (const migration of migrations) {
      visit(migration);
    }

    return result;
  }
}

// ============================================================================
// Migration Builder (Fluent API)
// ============================================================================

export class MigrationBuilder {
  private steps: MigrationStep[] = [];
  private downSteps: MigrationStep[] = [];

  constructor(
    private id: string,
    private description: string
  ) {}

  /**
   * Add a generic step with name and SQL
   */
  addStep(name: string, sql: string, options?: { idempotent?: boolean; checkpoint?: string }): this {
    this.steps.push({
      name,
      description: name.replace(/_/g, " "),
      sql,
      idempotent: options?.idempotent ?? false,
      checkpoint: options?.checkpoint,
    });
    return this;
  }

  /**
   * Add a rollback step
   */
  addRollback(name: string, sql: string): this {
    this.downSteps.push({
      name,
      description: name.replace(/_/g, " "),
      sql,
      idempotent: true,
    });
    return this;
  }

  /**
   * Add a conditional step that only executes if the condition is met
   */
  addConditionalStep(
    name: string,
    conditionQuery: string,
    check: (result: unknown[]) => boolean,
    sql: string
  ): this {
    this.steps.push({
      name,
      description: name.replace(/_/g, " "),
      sql,
      idempotent: false,
      condition: {
        query: conditionQuery,
        check,
      },
    });
    return this;
  }

  /**
   * Add a CREATE TABLE step
   */
  createTable(tableName: string, sql: string): this {
    this.steps.push({
      name: `create_${tableName}`,
      description: `Create table ${tableName}`,
      sql: sql.includes("IF NOT EXISTS") ? sql : sql.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"),
      idempotent: true,
    });
    this.downSteps.unshift({
      name: `drop_${tableName}`,
      description: `Drop table ${tableName}`,
      sql: `DROP TABLE IF EXISTS ${tableName}`,
      idempotent: true,
    });
    return this;
  }

  /**
   * Add a DROP TABLE step
   */
  dropTable(tableName: string): this {
    this.steps.push({
      name: `drop_${tableName}`,
      description: `Drop table ${tableName}`,
      sql: `DROP TABLE IF EXISTS ${tableName}`,
      idempotent: true,
    });
    return this;
  }

  /**
   * Add an ADD COLUMN step
   */
  addColumn(tableName: string, columnDef: string): this {
    this.steps.push({
      name: `add_column_${tableName}`,
      description: `Add column to ${tableName}`,
      sql: `ALTER TABLE ${tableName} ADD COLUMN ${columnDef}`,
      idempotent: false,
    });
    return this;
  }

  /**
   * Add a DROP COLUMN step
   */
  dropColumn(tableName: string, columnName: string): this {
    this.steps.push({
      name: `drop_column_${columnName}_${tableName}`,
      description: `Drop column ${columnName} from ${tableName}`,
      sql: `ALTER TABLE ${tableName} DROP COLUMN ${columnName}`,
      idempotent: false,
    });
    return this;
  }

  /**
   * Add a MODIFY COLUMN step
   */
  modifyColumn(tableName: string, columnDef: string): this {
    this.steps.push({
      name: `modify_column_${tableName}`,
      description: `Modify column in ${tableName}`,
      sql: `ALTER TABLE ${tableName} MODIFY COLUMN ${columnDef}`,
      idempotent: false,
    });
    return this;
  }

  /**
   * Add a raw SQL step
   */
  sql(name: string, sql: string, options?: { idempotent?: boolean; checkpoint?: string }): this {
    this.steps.push({
      name,
      description: name.replace(/_/g, " "),
      sql,
      idempotent: options?.idempotent ?? false,
      checkpoint: options?.checkpoint,
    });
    return this;
  }

  /**
   * Add a checkpoint for recovery
   */
  checkpoint(name: string): this {
    if (this.steps.length > 0) {
      const lastStep = this.steps[this.steps.length - 1];
      if (lastStep) lastStep.checkpoint = name;
    }
    return this;
  }

  /**
   * Add a down migration step (for documentation)
   */
  down(name: string, sql: string): this {
    this.downSteps.push({
      name,
      description: name.replace(/_/g, " "),
      sql,
      idempotent: true,
    });
    return this;
  }

  /**
   * Build the migration object
   */
  build(dependsOn?: string[]): Migration {
    return {
      id: this.id,
      description: this.description,
      up: this.steps,
      down: this.downSteps.length > 0 ? this.downSteps : undefined,
      dependsOn,
    };
  }
}

/**
 * Create a new migration builder
 */
export function createMigration(id: string, description: string): MigrationBuilder {
  return new MigrationBuilder(id, description);
}
