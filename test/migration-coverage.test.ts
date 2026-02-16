import { describe, test, expect } from "bun:test";
import {
  bigint,
  varchar,
  double,
  starrocksTable,
  primaryKey,
  duplicateKey,
  hash,
  random,
  defineSchema,
  schemaToIntrospected,
  emptyIntrospectedSchema,
  diffSchema,
  generateMigration,
  generateMigrationSQL,
  generateDryRunOutput,
} from "../src/schema/index";
import type { IntrospectedSchema } from "../src/schema/index";

describe("Table recreation migration", () => {
  test("key type change generates RENAME + CREATE + INSERT SELECT + DROP", () => {
    // New schema: PRIMARY KEY
    const table = starrocksTable("orders", {
      id: bigint("id").notNull(),
      amount: double("amount"),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
    }));

    const schema = defineSchema({ tables: { orders: table } });

    // Existing: same table but DUPLICATE key
    const existing: IntrospectedSchema = {
      database: "testdb",
      tables: [{
        name: "orders",
        type: "table",
        columns: [
          { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "DUP", aggregateType: null, comment: null },
          { name: "amount", dataType: "DOUBLE", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
        ],
        keyType: "DUPLICATE",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 8,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        indexes: [],
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, existing);
    expect(diff.tables.modified.length).toBe(1);
    expect(diff.tables.modified[0]!.keyChange).toBeDefined();

    const { migration } = generateMigration(schema, diff, existing);
    const upSqls = migration.up.map((s) => s.sql);

    // Should contain: RENAME, CREATE TABLE, INSERT INTO...SELECT, DROP TABLE
    expect(upSqls.some((s) => s.includes("RENAME") && s.includes("orders_old"))).toBe(true);
    expect(upSqls.some((s) => s.includes("CREATE TABLE") && s.includes("PRIMARY KEY"))).toBe(true);
    expect(upSqls.some((s) => s.includes("INSERT INTO") && s.includes("SELECT") && s.includes("orders_old"))).toBe(true);
    expect(upSqls.some((s) => s.includes("DROP TABLE") && s.includes("orders_old"))).toBe(true);
  });

  test("distribution change triggers table recreation", () => {
    const table = starrocksTable("orders", {
      id: bigint("id").notNull(),
      amount: double("amount"),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 16 }),
    }));

    const schema = defineSchema({ tables: { orders: table } });

    const existing: IntrospectedSchema = {
      database: "testdb",
      tables: [{
        name: "orders",
        type: "table",
        columns: [
          { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          { name: "amount", dataType: "DOUBLE", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "RANDOM",
        distributionColumns: [],
        buckets: 8,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        indexes: [],
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, existing);
    expect(diff.tables.modified[0]!.distributionChange).toBeDefined();

    const { migration } = generateMigration(schema, diff, existing);
    const upSqls = migration.up.map((s) => s.sql);

    expect(upSqls.some((s) => s.includes("RENAME"))).toBe(true);
    expect(upSqls.some((s) => s.includes("CREATE TABLE"))).toBe(true);
    expect(upSqls.some((s) => s.includes("DROP TABLE"))).toBe(true);
  });
});

describe("Reserved word escaping in migrations", () => {
  test("table named 'user' gets backtick-quoted in ADD COLUMN migration SQL", () => {
    const userTable = starrocksTable("user", {
      id: bigint("id").notNull(),
      email: varchar("email", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
    }));

    const schema = defineSchema({ tables: { user: userTable } });

    // Existing: same table but missing email column
    const existing: IntrospectedSchema = {
      database: "testdb",
      tables: [{
        name: "user",
        type: "table",
        columns: [
          { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 8,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        indexes: [],
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, existing);
    const { migration } = generateMigration(schema, diff, existing);
    const upSqls = migration.up.map((s) => s.sql);

    // The table name should be backtick-quoted since "user" is a reserved word
    const alterSql = upSqls.find((s) => s.includes("ALTER TABLE"));
    expect(alterSql).toBeDefined();
    expect(alterSql).toContain("`user`");
  });

  test("table named 'order' gets backtick-quoted in recreation", () => {
    const orderTable = starrocksTable("order", {
      id: bigint("id").notNull(),
      amount: double("amount"),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
    }));

    const schema = defineSchema({ tables: { order: orderTable } });

    // Existing: different key type forces recreation
    const existing: IntrospectedSchema = {
      database: "testdb",
      tables: [{
        name: "order",
        type: "table",
        columns: [
          { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "DUP", aggregateType: null, comment: null },
          { name: "amount", dataType: "DOUBLE", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
        ],
        keyType: "DUPLICATE",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 8,
        partitionType: null,
        partitionColumn: null,
        properties: {},
        indexes: [],
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, existing);
    const { migration } = generateMigration(schema, diff, existing);
    const upSqls = migration.up.map((s) => s.sql);

    const renameSql = upSqls.find((s) => s.includes("RENAME"));
    expect(renameSql).toBeDefined();
    expect(renameSql).toContain("`order`");
    expect(renameSql).toContain("`order_old`");
  });
});

describe("Property change migration", () => {
  test("generates ALTER TABLE SET for property changes", () => {
    const table = starrocksTable("events", {
      id: bigint("id").notNull(),
      title: varchar("title", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
      properties: { replication_num: 3 },
    }));

    const schema = defineSchema({ tables: { events: table } });

    // Existing: same table but replication_num was 1
    const existing: IntrospectedSchema = {
      database: "testdb",
      tables: [{
        name: "events",
        type: "table",
        columns: [
          { name: "id", dataType: "BIGINT", isNullable: false, defaultValue: null, columnKey: "PRI", aggregateType: null, comment: null },
          { name: "title", dataType: "VARCHAR(255)", isNullable: true, defaultValue: null, columnKey: null, aggregateType: null, comment: null },
        ],
        keyType: "PRIMARY",
        keyColumns: ["id"],
        distributionType: "HASH",
        distributionColumns: ["id"],
        buckets: 8,
        partitionType: null,
        partitionColumn: null,
        properties: { replication_num: "1" },
        indexes: [],
        comment: null,
      }],
      views: [],
      materializedViews: [],
    };

    const diff = diffSchema(schema, existing);
    const tableChange = diff.tables.modified.find((t) => t.name === "events");
    expect(tableChange).toBeDefined();
    expect(tableChange!.propertyChanges).toBeDefined();
    expect(tableChange!.propertyChanges!.length).toBeGreaterThan(0);

    const { migration } = generateMigration(schema, diff, existing);
    const upSqls = migration.up.map((s) => s.sql);

    const alterPropSql = upSqls.find((s) => s.includes("ALTER TABLE") && s.includes("SET"));
    expect(alterPropSql).toBeDefined();
    expect(alterPropSql).toContain("replication_num");
    expect(alterPropSql).toContain("3");
  });
});

describe("Migration output formats", () => {
  test("generateMigrationSQL produces UP and DOWN sections", () => {
    const table = starrocksTable("events", {
      id: bigint("id").notNull(),
      title: varchar("title", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
    }));

    const schema = defineSchema({ tables: { events: table } });
    const existing = emptyIntrospectedSchema("testdb");

    const diff = diffSchema(schema, existing);
    const sqlOutput = generateMigrationSQL(schema, diff, existing);

    expect(sqlOutput.up).toContain("CREATE TABLE");
    expect(typeof sqlOutput.down).toBe("string");
  });

  test("generateDryRunOutput produces readable summary", () => {
    const table = starrocksTable("events", {
      id: bigint("id").notNull(),
      title: varchar("title", { length: 255 }),
    }, (t) => ({
      pk: primaryKey(t.id),
      dist: hash(t.id, { buckets: 8 }),
    }));

    const schema = defineSchema({ tables: { events: table } });
    const existing = emptyIntrospectedSchema("testdb");

    const diff = diffSchema(schema, existing);
    const dryRun = generateDryRunOutput(schema, diff, existing);

    expect(dryRun).toContain("DRY RUN");
    expect(dryRun).toContain("events");
  });
});
