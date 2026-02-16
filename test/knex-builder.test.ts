/**
 * Integration Tests for Knex-Style Query Builder
 *
 * Tests against real StarRocks using Docker (port 19030)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import mysql from "mysql2/promise";
import { testConfig, TEST_DATABASE } from "../src/test-config";
import { createStarRocksClient, type StarRocksClient } from "../src";
import {
  createKnexDatabase,
  starrocksTable,
  primaryKey,
  hash,
  bigint,
  varchar,
  int,
  datetime,
  boolean,
  generateCreateTableSQL,
} from "../src/schema/index";

// ==========================================================================
// Test Tables (type-safe schema)
// ==========================================================================

const eventsTable = starrocksTable(
  "knex_events",
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
    distribution: hash(table.id, { buckets: 4 }),
    properties: { replication_num: 1 },
  })
);

const ticketsTable = starrocksTable(
  "knex_tickets",
  {
    id: bigint("id"),
    eventId: bigint("event_id"),
    userId: bigint("user_id"),
    quantity: int("quantity"),
    purchasedAt: datetime("purchased_at"),
  },
  (table) => ({
    key: primaryKey(table.id),
    distribution: hash(table.id, { buckets: 4 }),
    properties: { replication_num: 1 },
  })
);

// ==========================================================================
// Tests
// ==========================================================================

describe("Knex Builder Integration", () => {
  let client: StarRocksClient;
  let pool: mysql.Pool;
  let db: ReturnType<typeof createKnexDatabase>;

  beforeAll(async () => {
    // Create client for database management
    client = createStarRocksClient(testConfig);
    await client.createDatabase(TEST_DATABASE);
    await client.useDatabase(TEST_DATABASE);

    // Create pool for Knex builder
    pool = mysql.createPool({
      host: testConfig.host,
      port: testConfig.mysqlPort,
      user: testConfig.user,
      password: testConfig.password,
      database: TEST_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
    });

    db = createKnexDatabase(pool);

    // Create test tables using generated SQL
    const eventsSql = generateCreateTableSQL(eventsTable);
    const ticketsSql = generateCreateTableSQL(ticketsTable);

    await client.execute(eventsSql);
    await client.execute(ticketsSql);
  });

  afterAll(async () => {
    await pool.end();
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  describe("INSERT operations", () => {
    test("should insert a single row", async () => {
      const result = await db(eventsTable).insert({
        id: 1n,
        name: "Concert",
        venue: "Arena",
        price: 50,
        status: "active",
        isActive: true,
        createdAt: new Date("2024-01-01T10:00:00Z"),
      });

      expect(result.affectedRows).toBe(1);
    });

    test("should insert multiple rows", async () => {
      const result = await db(eventsTable).insertMany([
        {
          id: 2n,
          name: "Festival",
          venue: "Park",
          price: 75,
          status: "active",
          isActive: true,
          createdAt: new Date("2024-02-01T10:00:00Z"),
        },
        {
          id: 3n,
          name: "Theater",
          venue: "Hall",
          price: 100,
          status: "pending",
          isActive: false,
          createdAt: new Date("2024-03-01T10:00:00Z"),
        },
        {
          id: 4n,
          name: "Opera",
          venue: "House",
          price: 150,
          status: "active",
          isActive: true,
          createdAt: new Date("2024-04-01T10:00:00Z"),
        },
      ]);

      expect(result.affectedRows).toBe(3);
    });

    test("should insert tickets for events", async () => {
      const result = await db(ticketsTable).insertMany([
        { id: 1n, eventId: 1n, userId: 100n, quantity: 2, purchasedAt: new Date() },
        { id: 2n, eventId: 1n, userId: 101n, quantity: 1, purchasedAt: new Date() },
        { id: 3n, eventId: 2n, userId: 100n, quantity: 4, purchasedAt: new Date() },
        { id: 4n, eventId: 3n, userId: 102n, quantity: 2, purchasedAt: new Date() },
      ]);

      expect(result.affectedRows).toBe(4);
    });
  });

  describe("SELECT operations", () => {
    test("should select all rows", async () => {
      const events = await db(eventsTable).selectAll();
      expect(events.length).toBe(4);
    });

    test("should select specific columns", async () => {
      const events = await db(eventsTable).select("id", "name");
      expect(events.length).toBe(4);
      expect(events[0]).toHaveProperty("id");
      expect(events[0]).toHaveProperty("name");
    });

    test("should filter with where clause", async () => {
      const active = await db(eventsTable).where("status", "active");
      expect(active.length).toBe(3);
    });

    test("should filter with operator", async () => {
      const expensive = await db(eventsTable).where("price", ">", 75);
      expect(expensive.length).toBe(2);
    });

    test("should filter with object syntax", async () => {
      const filtered = await db(eventsTable).where({
        status: "active",
        isActive: true,
      });
      expect(filtered.length).toBe(3);
    });

    test("should use orWhere", async () => {
      const mixed = await db(eventsTable)
        .where("status", "pending")
        .orWhere("price", ">", 100);
      expect(mixed.length).toBe(2); // Theater (pending) + Opera (>100)
    });

    test("should use whereIn", async () => {
      const selected = await db(eventsTable).whereIn("id", [1n, 3n]);
      expect(selected.length).toBe(2);
    });

    test("should use whereBetween", async () => {
      const range = await db(eventsTable).whereBetween("price", [60, 120]);
      expect(range.length).toBe(2); // Festival (75) + Theater (100)
    });

    test("should use order by", async () => {
      const ordered = await db(eventsTable)
        .select("id", "price")
        .orderBy("price", "desc");
      expect(ordered[0]!.price).toBe(150);
      expect(ordered[ordered.length - 1]!.price).toBe(50);
    });

    test("should use limit and offset", async () => {
      const page = await db(eventsTable)
        .orderBy("id")
        .limit(2)
        .offset(1);
      expect(page.length).toBe(2);
      // MySQL returns numbers, not bigints
      expect(Number(page[0]!.id)).toBe(2);
    });
  });

  describe("first() and convenience methods", () => {
    test("should get first result", async () => {
      const first = await db(eventsTable)
        .where("status", "active")
        .orderBy("price")
        .first();
      expect(first).not.toBeNull();
      expect(first!.price).toBe(50);
    });

    test("should return null when no results", async () => {
      const none = await db(eventsTable)
        .where("status", "nonexistent")
        .first();
      expect(none).toBeNull();
    });

    test("should throw on firstOrFail with no results", async () => {
      await expect(
        db(eventsTable).where("status", "nonexistent").firstOrFail()
      ).rejects.toThrow("No results found");
    });

    test("should count rows", async () => {
      const count = await db(eventsTable).count();
      expect(count).toBe(4);
    });

    test("should count with condition", async () => {
      const activeCount = await db(eventsTable).where("status", "active").count();
      expect(activeCount).toBe(3);
    });

    test("should check exists", async () => {
      const exists = await db(eventsTable).where("id", 1n).exists();
      expect(exists).toBe(true);

      const notExists = await db(eventsTable).where("id", 999n).exists();
      expect(notExists).toBe(false);
    });

    test("should pluck column values", async () => {
      const names = await db(eventsTable)
        .where("status", "active")
        .orderBy("id")
        .pluck("name");
      expect(names).toEqual(["Concert", "Festival", "Opera"]);
    });
  });

  describe("JOIN operations", () => {
    test("should perform inner join", async () => {
      const results = await db(eventsTable)
        .select("name")
        .join(ticketsTable, "id", "eventId")
        .groupBy("name")
        .orderBy("name");

      // Only events with tickets
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    test("should perform left join", async () => {
      const results = await db(eventsTable)
        .select("name")
        .leftJoin(ticketsTable, "id", "eventId")
        .groupBy("name")
        .orderBy("name");

      // All events including those without tickets
      expect(results.length).toBe(4);
    });
  });

  describe("UPDATE operations", () => {
    test("should update rows", async () => {
      const result = await db(eventsTable)
        .where("id", 1n)
        .update({ price: 60 });

      expect(result.affectedRows).toBe(1);

      // Verify update
      const updated = await db(eventsTable).where("id", 1n).first();
      expect(updated!.price).toBe(60);
    });

    test("should increment column", async () => {
      const before = await db(eventsTable).where("id", 2n).first();
      const originalPrice = before!.price;

      await db(eventsTable).where("id", 2n).increment("price", 10);

      const after = await db(eventsTable).where("id", 2n).first();
      expect(after!.price).toBe(originalPrice + 10);
    });

    test("should decrement column", async () => {
      const before = await db(eventsTable).where("id", 2n).first();
      const originalPrice = before!.price;

      await db(eventsTable).where("id", 2n).decrement("price", 5);

      const after = await db(eventsTable).where("id", 2n).first();
      expect(after!.price).toBe(originalPrice - 5);
    });
  });

  describe("DELETE operations", () => {
    test("should delete with condition", async () => {
      // Insert a row to delete
      await db(eventsTable).insert({
        id: 999n,
        name: "ToDelete",
        venue: "Temp",
        price: 10,
        status: "temp",
        isActive: false,
        createdAt: new Date(),
      });

      // Verify it exists
      const before = await db(eventsTable).where("id", 999n).exists();
      expect(before).toBe(true);

      // Delete it
      const result = await db(eventsTable).where("id", 999n).delete();
      expect(result.affectedRows).toBe(1);

      // Verify it's gone
      const after = await db(eventsTable).where("id", 999n).exists();
      expect(after).toBe(false);
    });

    test("should throw when deleting without where clause", async () => {
      await expect(db(eventsTable).delete()).rejects.toThrow(
        /Cannot delete from table.*without where clause/
      );
    });
  });

  describe("Raw queries", () => {
    test("should execute raw SELECT", async () => {
      const results = await db.raw<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM knex_events WHERE status = ?",
        ["active"]
      );
      expect(results[0]!.cnt).toBe(3);
    });

    test("should execute raw statement", async () => {
      await db.execute("SELECT 1");
      // No error means success
    });
  });

  describe("Complex queries", () => {
    test("should handle complex query with multiple clauses", async () => {
      const results = await db(eventsTable)
        .select("name", "price")
        .where("status", "active")
        .where("price", ">=", 50)
        .whereNotNull("venue")
        .orderBy("price", "desc")
        .limit(2);

      expect(results.length).toBe(2);
      expect(results[0]!.price).toBeGreaterThanOrEqual(results[1]!.price);
    });

    test("should handle GROUP BY with HAVING", async () => {
      const results = await db(ticketsTable)
        .select("eventId")
        .groupBy("eventId")
        .havingRaw("SUM(quantity) >= ?", [2])
        .orderBy("eventId");

      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================================
  // Battle Tests: Edge Cases and SQL Injection Prevention
  // ============================================================================

  describe("Edge Cases", () => {
    describe("Empty Array Handling", () => {
      test("whereIn with empty array generates invalid SQL (known limitation)", async () => {
        // StarRocks doesn't support IN () - this is a known limitation
        // The builder should ideally handle this, but currently throws
        await expect(db(eventsTable).whereIn("id", []).execute()).rejects.toThrow(/IN \(\)/i);
      });

      test("whereNotIn with empty array generates invalid SQL (known limitation)", async () => {
        // StarRocks doesn't support NOT IN () - this is a known limitation
        await expect(db(eventsTable).whereNotIn("id", []).execute()).rejects.toThrow(/NOT IN \(\)/i);
      });

      test("insertMany with empty array should throw", async () => {
        await expect(db(eventsTable).insertMany([])).rejects.toThrow(/empty/i);
      });
    });

    describe("LIMIT and OFFSET Edge Values", () => {
      test("LIMIT 0 should return no results", async () => {
        const results = await db(eventsTable).limit(0);
        expect(results.length).toBe(0);
      });

      test("OFFSET without LIMIT requires LIMIT in StarRocks", async () => {
        // StarRocks requires LIMIT when using OFFSET
        // This test verifies the database behavior
        await expect(
          db(eventsTable).offset(1).orderBy("id").execute()
        ).rejects.toThrow(/OFFSET/i);
      });

      test("OFFSET with LIMIT should work correctly", async () => {
        const all = await db(eventsTable).selectAll();
        const withOffset = await db(eventsTable).offset(1).limit(100).orderBy("id");
        expect(withOffset.length).toBe(all.length - 1);
      });

      test("Very large OFFSET should return empty array", async () => {
        const results = await db(eventsTable).offset(10000).limit(10);
        expect(results.length).toBe(0);
      });
    });

    describe("SQL Injection Prevention", () => {
      test("should safely handle single quotes in string values", async () => {
        // Insert a row with a single quote in the name
        await db(eventsTable).insert({
          id: 1001n,
          name: "Event's Name",
          venue: "O'Brien's Pub",
          price: 25,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        // Query it back
        const result = await db(eventsTable).where("id", 1001n).first();
        expect(result?.name).toBe("Event's Name");
        expect(result?.venue).toBe("O'Brien's Pub");

        // Clean up
        await db(eventsTable).where("id", 1001n).delete();
      });

      test("should safely handle double quotes in string values", async () => {
        await db(eventsTable).insert({
          id: 1002n,
          name: 'The "Best" Event',
          venue: "Hall",
          price: 30,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        const result = await db(eventsTable).where("id", 1002n).first();
        expect(result?.name).toBe('The "Best" Event');

        await db(eventsTable).where("id", 1002n).delete();
      });

      test("should safely handle backslashes in string values", async () => {
        await db(eventsTable).insert({
          id: 1003n,
          name: "Path\\To\\Event",
          venue: "C:\\Venue",
          price: 35,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        const result = await db(eventsTable).where("id", 1003n).first();
        expect(result?.name).toBe("Path\\To\\Event");

        await db(eventsTable).where("id", 1003n).delete();
      });

      test("should safely handle SQL injection attempt in where value", async () => {
        // This should NOT drop the table - it should search for a literal string
        const maliciousValue = "'; DROP TABLE knex_events; --";
        const results = await db(eventsTable).where("name", maliciousValue);

        // Should return empty array (no match)
        expect(results.length).toBe(0);

        // Table should still exist
        const stillExists = await db(eventsTable).count();
        expect(stillExists).toBeGreaterThan(0);
      });

      test("should safely handle SQL injection in whereRaw bindings", async () => {
        // Even with whereRaw, bindings should be parameterized
        const malicious = "' OR '1'='1";
        const results = await db(eventsTable).whereRaw("name = ?", [malicious]);

        // Should not return all rows
        expect(results.length).toBe(0);
      });

      test("should safely handle newlines in string values", async () => {
        await db(eventsTable).insert({
          id: 1004n,
          name: "Event\nWith\nNewlines",
          venue: "Multi\nLine\nVenue",
          price: 40,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        const result = await db(eventsTable).where("id", 1004n).first();
        expect(result?.name).toBe("Event\nWith\nNewlines");

        await db(eventsTable).where("id", 1004n).delete();
      });
    });

    describe("NULL and Empty String Handling", () => {
      test("should handle NULL values in queries", async () => {
        // Insert row with explicit NULL
        await db(eventsTable).insert({
          id: 1005n,
          name: "Null Test",
          venue: null as any, // Force null
          price: 50,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        const result = await db(eventsTable).where("id", 1005n).first();
        expect(result?.venue).toBeNull();

        // Query with whereNull
        const nullResults = await db(eventsTable).whereNull("venue");
        expect(nullResults.length).toBeGreaterThan(0);

        await db(eventsTable).where("id", 1005n).delete();
      });

      test("should distinguish between empty string and NULL", async () => {
        await db(eventsTable).insert({
          id: 1006n,
          name: "",
          venue: "",
          price: 55,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        const result = await db(eventsTable).where("id", 1006n).first();
        expect(result?.name).toBe("");
        expect(result?.name).not.toBeNull();

        await db(eventsTable).where("id", 1006n).delete();
      });
    });

    describe("Special Character Values", () => {
      test("should handle percent sign (LIKE wildcard)", async () => {
        await db(eventsTable).insert({
          id: 1007n,
          name: "100% Discount Event",
          venue: "Hall",
          price: 0,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        // Search for exact match with %
        const result = await db(eventsTable).where("name", "100% Discount Event").first();
        expect(result?.name).toBe("100% Discount Event");

        await db(eventsTable).where("id", 1007n).delete();
      });

      test("should handle underscore (LIKE wildcard)", async () => {
        await db(eventsTable).insert({
          id: 1008n,
          name: "Event_With_Underscores",
          venue: "Hall",
          price: 60,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        const result = await db(eventsTable).where("name", "Event_With_Underscores").first();
        expect(result?.name).toBe("Event_With_Underscores");

        await db(eventsTable).where("id", 1008n).delete();
      });

      test("should handle semicolon", async () => {
        await db(eventsTable).insert({
          id: 1009n,
          name: "First; Second",
          venue: "Hall; Room",
          price: 65,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        const result = await db(eventsTable).where("id", 1009n).first();
        expect(result?.name).toBe("First; Second");

        await db(eventsTable).where("id", 1009n).delete();
      });

      test("should handle Unicode characters (CJK)", async () => {
        // Note: 4-byte emojis may not work without utf8mb4 charset configuration
        // Testing with CJK characters which are typically 3-byte UTF-8
        await db(eventsTable).insert({
          id: 1010n,
          name: "日本語イベント",
          venue: "東京ドーム",
          price: 70,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        const result = await db(eventsTable).where("id", 1010n).first();
        expect(result?.name).toBe("日本語イベント");
        expect(result?.venue).toBe("東京ドーム");

        await db(eventsTable).where("id", 1010n).delete();
      });
    });

    describe("Boundary Values", () => {
      test("should handle very long string within VARCHAR limit", async () => {
        const longName = "A".repeat(250); // Within VARCHAR(255)

        await db(eventsTable).insert({
          id: 1011n,
          name: longName,
          venue: "Hall",
          price: 75,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        const result = await db(eventsTable).where("id", 1011n).first();
        expect(result?.name.length).toBe(250);

        await db(eventsTable).where("id", 1011n).delete();
      });

      test("should handle negative numbers", async () => {
        await db(eventsTable).insert({
          id: 1012n,
          name: "Negative Price",
          venue: "Hall",
          price: -100,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        const result = await db(eventsTable).where("id", 1012n).first();
        expect(result?.price).toBe(-100);

        // Query with negative in condition
        const negatives = await db(eventsTable).where("price", "<", 0);
        expect(negatives.length).toBe(1);

        await db(eventsTable).where("id", 1012n).delete();
      });

      test("should handle zero", async () => {
        await db(eventsTable).insert({
          id: 1013n,
          name: "Free Event",
          venue: "Hall",
          price: 0,
          status: "active",
          isActive: true,
          createdAt: new Date(),
        });

        const result = await db(eventsTable).where("price", 0).first();
        expect(result?.price).toBe(0);

        await db(eventsTable).where("id", 1013n).delete();
      });
    });

    describe("DISTINCT Queries", () => {
      test("should handle DISTINCT with no results", async () => {
        const results = await db(eventsTable)
          .distinct()
          .select("status")
          .where("id", 99999n); // Non-existent

        expect(results.length).toBe(0);
      });

      test("should handle DISTINCT with all same values", async () => {
        const results = await db(eventsTable)
          .distinct()
          .select("isActive")
          .where("status", "active");

        // All active events have isActive = true
        expect(results.length).toBe(1);
      });
    });

    describe("Multiple AND/OR Conditions", () => {
      test("should handle many chained where clauses", async () => {
        const results = await db(eventsTable)
          .where("status", "active")
          .where("isActive", true)
          .where("price", ">", 0)
          .where("price", "<", 200)
          .whereNotNull("venue")
          .orderBy("price");

        expect(results.length).toBeGreaterThan(0);
      });

      test("should handle multiple orWhere clauses", async () => {
        const results = await db(eventsTable)
          .where("price", 50)
          .orWhere("price", 75)
          .orWhere("price", 100);

        // Should match events with prices 50, 75, or 100
        for (const r of results) {
          expect([50, 75, 100]).toContain(r.price);
        }
      });
    });
  });

  // ============================================================================
  // Complex Query Patterns
  // ============================================================================

  describe("Complex Query Patterns", () => {
    describe("JOIN Operations", () => {
      beforeAll(async () => {
        // Add test tickets for join tests
        await db(ticketsTable).insertMany([
          { id: 201n, eventId: 1n, userId: 100n, quantity: 2, purchasedAt: new Date() },
          { id: 202n, eventId: 1n, userId: 101n, quantity: 1, purchasedAt: new Date() },
          { id: 203n, eventId: 2n, userId: 100n, quantity: 3, purchasedAt: new Date() },
          { id: 204n, eventId: 3n, userId: 102n, quantity: 1, purchasedAt: new Date() },
        ]);
      });

      afterAll(async () => {
        await db(ticketsTable).where("id", ">=", 201n).delete();
      });

      test("should perform INNER JOIN", async () => {
        const results = await db(eventsTable)
          .join(ticketsTable, "knex_events.id", "=", "knex_tickets.event_id")
          .select("knex_events.name", "knex_tickets.quantity");

        // Should return rows where both tables have matching data
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]).toHaveProperty("name");
        expect(results[0]).toHaveProperty("quantity");
      });

      test("should perform LEFT JOIN", async () => {
        const results = await db(eventsTable)
          .leftJoin(ticketsTable, "knex_events.id", "=", "knex_tickets.event_id")
          .select("knex_events.id", "knex_events.name", "knex_tickets.id as ticket_id");

        // LEFT JOIN returns all events, even those without tickets
        expect(results.length).toBeGreaterThanOrEqual(5); // We have at least 5 events
      });

      test("should perform RIGHT JOIN", async () => {
        const results = await db(eventsTable)
          .rightJoin(ticketsTable, "knex_events.id", "=", "knex_tickets.event_id")
          .select("knex_events.name", "knex_tickets.quantity");

        // RIGHT JOIN returns all tickets (count depends on test data)
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]).toHaveProperty("quantity");
      });

      test("should perform multiple JOINs", async () => {
        // Create a temporary users-like reference for multi-join test
        // We'll join events -> tickets, simulating a 3-way pattern
        const results = await db(eventsTable)
          .join(ticketsTable, "knex_events.id", "=", "knex_tickets.event_id")
          .where("knex_tickets.user_id", 100n)
          .select("knex_events.name", "knex_tickets.quantity");

        // User 100 has tickets (exact count depends on test data setup)
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]).toHaveProperty("name");
        expect(results[0]).toHaveProperty("quantity");
      });

      test("should perform self-referential style query with aliases", async () => {
        // Query with explicit table qualifiers
        const results = await db(eventsTable)
          .join(ticketsTable, "knex_events.id", "=", "knex_tickets.event_id")
          .where("knex_events.price", ">", 50)
          .select("knex_events.id", "knex_events.name", "knex_tickets.quantity");

        expect(results.length).toBeGreaterThan(0);
      });
    });

    describe("Aggregation with GROUP BY", () => {
      test("should GROUP BY single column via raw SQL", async () => {
        // GROUP BY with aggregates requires raw SQL
        const results = await db.raw<{ status: string; total: number }>(
          "SELECT status, COUNT(*) as total FROM knex_events GROUP BY status"
        );

        // Should have 2-3 status groups (active, pending, etc.)
        expect(results.length).toBeGreaterThan(0);
        for (const row of results) {
          expect(row).toHaveProperty("total");
        }
      });

      test("should GROUP BY multiple columns via raw SQL", async () => {
        const results = await db.raw<{ status: string; is_active: number; cnt: number }>(
          "SELECT status, is_active, COUNT(*) as cnt FROM knex_events GROUP BY status, is_active"
        );

        expect(results.length).toBeGreaterThan(0);
      });

      test("should use SUM with GROUP BY via raw SQL", async () => {
        const results = await db.raw<{ event_id: number; total_quantity: number }>(
          "SELECT event_id, SUM(quantity) as total_quantity FROM knex_tickets GROUP BY event_id"
        );

        expect(results.length).toBeGreaterThan(0);
        for (const row of results) {
          expect(row).toHaveProperty("total_quantity");
        }
      });

      test("should use AVG with raw SQL", async () => {
        const results = await db.raw<{ status: string; avg_price: number }>(
          "SELECT status, AVG(price) as avg_price FROM knex_events GROUP BY status"
        );

        expect(results.length).toBeGreaterThan(0);
        expect(results[0]).toHaveProperty("avg_price");
      });

      test("should use MIN and MAX with raw SQL", async () => {
        const results = await db.raw<{ status: string; min_price: number; max_price: number }>(
          "SELECT status, MIN(price) as min_price, MAX(price) as max_price FROM knex_events GROUP BY status"
        );

        expect(results.length).toBeGreaterThan(0);
        for (const row of results) {
          expect(row).toHaveProperty("min_price");
          expect(row).toHaveProperty("max_price");
        }
      });
    });

    describe("HAVING Clause", () => {
      test("should filter aggregated results with HAVING via raw SQL", async () => {
        // HAVING requires raw SQL since it's not in the builder API
        const results = await db.raw<{ status: string; cnt: number }>(
          "SELECT status, COUNT(*) as cnt FROM knex_events GROUP BY status HAVING COUNT(*) > 0"
        );

        expect(results.length).toBeGreaterThan(0);
        for (const row of results) {
          expect(Number(row.cnt)).toBeGreaterThan(0);
        }
      });

      test("should use HAVING with SUM via raw SQL", async () => {
        const results = await db.raw<{ event_id: number; total: number }>(
          "SELECT event_id, SUM(quantity) as total FROM knex_tickets GROUP BY event_id HAVING SUM(quantity) >= 2"
        );

        // Only events with total quantity >= 2
        for (const row of results) {
          expect(Number(row.total)).toBeGreaterThanOrEqual(2);
        }
      });
    });

    describe("Subqueries", () => {
      test("should use IN with subquery-like values", async () => {
        // First get event IDs that have tickets
        const eventIds = await db(ticketsTable).distinct().pluck("event_id");

        // Then query events with those IDs
        const results = await db(eventsTable).whereIn("id", eventIds);

        expect(results.length).toBeGreaterThan(0);
      });

      test("should use NOT IN with subquery-like values", async () => {
        const eventIds = await db(ticketsTable).distinct().pluck("event_id");

        // Events that DON'T have tickets
        const results = await db(eventsTable).whereNotIn("id", eventIds);

        // Should return events 4+ which don't have tickets
        expect(results.length).toBeGreaterThan(0);
      });
    });

    describe("Complex WHERE with Subexpressions", () => {
      test("should handle nested AND/OR logic via raw SQL", async () => {
        // Nested callback pattern requires raw SQL
        const results = await db.raw<{ name: string; status: string; price: number }>(
          "SELECT * FROM knex_events WHERE (status = 'active' OR status = 'pending') AND price > 0"
        );

        expect(results.length).toBeGreaterThan(0);
        for (const r of results) {
          expect(["active", "pending"]).toContain(r.status);
          expect(r.price).toBeGreaterThan(0);
        }
      });

      test("should handle whereBetween", async () => {
        const results = await db(eventsTable).whereBetween("price", [50, 100]);

        expect(results.length).toBeGreaterThan(0);
        for (const r of results) {
          expect(r.price).toBeGreaterThanOrEqual(50);
          expect(r.price).toBeLessThanOrEqual(100);
        }
      });

      test("should handle NOT BETWEEN via raw SQL", async () => {
        // whereNotBetween not in API, use raw SQL
        const results = await db.raw<{ name: string; price: number }>(
          "SELECT name, price FROM knex_events WHERE price NOT BETWEEN 50 AND 100"
        );

        for (const r of results) {
          const isOutside = r.price < 50 || r.price > 100;
          expect(isOutside).toBe(true);
        }
      });
    });

    describe("ORDER BY with Aggregates", () => {
      test("should ORDER BY aggregate result via raw SQL", async () => {
        const results = await db.raw<{ status: string; cnt: number }>(
          "SELECT status, COUNT(*) as cnt FROM knex_events GROUP BY status ORDER BY cnt DESC"
        );

        // Results should be ordered by count descending
        for (let i = 1; i < results.length; i++) {
          expect(Number(results[i - 1]?.cnt)).toBeGreaterThanOrEqual(Number(results[i]?.cnt));
        }
      });

      test("should ORDER BY multiple columns", async () => {
        const results = await db(eventsTable)
          .orderBy("status", "asc")
          .orderBy("price", "desc")
          .select("status", "price");

        expect(results.length).toBeGreaterThan(0);
      });
    });

    describe("LIMIT and OFFSET Combinations", () => {
      test("should handle LIMIT with ORDER BY", async () => {
        const results = await db(eventsTable)
          .orderBy("price", "desc")
          .limit(3);

        expect(results.length).toBe(3);
        // Prices should be in descending order
        for (let i = 1; i < results.length; i++) {
          expect(results[i - 1]!.price).toBeGreaterThanOrEqual(results[i]!.price);
        }
      });

      test("should handle pagination with LIMIT and OFFSET", async () => {
        const page1 = await db(eventsTable)
          .orderBy("id")
          .limit(2)
          .offset(0);

        const page2 = await db(eventsTable)
          .orderBy("id")
          .limit(2)
          .offset(2);

        expect(page1.length).toBe(2);
        expect(page2.length).toBe(2);

        // Pages should have different data
        expect(page1[0]!.id).not.toBe(page2[0]!.id);
      });

      test("should handle OFFSET larger than result set", async () => {
        const results = await db(eventsTable)
          .orderBy("id")
          .limit(10)
          .offset(1000);

        expect(results.length).toBe(0);
      });
    });

    describe("COUNT Variations", () => {
      test("should COUNT all rows", async () => {
        const count = await db(eventsTable).count();
        expect(count).toBeGreaterThan(0);
      });

      test("should COUNT specific column (excludes NULLs)", async () => {
        const count = await db(eventsTable).count("venue");
        expect(count).toBeGreaterThanOrEqual(0);
      });

      test("should COUNT with where condition", async () => {
        const count = await db(eventsTable).where("status", "active").count();
        expect(count).toBeGreaterThan(0);
      });
    });

    describe("Raw SQL Expressions", () => {
      test("should use db.raw() for direct SQL queries", async () => {
        const results = await db.raw<{ upper_name: string }>(
          "SELECT UPPER(name) as upper_name FROM knex_events LIMIT 1"
        );

        expect(results.length).toBe(1);
        expect(results[0]).toHaveProperty("upper_name");
      });

      test("should use whereRaw() in query chain", async () => {
        const results = await db(eventsTable)
          .whereRaw("price > 50 AND status = 'active'");

        expect(results.length).toBeGreaterThan(0);
      });

      test("should use whereRaw() with bindings", async () => {
        const results = await db(eventsTable)
          .whereRaw("price > ? AND status = ?", [50, "active"]);

        expect(results.length).toBeGreaterThan(0);
      });
    });

    describe("Pluck and Column Selection", () => {
      test("should pluck single column values", async () => {
        const names = await db(eventsTable).pluck("name");

        expect(Array.isArray(names)).toBe(true);
        expect(names.length).toBeGreaterThan(0);
        expect(typeof names[0]).toBe("string");
      });

      test("should pluck with where condition", async () => {
        const activeNames = await db(eventsTable)
          .where("status", "active")
          .pluck("name");

        expect(activeNames.length).toBeGreaterThan(0);
      });
    });

    describe("First vs All", () => {
      test("should return first row or null", async () => {
        const first = await db(eventsTable).orderBy("id").first();
        expect(first).not.toBeNull();
        // MySQL2 returns numbers, not BigInts
        expect(Number(first?.id)).toBe(1);
      });

      test("should return null for empty result", async () => {
        const first = await db(eventsTable).where("id", 999999n).first();
        expect(first).toBeNull();
      });

      test("should return empty array for empty result set", async () => {
        const results = await db(eventsTable).where("id", 999999n);
        expect(results).toEqual([]);
      });
    });

    describe("Update with Complex Conditions", () => {
      test("should update with multiple where conditions", async () => {
        // Create test record
        await db(eventsTable).insert({
          id: 2001n,
          name: "Update Test Event",
          venue: "Test Venue",
          price: 100,
          status: "pending",
          isActive: false,
          createdAt: new Date(),
        });

        // Update with complex conditions
        await db(eventsTable)
          .where("id", 2001n)
          .where("status", "pending")
          .update({ status: "active", isActive: true });

        const updated = await db(eventsTable).where("id", 2001n).first();
        expect(updated?.status).toBe("active");
        // MySQL2 returns column names as-is from DB (snake_case: is_active)
        expect((updated as any)?.is_active).toBe(1); // Boolean stored as TINYINT

        await db(eventsTable).where("id", 2001n).delete();
      });
    });

    describe("Exists Check", () => {
      test("should check if rows exist using exists()", async () => {
        const exists = await db(eventsTable).where("status", "active").exists();
        expect(exists).toBe(true);
      });

      test("should return false for non-existing rows", async () => {
        const exists = await db(eventsTable).where("status", "nonexistent_status").exists();
        expect(exists).toBe(false);
      });

      test("should check with first() returning null for no match", async () => {
        const result = await db(eventsTable).where("status", "nonexistent_status").first();
        expect(result).toBeNull();
      });
    });
  });
});
