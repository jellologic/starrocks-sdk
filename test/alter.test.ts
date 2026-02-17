import { describe, test, expect } from "bun:test";
import {
  alter,
  varchar,
  int,
  bigint,
  datetime,
  bitmapIndex,
  ginIndex,
} from "../src/schema/index";

describe("ALTER TABLE Builder", () => {
  describe("addColumn", () => {
    test("generates ADD COLUMN with basic type", () => {
      const [sql] = alter("users").addColumn(varchar("email", { length: 255 })).generateSQL();
      expect(sql).toBe("ALTER TABLE `users` ADD COLUMN `email` VARCHAR(255)");
    });

    test("generates ADD COLUMN with NOT NULL", () => {
      const [sql] = alter("users")
        .addColumn(varchar("email", { length: 255 }).notNull())
        .generateSQL();
      expect(sql).toBe("ALTER TABLE `users` ADD COLUMN `email` VARCHAR(255) NOT NULL");
    });

    test("generates ADD COLUMN with default value", () => {
      const [sql] = alter("users")
        .addColumn(int("age").default(0))
        .generateSQL();
      expect(sql).toBe("ALTER TABLE `users` ADD COLUMN `age` INT DEFAULT 0");
    });

    test("generates ADD COLUMN with AFTER clause", () => {
      const [sql] = alter("users")
        .addColumn(varchar("email", { length: 255 }), { after: "name" })
        .generateSQL();
      expect(sql).toBe("ALTER TABLE `users` ADD COLUMN `email` VARCHAR(255) AFTER `name`");
    });
  });

  describe("dropColumn", () => {
    test("generates DROP COLUMN", () => {
      const [sql] = alter("users").dropColumn("legacy_field").generateSQL();
      expect(sql).toBe("ALTER TABLE `users` DROP COLUMN `legacy_field`");
    });
  });

  describe("modifyColumn", () => {
    test("generates MODIFY COLUMN with new type", () => {
      const [sql] = alter("users")
        .modifyColumn(varchar("status", { length: 100 }))
        .generateSQL();
      expect(sql).toBe("ALTER TABLE `users` MODIFY COLUMN `status` VARCHAR(100)");
    });

    test("generates MODIFY COLUMN with NOT NULL and default", () => {
      const [sql] = alter("users")
        .modifyColumn(varchar("status", { length: 100 }).notNull().default("active"))
        .generateSQL();
      expect(sql).toBe(
        "ALTER TABLE `users` MODIFY COLUMN `status` VARCHAR(100) NOT NULL DEFAULT 'active'"
      );
    });
  });

  describe("renameColumn", () => {
    test("generates RENAME COLUMN", () => {
      const [sql] = alter("users").renameColumn("old_name", "new_name").generateSQL();
      expect(sql).toBe("ALTER TABLE `users` RENAME COLUMN `old_name` `new_name`");
    });
  });

  describe("rename", () => {
    test("generates RENAME table", () => {
      const [sql] = alter("users").rename("app_users").generateSQL();
      expect(sql).toBe("ALTER TABLE `users` RENAME `app_users`");
    });
  });

  describe("addIndex", () => {
    test("generates CREATE INDEX for bitmap", () => {
      const statusCol = varchar("status", { length: 50 });
      const [sql] = alter("users")
        .addIndex(bitmapIndex("idx_status", statusCol))
        .generateSQL();
      expect(sql).toContain("CREATE INDEX");
      expect(sql).toContain("`idx_status`");
      expect(sql).toContain("USING BITMAP");
    });

    test("generates CREATE INDEX for GIN", () => {
      const tagsCol = varchar("tags", { length: 255 });
      const [sql] = alter("users")
        .addIndex(ginIndex("idx_tags", [tagsCol]))
        .generateSQL();
      expect(sql).toContain("CREATE INDEX");
      expect(sql).toContain("`idx_tags`");
      expect(sql).toContain("USING GIN");
    });
  });

  describe("dropIndex", () => {
    test("generates DROP INDEX", () => {
      const [sql] = alter("users").dropIndex("idx_status").generateSQL();
      expect(sql).toBe("DROP INDEX `idx_status` ON `users`");
    });
  });

  describe("setProperties", () => {
    test("generates SET properties", () => {
      const [sql] = alter("users")
        .setProperties({ replication_num: "3", storage_medium: "SSD" })
        .generateSQL();
      expect(sql).toBe(
        'ALTER TABLE `users` SET ("replication_num" = "3", "storage_medium" = "SSD")'
      );
    });
  });

  describe("chaining", () => {
    test("generates multiple statements for chained operations", () => {
      const stmts = alter("users")
        .addColumn(varchar("email", { length: 255 }).notNull())
        .dropColumn("legacy_field")
        .modifyColumn(varchar("status", { length: 100 }))
        .setProperties({ replication_num: "3" })
        .generateSQL();

      expect(stmts).toHaveLength(4);
      expect(stmts[0]).toContain("ADD COLUMN");
      expect(stmts[1]).toContain("DROP COLUMN");
      expect(stmts[2]).toContain("MODIFY COLUMN");
      expect(stmts[3]).toContain("SET");
    });

    test("builder is immutable — each operation returns a new builder", () => {
      const base = alter("users");
      const withAdd = base.addColumn(int("age"));
      const withDrop = base.dropColumn("old");

      expect(base.generateSQL()).toHaveLength(0);
      expect(withAdd.generateSQL()).toHaveLength(1);
      expect(withDrop.generateSQL()).toHaveLength(1);
    });
  });

  describe("toPlan", () => {
    test("returns structured plan with descriptions", () => {
      const plan = alter("users")
        .addColumn(varchar("email", { length: 255 }))
        .dropColumn("old")
        .rename("app_users")
        .toPlan();

      expect(plan.tableName).toBe("users");
      expect(plan.statements).toHaveLength(3);
      expect(plan.statements[0]!.description).toBe("Add column 'email' to 'users'");
      expect(plan.statements[1]!.description).toBe("Drop column 'old' from 'users'");
      expect(plan.statements[2]!.description).toBe("Rename table 'users' to 'app_users'");
    });
  });

  describe("with table reference", () => {
    test("accepts Table object", () => {
      const { starrocksTable, primaryKey, hash } = require("../src/schema/index");
      const users = starrocksTable("users", {
        id: bigint("id"),
        email: varchar("email", { length: 100 }),
      }, (t: any) => ({
        key: primaryKey(t.id),
        distribution: hash(t.id, { buckets: 10 }),
      }));

      const [sql] = alter(users).addColumn(int("age")).generateSQL();
      expect(sql).toBe("ALTER TABLE `users` ADD COLUMN `age` INT");
    });
  });
});
