/**
 * Full Pipeline Integration Tests
 *
 * Exercises the complete schema management lifecycle:
 * define → introspect → diff → generate → apply → verify
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import mysql from "mysql2/promise";
import { createStarRocksClient, type StarRocksClient } from "../src";
import {
  // Schema definition
  starrocksTable,
  defineSchema,
  bigint,
  varchar,
  int,
  datetime,
  primaryKey,
  duplicateKey,
  hash,

  // Introspection
  createSchemaIntrospector,
  type SchemaIntrospector,

  // Diffing
  diffSchema,
  summarizeDiff,

  // Migration generation
  generateMigration,
  generateMigrationSQL,
  generateDryRunOutput,

  // Snapshot (offline introspect)
  schemaToIntrospected,
  emptyIntrospectedSchema,
} from "../src/schema/index";
import { testConfig, TEST_DATABASE } from "../src/test-config";

/** Execute DDL statements via pool.query (prepared statements don't support DDL). */
async function execStatements(pool: mysql.Pool, sql: string): Promise<void> {
  const statements = sql.split(";").map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await pool.query(stmt);
  }
}

describe("Full Pipeline Integration", () => {
  let client: StarRocksClient;
  let pool: mysql.Pool;
  let introspector: SchemaIntrospector;
  const PIPELINE_DB = `${TEST_DATABASE}_pipeline`;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    await client.createDatabase(PIPELINE_DB);
    await client.useDatabase(PIPELINE_DB);

    pool = mysql.createPool({
      host: testConfig.host,
      port: testConfig.mysqlPort,
      user: testConfig.user,
      password: testConfig.password,
      database: PIPELINE_DB,
      waitForConnections: true,
      connectionLimit: 10,
    });

    introspector = createSchemaIntrospector(pool, PIPELINE_DB);
  });

  afterAll(async () => {
    await pool.end();
    await client.dropDatabase(PIPELINE_DB);
    await client.close();
  });

  // Helper: build "users" table definition (shared across sequential tests)
  function usersTableV1() {
    return starrocksTable("users", {
      id: bigint("id").notNull(),
      name: varchar("name", { length: 255 }),
      email: varchar("email", { length: 255 }),
      created_at: datetime("created_at"),
    }, (t) => ({
      key: primaryKey(t.id),
      distribution: hash(t.id, { buckets: 4 }),
      properties: { replication_num: "1" },
    }));
  }

  function usersTableV2() {
    return starrocksTable("users", {
      id: bigint("id").notNull(),
      name: varchar("name", { length: 255 }),
      email: varchar("email", { length: 255 }),
      created_at: datetime("created_at"),
      status: varchar("status", { length: 50 }),
    }, (t) => ({
      key: primaryKey(t.id),
      distribution: hash(t.id, { buckets: 4 }),
      properties: { replication_num: "1" },
    }));
  }

  function eventsTable() {
    return starrocksTable("events", {
      event_id: bigint("event_id").notNull(),
      user_id: bigint("user_id").notNull(),
      event_type: varchar("event_type", { length: 100 }),
      payload: varchar("payload", { length: 1000 }),
      occurred_at: datetime("occurred_at"),
    }, (t) => ({
      key: duplicateKey(t.event_id, t.user_id),
      distribution: hash(t.event_id, { buckets: 8 }),
      properties: { replication_num: "1" },
    }));
  }

  // ==========================================================================
  // Initial schema creation from empty database
  // ==========================================================================

  describe("Initial Schema Creation", () => {
    test("should detect new tables against empty database", async () => {
      const schema = defineSchema({ tables: { users: usersTableV1() } });
      const current = await introspector.introspect();
      const diff = diffSchema(schema, current);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables.added).toContain("users");
      expect(diff.tables.removed).toHaveLength(0);
      expect(diff.tables.modified).toHaveLength(0);
    });

    test("should generate valid CREATE TABLE SQL", async () => {
      const schema = defineSchema({ tables: { users: usersTableV1() } });
      const current = await introspector.introspect();
      const diff = diffSchema(schema, current);

      const { up, down } = generateMigrationSQL(schema, diff, current);

      expect(up).toContain("CREATE TABLE");
      expect(up).toContain("users");
      expect(up).toContain("PRIMARY KEY");
      expect(down).toContain("DROP TABLE");
    });

    test("should apply initial migration and verify", async () => {
      const schema = defineSchema({ tables: { users: usersTableV1() } });
      const current = await introspector.introspect();
      const diff = diffSchema(schema, current);

      // Generate and apply
      const { up } = generateMigrationSQL(schema, diff, current);
      await execStatements(pool, up);

      // Verify table was created
      const table = await introspector.introspectTable("users");
      expect(table).not.toBeNull();
      expect(table!.name).toBe("users");
      expect(table!.keyType).toBe("PRIMARY");
      expect(table!.columns.length).toBe(4);

      const colNames = table!.columns.map(c => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("name");
      expect(colNames).toContain("email");
      expect(colNames).toContain("created_at");
    });

    test("should report no changes when schema matches database", async () => {
      const schema = defineSchema({ tables: { users: usersTableV1() } });
      const current = await introspector.introspect();
      const diff = diffSchema(schema, current);

      expect(diff.hasChanges).toBe(false);
      expect(diff.tables.added).toHaveLength(0);
      expect(diff.tables.removed).toHaveLength(0);
      expect(diff.tables.modified).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Schema evolution — add column
  // ==========================================================================

  describe("Schema Evolution — Add Column", () => {
    test("should detect added column", async () => {
      const schema = defineSchema({ tables: { users: usersTableV2() } });
      const current = await introspector.introspect();
      const diff = diffSchema(schema, current);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables.modified.length).toBe(1);

      const tableChange = diff.tables.modified[0];
      expect(tableChange.name).toBe("users");
      const added = tableChange.columnChanges!.filter(c => c.type === "add");
      expect(added).toHaveLength(1);
      expect(added[0].columnName).toBe("status");
    });

    test("should generate and apply ADD COLUMN migration", async () => {
      const schema = defineSchema({ tables: { users: usersTableV2() } });
      const current = await introspector.introspect();
      const diff = diffSchema(schema, current);

      const { up } = generateMigrationSQL(schema, diff, current);
      expect(up).toContain("ALTER TABLE");
      expect(up).toContain("ADD COLUMN");
      expect(up).toContain("status");

      await execStatements(pool, up);

      // Verify
      const table = await introspector.introspectTable("users");
      expect(table!.columns.length).toBe(5);
      expect(table!.columns.map(c => c.name)).toContain("status");
    });
  });

  // ==========================================================================
  // Schema evolution — add second table
  // ==========================================================================

  describe("Schema Evolution — Add Table", () => {
    test("should detect new table alongside existing one", async () => {
      const schema = defineSchema({
        tables: { users: usersTableV2(), events: eventsTable() },
      });
      const current = await introspector.introspect();
      const diff = diffSchema(schema, current);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables.added).toContain("events");
      expect(diff.tables.added).not.toContain("users");
    });

    test("should apply new table and reach stable state", async () => {
      const schema = defineSchema({
        tables: { users: usersTableV2(), events: eventsTable() },
      });
      const current = await introspector.introspect();
      const diff = diffSchema(schema, current);

      const { up } = generateMigrationSQL(schema, diff, current);
      await execStatements(pool, up);

      // Verify stable state — no more changes
      const updated = await introspector.introspect();
      const diff2 = diffSchema(schema, updated);
      expect(diff2.hasChanges).toBe(false);
    });
  });

  // ==========================================================================
  // Offline diff (snapshot-based)
  // ==========================================================================

  describe("Offline Schema Diffing", () => {
    test("should diff against empty baseline using snapshots", () => {
      const schema = defineSchema({ tables: { users: usersTableV1() } });
      const empty = emptyIntrospectedSchema("test_db");

      const diff = diffSchema(schema, empty);

      expect(diff.hasChanges).toBe(true);
      expect(diff.tables.added).toContain("users");
    });

    test("should detect no changes between schema and its own snapshot", () => {
      const schema = defineSchema({ tables: { users: usersTableV1() } });
      const snapshot = schemaToIntrospected(schema, "test_db");

      const diff = diffSchema(schema, snapshot);

      expect(diff.hasChanges).toBe(false);
    });

    test("should detect column evolution via snapshots", () => {
      const usersV1 = starrocksTable("users", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: "1" },
      }));

      const usersV2 = starrocksTable("users", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
        email: varchar("email", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: "1" },
      }));

      const v1Snapshot = schemaToIntrospected(
        defineSchema({ tables: { users: usersV1 } }),
        "test_db",
      );
      const v2Schema = defineSchema({ tables: { users: usersV2 } });

      const diff = diffSchema(v2Schema, v1Snapshot);

      expect(diff.hasChanges).toBe(true);
      // Table should be modified, not added/removed
      expect(diff.tables.modified.length).toBeGreaterThanOrEqual(1);
      const mod = diff.tables.modified.find(m => m.name === "users");
      expect(mod).toBeDefined();
      const added = mod!.columnChanges!.filter(c => c.type === "add");
      expect(added.length).toBeGreaterThanOrEqual(1);
      expect(added.some(c => c.columnName === "email")).toBe(true);
    });
  });

  // ==========================================================================
  // Migration file generation
  // ==========================================================================

  describe("Migration File Generation", () => {
    test("should generate complete migration object", () => {
      const tbl = starrocksTable("pipeline_test_tbl", {
        id: bigint("id").notNull(),
        value: int("value"),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: "1" },
      }));

      const schema = defineSchema({ tables: { tbl } });
      const empty = emptyIntrospectedSchema(PIPELINE_DB);

      const diff = diffSchema(schema, empty);
      const migration = generateMigration(schema, diff, empty, {
        name: "create-pipeline-test",
      });

      expect(migration.fileContent).toContain("const migration");
      expect(migration.fileContent).toContain("up:");
      expect(migration.fileContent).toContain("down:");
      expect(migration.migration.name).toContain("create-pipeline-test");
      expect(migration.migration.up.length).toBeGreaterThan(0);
      expect(migration.migration.down.length).toBeGreaterThan(0);
    });

    test("should produce dry-run output for review", () => {
      const tbl = starrocksTable("dry_run_tbl", {
        id: bigint("id").notNull(),
        data: varchar("data", { length: 100 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: "1" },
      }));

      const schema = defineSchema({ tables: { tbl } });
      const empty = emptyIntrospectedSchema(PIPELINE_DB);
      const diff = diffSchema(schema, empty);

      const output = generateDryRunOutput(schema, diff, empty);

      expect(output).toContain("CREATE TABLE");
      expect(output).toContain("dry_run_tbl");
    });
  });

  // ==========================================================================
  // Summarize diff output
  // ==========================================================================

  describe("Diff Summary", () => {
    test("should produce human-readable summary", () => {
      const usersV1 = starrocksTable("users", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: "1" },
      }));

      const usersV2 = starrocksTable("users", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
        email: varchar("email", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: "1" },
      }));

      const events = starrocksTable("events", {
        event_id: bigint("event_id").notNull(),
        data: varchar("data", { length: 500 }),
      }, (t) => ({
        key: duplicateKey(t.event_id),
        distribution: hash(t.event_id, { buckets: 4 }),
        properties: { replication_num: "1" },
      }));

      const v1Snapshot = schemaToIntrospected(
        defineSchema({ tables: { users: usersV1 } }),
        "test_db",
      );
      const v2Schema = defineSchema({ tables: { users: usersV2, events } });

      const diff = diffSchema(v2Schema, v1Snapshot);
      const summary = summarizeDiff(diff);

      expect(summary).toBeTruthy();
      expect(typeof summary).toBe("string");
      expect(summary.toLowerCase()).toMatch(/add|creat|new/);
    });
  });

  // ==========================================================================
  // Down migration (rollback)
  // ==========================================================================

  describe("Down Migration (Rollback)", () => {
    test("should generate reversible down migration", () => {
      const usersV1 = starrocksTable("users", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: "1" },
      }));

      const usersV2 = starrocksTable("users", {
        id: bigint("id").notNull(),
        name: varchar("name", { length: 255 }),
        email: varchar("email", { length: 255 }),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: "1" },
      }));

      const v1Snapshot = schemaToIntrospected(
        defineSchema({ tables: { users: usersV1 } }),
        "test_db",
      );
      const v2Schema = defineSchema({ tables: { users: usersV2 } });

      const diff = diffSchema(v2Schema, v1Snapshot);
      const { up, down } = generateMigrationSQL(v2Schema, diff, v1Snapshot);

      expect(up).toContain("ADD COLUMN");
      expect(up.toLowerCase()).toContain("email");

      expect(down).toContain("DROP COLUMN");
      expect(down.toLowerCase()).toContain("email");
    });

    test("should generate DROP TABLE as down for new table", () => {
      const tbl = starrocksTable("brand_new_tbl", {
        id: bigint("id").notNull(),
      }, (t) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 4 }),
        properties: { replication_num: "1" },
      }));

      const schema = defineSchema({ tables: { tbl } });
      const empty = emptyIntrospectedSchema("test_db");
      const diff = diffSchema(schema, empty);

      const { up, down } = generateMigrationSQL(schema, diff, empty);

      expect(up).toContain("CREATE TABLE");
      expect(down).toContain("DROP TABLE");
      expect(down).toContain("brand_new_tbl");
    });
  });
});
