import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  createStarRocksClient,
  type StarRocksClient,
  MigrationRunner,
  createMigration,
  type Migration,
} from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";

describe("StarRocks Migrations", () => {
  let client: StarRocksClient;
  let migrationRunner: MigrationRunner;
  const MIGRATION_DB = `${TEST_DATABASE}_migrations`;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(MIGRATION_DB);
    await client.useDatabase(MIGRATION_DB);
    migrationRunner = new MigrationRunner(client, MIGRATION_DB);
  });

  afterAll(async () => {
    await client.dropDatabase(MIGRATION_DB);
    await client.close();
  });

  beforeEach(async () => {
    // Ensure clean state - drop migration table if exists
    try {
      await client.raw("DROP TABLE IF EXISTS _migrations");
    } catch {
      // Ignore errors
    }
  });

  describe("MigrationRunner Initialization", () => {
    test("should initialize migrations table", async () => {
      await migrationRunner.initialize();

      // Check if _migrations table exists
      const tableExists = await client.tableExists("_migrations");
      expect(tableExists).toBe(true);
    });

    test("should be idempotent - multiple initializations should not fail", async () => {
      await migrationRunner.initialize();
      await migrationRunner.initialize();
      await migrationRunner.initialize();

      const tableExists = await client.tableExists("_migrations");
      expect(tableExists).toBe(true);
    });

    test("should report empty status initially", async () => {
      await migrationRunner.initialize();

      const status = await migrationRunner.status();

      expect(status.initialized).toBe(true);
      expect(status.appliedCount).toBe(0);
      expect(status.lastMigration).toBeUndefined();
      expect(status.failedMigrations).toHaveLength(0);
    });
  });

  describe("MigrationBuilder", () => {
    test("should create migration with fluent API", () => {
      const migration = createMigration("001_create_users", "Create users table")
        .addStep(
          "create_users_table",
          `CREATE TABLE IF NOT EXISTS users (
            user_id BIGINT NOT NULL,
            username VARCHAR(100)
          ) PRIMARY KEY (user_id)
          DISTRIBUTED BY HASH(user_id) BUCKETS 4
          PROPERTIES ("replication_num" = "1")`
        )
        .addStep("add_index", `CREATE INDEX IF NOT EXISTS idx_username ON users (username)`)
        .build();

      expect(migration.id).toBe("001_create_users");
      expect(migration.description).toBe("Create users table");
      expect(migration.up.length).toBe(2);
      expect(migration.up[0]!.name).toBe("create_users_table");
      expect(migration.up[1]!.name).toBe("add_index");
    });

    test("should support rollback steps", () => {
      const migration = createMigration("002_add_column", "Add email column")
        .addStep("add_email", `ALTER TABLE users ADD COLUMN email VARCHAR(255)`)
        .addRollback("remove_email", `ALTER TABLE users DROP COLUMN email`)
        .build();

      expect(migration.up.length).toBe(1);
      expect(migration.down?.length).toBe(1);
      expect(migration.down?.[0]!.name).toBe("remove_email");
    });

    test("should support conditional steps", () => {
      const migration = createMigration("003_conditional", "Conditional migration")
        .addConditionalStep(
          "maybe_create",
          "SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_name = 'optional'",
          (result: unknown[]) => {
            const rows = result as Array<{ cnt: number }>;
            return rows[0]!.cnt === 0;
          },
          `CREATE TABLE optional (id BIGINT) PRIMARY KEY (id) DISTRIBUTED BY HASH(id) BUCKETS 4 PROPERTIES ("replication_num" = "1")`
        )
        .build();

      expect(migration.up.length).toBe(1);
      expect(migration.up[0]!.condition).toBeDefined();
    });
  });

  describe("Migration Execution", () => {
    test("should run a simple migration", async () => {
      await migrationRunner.initialize();

      const migrations: Migration[] = [
        createMigration("001_create_products", "Create products table")
          .addStep(
            "create_table",
            `CREATE TABLE IF NOT EXISTS products (
              product_id BIGINT NOT NULL,
              name VARCHAR(255)
            ) PRIMARY KEY (product_id)
            DISTRIBUTED BY HASH(product_id) BUCKETS 4
            PROPERTIES ("replication_num" = "1")`
          )
          .build(),
      ];

      const results = await migrationRunner.migrate(migrations);

      expect(results.length).toBe(1);
      expect(results[0]!.migration.id).toBe("001_create_products");
      expect(results[0]!.success).toBe(true);

      // Verify table was created
      const tableExists = await client.tableExists("products");
      expect(tableExists).toBe(true);

      // Clean up
      await client.raw("DROP TABLE IF EXISTS products");
    });

    test("should skip already applied migrations", async () => {
      await migrationRunner.initialize();

      const migrations: Migration[] = [
        createMigration("002_create_categories", "Create categories table")
          .addStep(
            "create_table",
            `CREATE TABLE IF NOT EXISTS categories (
              category_id BIGINT NOT NULL,
              name VARCHAR(100)
            ) PRIMARY KEY (category_id)
            DISTRIBUTED BY HASH(category_id) BUCKETS 4
            PROPERTIES ("replication_num" = "1")`
          )
          .build(),
      ];

      // Run first time
      await migrationRunner.migrate(migrations);

      // Run second time
      const results = await migrationRunner.migrate(migrations);

      // Should be skipped
      expect(results.length).toBe(1);
      expect(results[0]!.skipped).toBe(true);

      // Clean up
      await client.raw("DROP TABLE IF EXISTS categories");
    });

    test("should run multiple migrations in order", async () => {
      await migrationRunner.initialize();

      const migrations: Migration[] = [
        createMigration("003_step_one", "First migration")
          .addStep(
            "create_table",
            `CREATE TABLE IF NOT EXISTS step_one (
              id BIGINT NOT NULL
            ) PRIMARY KEY (id)
            DISTRIBUTED BY HASH(id) BUCKETS 4
            PROPERTIES ("replication_num" = "1")`
          )
          .build(),
        createMigration("004_step_two", "Second migration")
          .addStep(
            "create_table",
            `CREATE TABLE IF NOT EXISTS step_two (
              id BIGINT NOT NULL
            ) PRIMARY KEY (id)
            DISTRIBUTED BY HASH(id) BUCKETS 4
            PROPERTIES ("replication_num" = "1")`
          )
          .build(),
        createMigration("005_step_three", "Third migration")
          .addStep(
            "create_table",
            `CREATE TABLE IF NOT EXISTS step_three (
              id BIGINT NOT NULL
            ) PRIMARY KEY (id)
            DISTRIBUTED BY HASH(id) BUCKETS 4
            PROPERTIES ("replication_num" = "1")`
          )
          .build(),
      ];

      const results = await migrationRunner.migrate(migrations);

      expect(results.length).toBe(3);
      expect(results.filter((r) => r.success).length).toBe(3);

      // Verify all tables were created
      expect(await client.tableExists("step_one")).toBe(true);
      expect(await client.tableExists("step_two")).toBe(true);
      expect(await client.tableExists("step_three")).toBe(true);

      // Check status
      const status = await migrationRunner.status();
      expect(status.appliedCount).toBe(3);
      expect(status.lastMigration?.id).toBe("005_step_three");

      // Clean up
      await client.raw("DROP TABLE IF EXISTS step_one");
      await client.raw("DROP TABLE IF EXISTS step_two");
      await client.raw("DROP TABLE IF EXISTS step_three");
    });

    test("should support dry-run mode", async () => {
      await migrationRunner.initialize();

      const migrations: Migration[] = [
        createMigration("006_dry_run", "Dry run test")
          .addStep(
            "create_table",
            `CREATE TABLE IF NOT EXISTS dry_run_table (
              id BIGINT NOT NULL
            ) PRIMARY KEY (id)
            DISTRIBUTED BY HASH(id) BUCKETS 4
            PROPERTIES ("replication_num" = "1")`
          )
          .build(),
      ];

      const results = await migrationRunner.migrate(migrations, { dryRun: true });

      expect(results.length).toBe(1);
      expect(results[0]!.dryRun).toBe(true);

      // Table should NOT be created
      const tableExists = await client.tableExists("dry_run_table");
      expect(tableExists).toBe(false);
    });
  });

  describe("Migration Planning", () => {
    test("should create migration plan", async () => {
      await migrationRunner.initialize();

      const migrations: Migration[] = [
        createMigration("007_plan_test", "Plan test")
          .addStep("step_a", "SELECT 1")
          .addStep("step_b", "SELECT 2")
          .build(),
      ];

      const plan = await migrationRunner.plan(migrations);

      expect(plan.pending.length).toBe(1);
      expect(plan.pending[0]!.id).toBe("007_plan_test");
      expect(plan.applied.length).toBe(0);
    });

    test("should show applied migrations in plan", async () => {
      await migrationRunner.initialize();

      const migrations: Migration[] = [
        createMigration("008_first", "First")
          .addStep("step", "SELECT 1")
          .build(),
        createMigration("009_second", "Second")
          .addStep("step", "SELECT 1")
          .build(),
      ];

      // Run first migration
      await migrationRunner.migrate([migrations[0]!]);

      // Plan both
      const plan = await migrationRunner.plan(migrations);

      expect(plan.applied.length).toBe(1);
      expect(plan.applied[0]!.id).toBe("008_first");
      expect(plan.pending.length).toBe(1);
      expect(plan.pending[0]!.id).toBe("009_second");
    });
  });

  describe("Migration Status", () => {
    test("should track migration history", async () => {
      await migrationRunner.initialize();

      const migrations: Migration[] = [
        createMigration("010_history", "History test")
          .addStep("step", "SELECT 1")
          .build(),
      ];

      await migrationRunner.migrate(migrations);

      const status = await migrationRunner.status();

      expect(status.initialized).toBe(true);
      expect(status.appliedCount).toBe(1);
      expect(status.lastMigration).toBeDefined();
      expect(status.lastMigration?.id).toBe("010_history");
      expect(status.lastMigration?.status).toBe("completed");
    });

    test("should record failed migration", async () => {
      await migrationRunner.initialize();

      const migrations: Migration[] = [
        createMigration("011_fail", "Will fail")
          .addStep("bad_sql", "THIS IS INVALID SQL SYNTAX @#$%")
          .build(),
      ];

      const results = await migrationRunner.migrate(migrations);

      expect(results.length).toBe(1);
      expect(results[0]!.success).toBe(false);
      expect(results[0]!.error).toBeDefined();
    });
  });

  describe("Multi-step Migrations", () => {
    test("should execute multiple steps in single migration", async () => {
      await migrationRunner.initialize();

      const migrations: Migration[] = [
        createMigration("012_multi_step", "Multi-step migration")
          .addStep(
            "create_table",
            `CREATE TABLE IF NOT EXISTS multi_step_test (
              id BIGINT NOT NULL,
              data VARCHAR(100)
            ) PRIMARY KEY (id)
            DISTRIBUTED BY HASH(id) BUCKETS 4
            PROPERTIES ("replication_num" = "1")`
          )
          .addStep("insert_data", `INSERT INTO multi_step_test VALUES (1, 'test')`)
          .build(),
      ];

      const results = await migrationRunner.migrate(migrations);

      expect(results[0]!.success).toBe(true);
      expect(results[0]!.stepsCompleted).toBe(2);

      // Verify both steps ran
      const rows = await client.raw<{ id: number; data: string }>(
        "SELECT * FROM multi_step_test"
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.data).toBe("test");

      // Clean up
      await client.raw("DROP TABLE IF EXISTS multi_step_test");
    });
  });

  // ============================================================================
  // Battle Tests: Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    describe("Dependency Handling", () => {
      test("should handle complex dependency chains", async () => {
        await migrationRunner.initialize();

        // A -> B -> C (C depends on B, B depends on A)
        const migrations: Migration[] = [
          createMigration("dep_c", "Migration C")
            .addStep("step", "SELECT 3")
            .build(["dep_b"]),
          createMigration("dep_a", "Migration A")
            .addStep("step", "SELECT 1")
            .build(),
          createMigration("dep_b", "Migration B")
            .addStep("step", "SELECT 2")
            .build(["dep_a"]),
        ];

        const plan = await migrationRunner.plan(migrations);

        // Should be sorted: A, B, C
        expect(plan.pending.length).toBe(3);
        expect(plan.pending[0]!.id).toBe("dep_a");
        expect(plan.pending[1]!.id).toBe("dep_b");
        expect(plan.pending[2]!.id).toBe("dep_c");
      });

      test("should detect circular dependencies", async () => {
        await migrationRunner.initialize();

        // A -> B -> A (circular)
        const migrations: Migration[] = [
          createMigration("circular_a", "Migration A")
            .addStep("step", "SELECT 1")
            .build(["circular_b"]),
          createMigration("circular_b", "Migration B")
            .addStep("step", "SELECT 2")
            .build(["circular_a"]),
        ];

        await expect(migrationRunner.plan(migrations)).rejects.toThrow(
          /circular dependency/i
        );
      });

      test("should detect missing dependency", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("needs_missing", "Depends on missing")
            .addStep("step", "SELECT 1")
            .build(["nonexistent_migration"]),
        ];

        const plan = await migrationRunner.plan(migrations);
        expect(plan.conflicts.length).toBeGreaterThan(0);
        expect(plan.conflicts[0]).toMatch(/nonexistent_migration/);
      });
    });

    describe("Checksum Validation", () => {
      test("should detect modified migration", async () => {
        await migrationRunner.initialize();

        // Run original migration
        const original = createMigration("checksum_test", "Checksum test")
          .addStep("original", "SELECT 'original'")
          .build();

        await migrationRunner.migrate([original]);

        // Try to run modified version
        const modified = createMigration("checksum_test", "Checksum test")
          .addStep("modified", "SELECT 'modified'")
          .build();

        const plan = await migrationRunner.plan([modified]);
        expect(plan.conflicts.length).toBeGreaterThan(0);
        expect(plan.conflicts[0]).toMatch(/modified since it was applied/i);
      });
    });

    describe("Partial Migrations and Recovery", () => {
      test("should record partial migration on step failure", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("partial_test", "Partial migration test")
            .addStep(
              "step_1",
              `CREATE TABLE IF NOT EXISTS partial_test_table (
                id BIGINT NOT NULL
              ) PRIMARY KEY (id)
              DISTRIBUTED BY HASH(id) BUCKETS 4
              PROPERTIES ("replication_num" = "1")`
            )
            .addStep("step_2_fail", "INVALID SQL THAT WILL FAIL @#$%")
            .build(),
        ];

        const results = await migrationRunner.migrate(migrations);

        expect(results[0]!.success).toBe(false);
        expect(results[0]!.stepsExecuted).toBe(1); // First step succeeded
        expect(results[0]!.stepsCompleted).toBe(1);

        // Check status shows partial
        const applied = await migrationRunner.getAppliedMigrations();
        const partialMigration = applied.find((m) => m.id === "partial_test");
        expect(partialMigration?.status).toBe("partial");

        // Clean up
        await client.raw("DROP TABLE IF EXISTS partial_test_table");
      });

      test("should support checkpoint tracking", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("checkpoint_test", "Checkpoint test")
            .addStep(
              "create_table",
              `CREATE TABLE IF NOT EXISTS checkpoint_table (
                id BIGINT NOT NULL
              ) PRIMARY KEY (id)
              DISTRIBUTED BY HASH(id) BUCKETS 4
              PROPERTIES ("replication_num" = "1")`,
              { checkpoint: "table_created" }
            )
            .addStep("step_fail", "INVALID SQL @#$%")
            .build(),
        ];

        const results = await migrationRunner.migrate(migrations);

        expect(results[0]!.lastCheckpoint).toBe("table_created");

        // Clean up
        await client.raw("DROP TABLE IF EXISTS checkpoint_table");
      });

      test("should allow removing failed migration record", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("remove_test", "Remove test")
            .addStep("fail", "INVALID SQL @#$%")
            .build(),
        ];

        await migrationRunner.migrate(migrations);

        // Should have failed migration recorded
        let applied = await migrationRunner.getAppliedMigrations();
        expect(applied.find((m) => m.id === "remove_test")).toBeDefined();

        // Remove it
        await migrationRunner.removeMigrationRecord("remove_test");

        // Should be gone
        applied = await migrationRunner.getAppliedMigrations();
        expect(applied.find((m) => m.id === "remove_test")).toBeUndefined();
      });

      test("should mark resolved migration as completed", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("resolve_test", "Resolve test")
            .addStep("fail", "INVALID SQL @#$%")
            .build(),
        ];

        await migrationRunner.migrate(migrations);

        // Mark as resolved
        await migrationRunner.markResolved("resolve_test");

        // Check status is now completed
        const applied = await migrationRunner.getAppliedMigrations();
        const resolved = applied.find((m) => m.id === "resolve_test");
        expect(resolved?.status).toBe("completed");
      });
    });

    describe("Edge Values", () => {
      test("should handle empty migration (0 steps)", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("empty_migration", "Empty migration").build(),
        ];

        const results = await migrationRunner.migrate(migrations);

        expect(results[0]!.success).toBe(true);
        expect(results[0]!.stepsCompleted).toBe(0);
        expect(results[0]!.stepsTotal).toBe(0);
      });

      test("should handle reasonably long migration ID", async () => {
        await migrationRunner.initialize();

        // StarRocks has a primary key size limit, so we can't use full VARCHAR(255)
        // But we can test with a moderately long ID that's still realistic
        const longId = "20240125_long_migration_name_with_detailed_description_of_the_change";

        const migrations: Migration[] = [
          createMigration(longId, "Long ID test")
            .addStep("step", "SELECT 1")
            .build(),
        ];

        const results = await migrationRunner.migrate(migrations);
        expect(results[0]!.success).toBe(true);

        // Verify it was recorded
        const applied = await migrationRunner.getAppliedMigrations();
        expect(applied.find((m) => m.id === longId)).toBeDefined();
      });

      test("should fail migration ID that exceeds StarRocks primary key limit", async () => {
        await migrationRunner.initialize();

        // This tests that very long migration IDs hit StarRocks' primary key size limit
        // A 245+ character ID will exceed the limit when trying to record
        const tooLongId = "long_" + "a".repeat(240);

        const migrations: Migration[] = [
          createMigration(tooLongId, "Too long ID test")
            .addStep("step", "SELECT 1")
            .build(),
        ];

        // The migration step runs, but recording fails with primary key error
        // This throws because recordMigration itself fails
        await expect(migrationRunner.migrate(migrations)).rejects.toThrow(
          /primary key size exceed/i
        );
      });

      test("should handle description with special characters", async () => {
        await migrationRunner.initialize();

        const specialDesc = "Test with 'quotes', \"double quotes\", and \\ backslash";

        const migrations: Migration[] = [
          createMigration("special_desc", specialDesc)
            .addStep("step", "SELECT 1")
            .build(),
        ];

        const results = await migrationRunner.migrate(migrations);
        expect(results[0]!.success).toBe(true);
      });
    });

    describe("Idempotent Step Handling", () => {
      test("should skip idempotent step that already succeeded", async () => {
        await migrationRunner.initialize();

        const tableName = "idempotent_test_table";

        // Pre-create the table
        await client.execute(`
          CREATE TABLE IF NOT EXISTS ${tableName} (
            id BIGINT NOT NULL
          ) PRIMARY KEY (id)
          DISTRIBUTED BY HASH(id) BUCKETS 4
          PROPERTIES ("replication_num" = "1")
        `);

        // Run migration that creates the same table (marked idempotent)
        const migrations: Migration[] = [
          createMigration("idempotent_test", "Idempotent test")
            .addStep(
              "create_table",
              `CREATE TABLE ${tableName} (
                id BIGINT NOT NULL
              ) PRIMARY KEY (id)
              DISTRIBUTED BY HASH(id) BUCKETS 4
              PROPERTIES ("replication_num" = "1")`,
              { idempotent: true }
            )
            .build(),
        ];

        const results = await migrationRunner.migrate(migrations);

        // Should succeed because step is idempotent
        expect(results[0]!.success).toBe(true);

        // Clean up
        await client.raw(`DROP TABLE IF EXISTS ${tableName}`);
      });
    });

    describe("Dry Run Warnings", () => {
      test("should warn about DROP TABLE without IF EXISTS", () => {
        const migration = createMigration("drop_warning", "Drop warning test")
          .addStep("bad_drop", "DROP TABLE my_table")
          .build();

        const runner = new MigrationRunner(client, MIGRATION_DB);
        const dryRunResult = runner.dryRun(migration);

        expect(dryRunResult.warnings.length).toBeGreaterThan(0);
        expect(dryRunResult.warnings[0]).toMatch(/DROP TABLE without IF EXISTS/i);
      });

      test("should warn about destructive DROP COLUMN", () => {
        const migration = createMigration("drop_col_warning", "Drop column warning")
          .addStep("drop_col", "ALTER TABLE my_table DROP COLUMN some_col")
          .build();

        const runner = new MigrationRunner(client, MIGRATION_DB);
        const dryRunResult = runner.dryRun(migration);

        expect(dryRunResult.warnings.length).toBeGreaterThan(0);
        expect(dryRunResult.warnings[0]).toMatch(/drops a column.*destructive/i);
      });

      test("should warn about CREATE TABLE without IF NOT EXISTS", () => {
        const migration = createMigration("create_warning", "Create warning test")
          .addStep(
            "risky_create",
            `CREATE TABLE risky_table (id BIGINT) PRIMARY KEY (id)
             DISTRIBUTED BY HASH(id) BUCKETS 1 PROPERTIES ("replication_num" = "1")`
          )
          .build();

        const runner = new MigrationRunner(client, MIGRATION_DB);
        const dryRunResult = runner.dryRun(migration);

        expect(dryRunResult.warnings.length).toBeGreaterThan(0);
        expect(dryRunResult.warnings[0]).toMatch(/without IF NOT EXISTS/i);
      });
    });

    describe("Stop on Error Behavior", () => {
      test("should stop on first error by default", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("stop_test_1", "First success")
            .addStep("step", "SELECT 1")
            .build(),
          createMigration("stop_test_2", "Will fail")
            .addStep("fail", "INVALID SQL @#$%")
            .build(),
          createMigration("stop_test_3", "Never runs")
            .addStep("step", "SELECT 3")
            .build(),
        ];

        const results = await migrationRunner.migrate(migrations);

        // Should stop after second migration fails
        expect(results.length).toBe(2);
        expect(results[0]!.success).toBe(true);
        expect(results[1]!.success).toBe(false);
      });

      test("should continue on error when stopOnError is false", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("continue_test_1", "First success")
            .addStep("step", "SELECT 1")
            .build(),
          createMigration("continue_test_2", "Will fail")
            .addStep("fail", "INVALID SQL @#$%")
            .build(),
          createMigration("continue_test_3", "Should run")
            .addStep("step", "SELECT 3")
            .build(),
        ];

        const results = await migrationRunner.migrate(migrations, {
          stopOnError: false,
        });

        // All migrations should be attempted
        expect(results.length).toBe(3);
        expect(results[0]!.success).toBe(true);
        expect(results[1]!.success).toBe(false);
        expect(results[2]!.success).toBe(true);
      });
    });

    describe("Advanced Edge Cases", () => {
      test("should handle migration with many steps (20+)", async () => {
        await migrationRunner.initialize();

        // Create migration with 25 steps
        const builder = createMigration("many_steps", "Migration with many steps");
        for (let i = 1; i <= 25; i++) {
          builder.addStep(`step_${i}`, `SELECT ${i}`);
        }

        const results = await migrationRunner.migrate([builder.build()]);

        expect(results[0]!.success).toBe(true);
        expect(results[0]!.stepsCompleted).toBe(25);
        expect(results[0]!.stepsTotal).toBe(25);
      });

      test("should handle rapid re-plan after migration", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("rapid_plan_1", "First")
            .addStep("step", "SELECT 1")
            .build(),
          createMigration("rapid_plan_2", "Second")
            .addStep("step", "SELECT 2")
            .build(),
        ];

        // Run first migration
        await migrationRunner.migrate([migrations[0]!]);

        // Immediately plan (no await between)
        const plan1 = await migrationRunner.plan(migrations);
        const plan2 = await migrationRunner.plan(migrations);
        const plan3 = await migrationRunner.plan(migrations);

        // All plans should be consistent
        expect(plan1.pending.length).toBe(1);
        expect(plan2.pending.length).toBe(1);
        expect(plan3.pending.length).toBe(1);
      });

      test("should handle out-of-order migration IDs", async () => {
        await migrationRunner.initialize();

        // Migrations provided out of ID order but with explicit dependencies
        const migrations: Migration[] = [
          createMigration("z_third", "Third (ID starts with z)")
            .addStep("step", "SELECT 3")
            .build(["m_second"]),
          createMigration("a_first", "First (ID starts with a)")
            .addStep("step", "SELECT 1")
            .build(),
          createMigration("m_second", "Second (ID starts with m)")
            .addStep("step", "SELECT 2")
            .build(["a_first"]),
        ];

        const plan = await migrationRunner.plan(migrations);

        // Should respect dependencies, not alphabetical order
        expect(plan.pending.length).toBe(3);
        expect(plan.pending[0]!.id).toBe("a_first");
        expect(plan.pending[1]!.id).toBe("m_second");
        expect(plan.pending[2]!.id).toBe("z_third");
      });

      test("should handle migration ID with numbers only", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("20240101120000", "Migration with timestamp ID")
            .addStep("step", "SELECT 1")
            .build(),
        ];

        const results = await migrationRunner.migrate(migrations);
        expect(results[0]!.success).toBe(true);
      });

      test("should handle migration with underscore-only ID", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("___", "Migration with underscore ID")
            .addStep("step", "SELECT 1")
            .build(),
        ];

        const results = await migrationRunner.migrate(migrations);
        expect(results[0]!.success).toBe(true);
      });

      test("should maintain order when running same migrations twice", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("order_test_1", "First").addStep("step", "SELECT 1").build(),
          createMigration("order_test_2", "Second").addStep("step", "SELECT 2").build(),
          createMigration("order_test_3", "Third").addStep("step", "SELECT 3").build(),
        ];

        // Run first time
        const results1 = await migrationRunner.migrate(migrations);
        expect(results1.filter(r => r.success).length).toBe(3);

        // Run second time - should all skip
        const results2 = await migrationRunner.migrate(migrations);
        expect(results2.filter(r => r.skipped).length).toBe(3);
      });

      test("should handle concurrent plan calls safely", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("concurrent_plan_1", "First")
            .addStep("step", "SELECT 1")
            .build(),
          createMigration("concurrent_plan_2", "Second")
            .addStep("step", "SELECT 2")
            .build(),
        ];

        // Call plan concurrently
        const [plan1, plan2, plan3] = await Promise.all([
          migrationRunner.plan(migrations),
          migrationRunner.plan(migrations),
          migrationRunner.plan(migrations),
        ]);

        // All plans should be identical
        expect(plan1.pending.length).toBe(2);
        expect(plan2.pending.length).toBe(2);
        expect(plan3.pending.length).toBe(2);
      });

      test("should handle conditional step that always skips", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("always_skip", "Always skips")
            .addConditionalStep(
              "never_runs",
              "SELECT 1 as value",
              (result: unknown[]) => {
                // Always return false - never run
                return false;
              },
              "SELECT 'should not run'"
            )
            .build(),
        ];

        const results = await migrationRunner.migrate(migrations);

        expect(results[0]!.success).toBe(true);
        // Note: stepsCompleted counts steps that were processed (including skipped conditional steps)
        // The migration records success because the condition was evaluated, even if action was skipped
        expect(results[0]!.stepsCompleted).toBe(1);
      });

      test("should handle conditional step that always runs", async () => {
        await migrationRunner.initialize();

        const migrations: Migration[] = [
          createMigration("always_run", "Always runs")
            .addConditionalStep(
              "always_runs",
              "SELECT 1 as value",
              (result: unknown[]) => {
                // Always return true - always run
                return true;
              },
              "SELECT 'will run'"
            )
            .build(),
        ];

        const results = await migrationRunner.migrate(migrations);

        expect(results[0]!.success).toBe(true);
        expect(results[0]!.stepsCompleted).toBe(1);
      });
    });
  });
});
