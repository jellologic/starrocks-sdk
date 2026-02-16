/**
 * Tests for Knex-Style Query Builder
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createKnexDatabase } from "./knex-builder";
import { starrocksTable, primaryKey, hash } from "./table";
import { bigint, varchar, int, datetime, boolean } from "./columns";
import type { Pool, ResultSetHeader } from "mysql2/promise";

// ==========================================================================
// Test Tables
// ==========================================================================

const events = starrocksTable(
  "events",
  {
    id: bigint("id"),
    name: varchar("name", { length: 255 }),
    venue: varchar("venue", { length: 255 }),
    price: int("price"),
    status: varchar("status", { length: 50 }),
    isActive: boolean("is_active"),
    createdAt: datetime("created_at"),
  },
  (table) => ({
    key: primaryKey(table.id),
    distribution: hash(table.id, { buckets: 16 }),
  })
);

const tickets = starrocksTable(
  "tickets",
  {
    id: bigint("id"),
    eventId: bigint("event_id"),
    userId: bigint("user_id"),
    quantity: int("quantity"),
    purchasedAt: datetime("purchased_at"),
  },
  (table) => ({
    key: primaryKey(table.id),
    distribution: hash(table.id, { buckets: 16 }),
  })
);

// ==========================================================================
// Mock Pool
// ==========================================================================

function createMockPool(): Pool {
  return {
    query: vi.fn().mockResolvedValue([[], []]),
  } as unknown as Pool;
}

// ==========================================================================
// Tests
// ==========================================================================

describe("KnexBuilder", () => {
  let mockPool: Pool;
  let db: ReturnType<typeof createKnexDatabase>;

  beforeEach(() => {
    mockPool = createMockPool();
    db = createKnexDatabase(mockPool);
  });

  describe("SELECT", () => {
    it("should generate basic select all", () => {
      const { sql } = db(events).toSQL();
      expect(sql).toBe("SELECT *\nFROM events");
    });

    it("should select specific columns", () => {
      const { sql } = db(events).select("id", "name").toSQL();
      expect(sql).toBe("SELECT id, name\nFROM events");
    });

    it("should select columns as array", () => {
      const { sql } = db(events).select(["id", "name"]).toSQL();
      expect(sql).toBe("SELECT id, name\nFROM events");
    });

    it("should select with aliases", () => {
      const { sql } = db(events)
        .selectAs({ eventName: "name", eventId: "id" })
        .toSQL();
      expect(sql).toContain("name AS eventName");
      expect(sql).toContain("id AS eventId");
    });

    it("should handle selectAll", () => {
      const { sql } = db(events).select("id").selectAll().toSQL();
      expect(sql).toBe("SELECT *\nFROM events");
    });

    it("should handle distinct", () => {
      const { sql } = db(events).distinct().select("status").toSQL();
      expect(sql).toBe("SELECT DISTINCT status\nFROM events");
    });
  });

  describe("WHERE", () => {
    it("should handle simple where with 2 args", () => {
      const { sql, values } = db(events).where("id", 1n).toSQL();
      expect(sql).toContain("WHERE id = ?");
      expect(values).toEqual([1n]);
    });

    it("should handle where with operator", () => {
      const { sql, values } = db(events).where("price", ">", 100).toSQL();
      expect(sql).toContain("WHERE price > ?");
      expect(values).toEqual([100]);
    });

    it("should handle where with object syntax", () => {
      const { sql, values } = db(events)
        .where({ status: "active", price: 50 })
        .toSQL();
      expect(sql).toContain("WHERE status = ?");
      expect(sql).toContain("AND price = ?");
      expect(values).toEqual(["active", 50]);
    });

    it("should chain multiple where clauses with AND", () => {
      const { sql, values } = db(events)
        .where("status", "active")
        .where("price", ">", 50)
        .toSQL();
      expect(sql).toContain("WHERE status = ?");
      expect(sql).toContain("AND price > ?");
      expect(values).toEqual(["active", 50]);
    });

    it("should handle orWhere", () => {
      const { sql, values } = db(events)
        .where("status", "active")
        .orWhere("status", "pending")
        .toSQL();
      expect(sql).toContain("WHERE status = ?");
      expect(sql).toContain("OR status = ?");
      expect(values).toEqual(["active", "pending"]);
    });

    it("should handle whereIn", () => {
      const { sql, values } = db(events).whereIn("id", [1n, 2n, 3n]).toSQL();
      expect(sql).toContain("WHERE id IN (?, ?, ?)");
      expect(values).toEqual([1n, 2n, 3n]);
    });

    it("should handle whereNotIn", () => {
      const { sql, values } = db(events).whereNotIn("status", ["deleted", "archived"]).toSQL();
      expect(sql).toContain("WHERE status NOT IN (?, ?)");
      expect(values).toEqual(["deleted", "archived"]);
    });

    it("should handle whereBetween", () => {
      const { sql, values } = db(events).whereBetween("price", [10, 100]).toSQL();
      expect(sql).toContain("WHERE price BETWEEN ? AND ?");
      expect(values).toEqual([10, 100]);
    });

    it("should handle whereNull", () => {
      const { sql, values } = db(events).whereNull("venue").toSQL();
      expect(sql).toContain("WHERE venue IS NULL");
      expect(values).toEqual([]);
    });

    it("should handle whereNotNull", () => {
      const { sql, values } = db(events).whereNotNull("venue").toSQL();
      expect(sql).toContain("WHERE venue IS NOT NULL");
      expect(values).toEqual([]);
    });

    it("should handle whereRaw", () => {
      const { sql, values } = db(events)
        .whereRaw("DATE(created_at) = ?", ["2024-01-01"])
        .toSQL();
      expect(sql).toContain("WHERE DATE(created_at) = ?");
      expect(values).toEqual(["2024-01-01"]);
    });

    it("should handle orWhereRaw", () => {
      const { sql, values } = db(events)
        .where("status", "active")
        .orWhereRaw("price > ? * 2", [50])
        .toSQL();
      expect(sql).toContain("WHERE status = ?");
      expect(sql).toContain("OR price > ? * 2");
      expect(values).toEqual(["active", 50]);
    });
  });

  describe("JOIN", () => {
    it("should handle inner join with 3 args", () => {
      const { sql } = db(events).join(tickets, "id", "eventId").toSQL();
      expect(sql).toContain("INNER JOIN tickets ON events.id = tickets.event_id");
    });

    it("should handle inner join with operator", () => {
      const { sql } = db(events).join(tickets, "id", "=", "eventId").toSQL();
      expect(sql).toContain("INNER JOIN tickets ON events.id = tickets.event_id");
    });

    it("should handle left join", () => {
      const { sql } = db(events).leftJoin(tickets, "id", "eventId").toSQL();
      expect(sql).toContain("LEFT JOIN tickets ON events.id = tickets.event_id");
    });

    it("should handle right join", () => {
      const { sql } = db(events).rightJoin(tickets, "id", "eventId").toSQL();
      expect(sql).toContain("RIGHT JOIN tickets ON events.id = tickets.event_id");
    });
  });

  describe("GROUP BY & HAVING", () => {
    it("should handle groupBy", () => {
      const { sql } = db(events).select("status").groupBy("status").toSQL();
      expect(sql).toContain("GROUP BY status");
    });

    it("should handle multiple groupBy columns", () => {
      const { sql } = db(events)
        .select("status", "venue")
        .groupBy("status", "venue")
        .toSQL();
      expect(sql).toContain("GROUP BY status, venue");
    });

    it("should handle havingRaw", () => {
      const { sql, values } = db(events)
        .select("status")
        .groupBy("status")
        .havingRaw("COUNT(*) > ?", [5])
        .toSQL();
      expect(sql).toContain("HAVING COUNT(*) > ?");
      expect(values).toEqual([5]);
    });
  });

  describe("ORDER BY", () => {
    it("should handle orderBy with default direction", () => {
      const { sql } = db(events).orderBy("createdAt").toSQL();
      expect(sql).toContain("ORDER BY created_at ASC");
    });

    it("should handle orderBy with direction", () => {
      const { sql } = db(events).orderBy("createdAt", "desc").toSQL();
      expect(sql).toContain("ORDER BY created_at DESC");
    });

    it("should handle orderByDesc shorthand", () => {
      const { sql } = db(events).orderByDesc("createdAt").toSQL();
      expect(sql).toContain("ORDER BY created_at DESC");
    });

    it("should handle multiple orderBy", () => {
      const { sql } = db(events)
        .orderBy("status", "asc")
        .orderBy("createdAt", "desc")
        .toSQL();
      expect(sql).toContain("ORDER BY status ASC, created_at DESC");
    });

    it("should handle orderBy with array of specs", () => {
      const { sql } = db(events)
        .orderBy([
          { column: "status", order: "asc" },
          { column: "createdAt", order: "desc" },
        ])
        .toSQL();
      expect(sql).toContain("ORDER BY status ASC, created_at DESC");
    });
  });

  describe("LIMIT & OFFSET", () => {
    it("should handle limit", () => {
      const { sql } = db(events).limit(10).toSQL();
      expect(sql).toContain("LIMIT 10");
    });

    it("should handle offset", () => {
      const { sql } = db(events).offset(20).toSQL();
      expect(sql).toContain("OFFSET 20");
    });

    it("should handle limit and offset together", () => {
      const { sql } = db(events).limit(10).offset(20).toSQL();
      expect(sql).toContain("LIMIT 10");
      expect(sql).toContain("OFFSET 20");
    });
  });

  describe("execute()", () => {
    it("should execute query and return results", async () => {
      const mockRows = [
        { id: 1, name: "Event 1" },
        { id: 2, name: "Event 2" },
      ];
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockRows, []]);

      const results = await db(events).select("id", "name");
      expect(results).toEqual(mockRows);
    });
  });

  describe("first()", () => {
    it("should return first result", async () => {
      const mockRows = [{ id: 1, name: "Event 1" }];
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockRows, []]);

      const result = await db(events).select("id", "name").first();
      expect(result).toEqual({ id: 1, name: "Event 1" });
    });

    it("should return null when no results", async () => {
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], []]);

      const result = await db(events).first();
      expect(result).toBeNull();
    });
  });

  describe("firstOrFail()", () => {
    it("should return first result", async () => {
      const mockRows = [{ id: 1, name: "Event 1" }];
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockRows, []]);

      const result = await db(events).firstOrFail();
      expect(result).toEqual({ id: 1, name: "Event 1" });
    });

    it("should throw when no results", async () => {
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], []]);

      await expect(db(events).firstOrFail()).rejects.toThrow("No results found");
    });
  });

  describe("pluck()", () => {
    it("should return array of single column values", async () => {
      const mockRows = [{ name: "Event 1" }, { name: "Event 2" }];
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockRows, []]);

      const names = await db(events).pluck("name");
      expect(names).toEqual(["Event 1", "Event 2"]);
    });
  });

  describe("count()", () => {
    it("should return count", async () => {
      const mockRows = [{ count: 42 }];
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockRows, []]);

      const count = await db(events).count();
      expect(count).toBe(42);
    });

    it("should handle count with where", async () => {
      const mockRows = [{ count: 10 }];
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockRows, []]);

      const count = await db(events).where("status", "active").count();
      expect(count).toBe(10);
    });
  });

  describe("exists()", () => {
    it("should return true when results exist", async () => {
      const mockRows = [{ count: 1 }];
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockRows, []]);

      const exists = await db(events).where("id", 1n).exists();
      expect(exists).toBe(true);
    });

    it("should return false when no results", async () => {
      const mockRows = [{ count: 0 }];
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockRows, []]);

      const exists = await db(events).where("id", 999n).exists();
      expect(exists).toBe(false);
    });
  });

  describe("insert()", () => {
    it("should insert a single row", async () => {
      const mockResult = {
        affectedRows: 1,
        insertId: 1,
      } as ResultSetHeader;
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockResult, []]);

      const result = await db(events).insert({
        id: 1n,
        name: "New Event",
        venue: "Arena",
        price: 50,
        status: "active",
        isActive: true,
        createdAt: new Date("2024-01-01"),
      });

      expect(result.affectedRows).toBe(1);
      const [sql] = (mockPool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("INSERT INTO events");
    });
  });

  describe("insertMany()", () => {
    it("should insert multiple rows", async () => {
      const mockResult = {
        affectedRows: 2,
        insertId: 1,
      } as ResultSetHeader;
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockResult, []]);

      const result = await db(events).insertMany([
        {
          id: 1n,
          name: "Event 1",
          venue: "Arena 1",
          price: 50,
          status: "active",
          isActive: true,
          createdAt: new Date("2024-01-01"),
        },
        {
          id: 2n,
          name: "Event 2",
          venue: "Arena 2",
          price: 75,
          status: "active",
          isActive: true,
          createdAt: new Date("2024-01-02"),
        },
      ]);

      expect(result.affectedRows).toBe(2);
      const [sql] = (mockPool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("INSERT INTO events");
      expect(sql).toContain("VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)");
    });

    it("should throw on empty array", async () => {
      await expect(db(events).insertMany([])).rejects.toThrow("Cannot insert empty array");
    });
  });

  describe("update()", () => {
    it("should update rows with where clause", async () => {
      const mockResult = {
        affectedRows: 1,
        changedRows: 1,
      } as ResultSetHeader;
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockResult, []]);

      const result = await db(events).where("id", 1n).update({ price: 100 });

      expect(result.affectedRows).toBe(1);
      const [sql] = (mockPool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("UPDATE events SET price = ?");
      expect(sql).toContain("WHERE id = ?");
    });

    it("should throw on empty update data", async () => {
      await expect(db(events).where("id", 1n).update({})).rejects.toThrow("No data to update");
    });
  });

  describe("increment() / decrement()", () => {
    it("should increment column", async () => {
      const mockResult = {
        affectedRows: 1,
        changedRows: 1,
      } as ResultSetHeader;
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockResult, []]);

      await db(events).where("id", 1n).increment("price", 10);

      const [sql] = (mockPool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("SET price = price + ?");
    });

    it("should decrement column", async () => {
      const mockResult = {
        affectedRows: 1,
        changedRows: 1,
      } as ResultSetHeader;
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockResult, []]);

      await db(events).where("id", 1n).decrement("price", 10);

      const [sql, values] = (mockPool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("SET price = price + ?");
      expect(values[0]).toBe(-10); // decrement passes negative value
    });
  });

  describe("delete()", () => {
    it("should delete rows with where clause", async () => {
      const mockResult = {
        affectedRows: 1,
      } as ResultSetHeader;
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockResult, []]);

      const result = await db(events).where("id", 1n).delete();

      expect(result.affectedRows).toBe(1);
      const [sql] = (mockPool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("DELETE FROM events");
      expect(sql).toContain("WHERE id = ?");
    });

    it("should throw without where clause", async () => {
      await expect(db(events).delete()).rejects.toThrow(
        /Cannot delete from table.*without where clause/
      );
    });
  });

  describe("truncate()", () => {
    it("should truncate table", async () => {
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], []]);

      await db(events).truncate();

      const [sql] = (mockPool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toBe("TRUNCATE TABLE events");
    });
  });

  describe("createKnexDatabase", () => {
    it("should create db interface", () => {
      const db = createKnexDatabase(mockPool);
      expect(typeof db).toBe("function");
      expect(db.pool).toBe(mockPool);
    });

    it("should support raw queries", async () => {
      const mockRows = [{ value: 1 }];
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockRows, []]);

      const results = await db.raw<{ value: number }>("SELECT 1 as value");
      expect(results).toEqual([{ value: 1 }]);
    });

    it("should support execute", async () => {
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], []]);

      await db.execute("SET time_zone = '+00:00'");
      expect(mockPool.query).toHaveBeenCalledWith("SET time_zone = '+00:00'", undefined);
    });
  });

  describe("Column name resolution", () => {
    it("should resolve camelCase to snake_case column names", () => {
      const { sql } = db(events).select("isActive").where("createdAt", new Date()).toSQL();
      expect(sql).toContain("SELECT is_active");
      expect(sql).toContain("WHERE created_at = ?");
    });
  });

  describe("Complex queries", () => {
    it("should build complex query with multiple clauses", () => {
      const { sql, values } = db(events)
        .select("id", "name", "price")
        .where("status", "active")
        .where("price", ">", 50)
        .whereNotNull("venue")
        .orderBy("price", "desc")
        .limit(10)
        .offset(20)
        .toSQL();

      expect(sql).toContain("SELECT id, name, price");
      expect(sql).toContain("FROM events");
      expect(sql).toContain("WHERE status = ?");
      expect(sql).toContain("AND price > ?");
      expect(sql).toContain("AND venue IS NOT NULL");
      expect(sql).toContain("ORDER BY price DESC");
      expect(sql).toContain("LIMIT 10");
      expect(sql).toContain("OFFSET 20");
      expect(values).toEqual(["active", 50]);
    });

    it("should build query with join, group by, and having", () => {
      const { sql, values } = db(events)
        .select("name")
        .join(tickets, "id", "eventId")
        .groupBy("name")
        .havingRaw("SUM(quantity) > ?", [100])
        .orderBy("name")
        .toSQL();

      expect(sql).toContain("SELECT name");
      expect(sql).toContain("INNER JOIN tickets");
      expect(sql).toContain("GROUP BY name");
      expect(sql).toContain("HAVING SUM(quantity) > ?");
      expect(sql).toContain("ORDER BY name ASC");
      expect(values).toEqual([100]);
    });
  });

  describe("toString()", () => {
    it("should return SQL string for debugging", () => {
      const builder = db(events).select("id", "name").where("status", "active");
      const sql = builder.toString();
      expect(sql).toContain("SELECT id, name");
      expect(sql).toContain("WHERE status = ?");
    });
  });

  describe("Promise-like behavior", () => {
    it("should work with await directly", async () => {
      const mockRows = [{ id: 1, name: "Event 1" }];
      (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockRows, []]);

      const results = await db(events).select("id", "name");
      expect(results).toEqual(mockRows);
    });
  });
});
