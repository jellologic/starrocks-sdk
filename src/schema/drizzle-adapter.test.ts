/**
 * Tests for StarRocks → Drizzle ORM adapter
 */

import { describe, it, expect } from "vitest";
import { toDrizzle } from "./drizzle-adapter";
import { starrocksTable, primaryKey, hash } from "./table";
import {
  varchar,
  bigint,
  int,
  smallint,
  tinyint,
  boolean,
  datetime,
  date,
  double,
  float,
  decimal,
  json,
  string,
  char,
} from "./columns";
import { getTableName, getTableColumns } from "drizzle-orm";

// ============================================================================
// Test Tables
// ============================================================================

const userTable = starrocksTable(
  "user",
  {
    id: varchar("id", { length: 36 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: varchar("image", { length: 65533 }), // TEXT equivalent
    role: varchar("role", { length: 20 }).notNull().default("user"),
    banned: boolean("banned").default(false),
    createdAt: datetime("created_at").notNull(),
  },
  (t) => ({
    pk: primaryKey(t.id),
    distribution: hash(t.id, { buckets: 4 }),
  }),
);

const eventsTable = starrocksTable(
  "vivid_events",
  {
    id: bigint("id").notNull(),
    name: varchar("name", { length: 500 }),
    venueId: int("venue_id"),
    categoryId: smallint("category_id"),
    active: tinyint("active"),
    latitude: double("latitude"),
    longitude: float("longitude"),
    price: decimal("price", { precision: 10, scale: 2 }),
    metadata: json("metadata"),
    eventDate: date("event_date"),
    notes: string("notes"),
    code: char("code", { length: 10 }),
    updatedAt: datetime("updated_at"),
  },
  (t) => ({
    pk: primaryKey(t.id),
    distribution: hash(t.id, { buckets: 8 }),
  }),
);

// ============================================================================
// Basic conversion tests
// ============================================================================

describe("toDrizzle", () => {
  it("converts table name correctly", () => {
    const drizzleUser = toDrizzle(userTable);
    expect(getTableName(drizzleUser)).toBe("user");
  });

  it("converts events table name correctly", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    expect(getTableName(drizzleEvents)).toBe("vivid_events");
  });

  it("creates all columns", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    const columnNames = Object.keys(columns);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("email");
    expect(columnNames).toContain("emailVerified");
    expect(columnNames).toContain("image");
    expect(columnNames).toContain("role");
    expect(columnNames).toContain("banned");
    expect(columnNames).toContain("createdAt");
    expect(columnNames.length).toBe(8);
  });

  it("preserves column SQL names", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    expect(columns.id.name).toBe("id");
    expect(columns.emailVerified.name).toBe("email_verified");
    expect(columns.createdAt.name).toBe("created_at");
  });
});

// ============================================================================
// NOT NULL mapping
// ============================================================================

describe("toDrizzle — NOT NULL", () => {
  it("maps notNull columns", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    expect(columns.id.notNull).toBe(true);
    expect(columns.name.notNull).toBe(true);
    expect(columns.email.notNull).toBe(true);
    expect(columns.emailVerified.notNull).toBe(true);
    expect(columns.role.notNull).toBe(true);
    expect(columns.createdAt.notNull).toBe(true);
  });

  it("maps nullable columns", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    expect(columns.image.notNull).toBe(false);
    expect(columns.banned.notNull).toBe(false);
  });
});

// ============================================================================
// Default values
// ============================================================================

describe("toDrizzle — defaults", () => {
  it("maps default values", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    expect(columns.emailVerified.hasDefault).toBe(true);
    expect(columns.role.hasDefault).toBe(true);
    expect(columns.banned.hasDefault).toBe(true);
  });

  it("columns without defaults have hasDefault=false", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    expect(columns.id.hasDefault).toBe(false);
    expect(columns.name.hasDefault).toBe(false);
    expect(columns.createdAt.hasDefault).toBe(false);
  });
});

// ============================================================================
// Primary key
// ============================================================================

describe("toDrizzle — primary key", () => {
  it("marks primary key column", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    expect(columns.id.primary).toBe(true);
  });

  it("non-pk columns are not primary", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    expect(columns.name.primary).toBe(false);
    expect(columns.email.primary).toBe(false);
  });
});

// ============================================================================
// Column type mapping
// ============================================================================

describe("toDrizzle — column types", () => {
  it("maps VARCHAR to varchar", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    // The column should be a varchar type
    expect(columns.id.columnType).toBe("MySqlVarChar");
  });

  it("maps VARCHAR(65533) to text (StarRocks TEXT equivalent)", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    // image is VARCHAR(65533) in StarRocks → text in Drizzle
    expect(columns.image.columnType).toBe("MySqlText");
  });

  it("maps BOOLEAN to boolean", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    expect(columns.emailVerified.columnType).toBe("MySqlBoolean");
  });

  it("maps DATETIME to datetime", () => {
    const drizzleUser = toDrizzle(userTable);
    const columns = getTableColumns(drizzleUser);
    expect(columns.createdAt.columnType).toBe("MySqlDateTime");
  });

  it("maps BIGINT to bigint", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    const columns = getTableColumns(drizzleEvents);
    expect(columns.id.columnType).toBe("MySqlBigInt64");
  });

  it("maps INT to int", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    const columns = getTableColumns(drizzleEvents);
    expect(columns.venueId.columnType).toBe("MySqlInt");
  });

  it("maps SMALLINT to smallint", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    const columns = getTableColumns(drizzleEvents);
    expect(columns.categoryId.columnType).toBe("MySqlSmallInt");
  });

  it("maps TINYINT to tinyint", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    const columns = getTableColumns(drizzleEvents);
    expect(columns.active.columnType).toBe("MySqlTinyInt");
  });

  it("maps DOUBLE to double", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    const columns = getTableColumns(drizzleEvents);
    expect(columns.latitude.columnType).toBe("MySqlDouble");
  });

  it("maps FLOAT to float", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    const columns = getTableColumns(drizzleEvents);
    expect(columns.longitude.columnType).toBe("MySqlFloat");
  });

  it("maps DECIMAL to decimal", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    const columns = getTableColumns(drizzleEvents);
    expect(columns.price.columnType).toBe("MySqlDecimal");
  });

  it("maps JSON to json", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    const columns = getTableColumns(drizzleEvents);
    expect(columns.metadata.columnType).toBe("MySqlJson");
  });

  it("maps DATE to date", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    const columns = getTableColumns(drizzleEvents);
    expect(columns.eventDate.columnType).toBe("MySqlDate");
  });

  it("maps STRING to text", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    const columns = getTableColumns(drizzleEvents);
    expect(columns.notes.columnType).toBe("MySqlText");
  });

  it("maps CHAR to char", () => {
    const drizzleEvents = toDrizzle(eventsTable);
    const columns = getTableColumns(drizzleEvents);
    expect(columns.code.columnType).toBe("MySqlChar");
  });
});

// ============================================================================
// Table without config
// ============================================================================

describe("toDrizzle — edge cases", () => {
  it("handles table with no key config", () => {
    const simple = starrocksTable("simple", {
      id: int("id").notNull(),
      value: varchar("value", { length: 100 }),
    });
    const drizzle = toDrizzle(simple);
    const columns = getTableColumns(drizzle);
    // No primary key applied
    expect(columns.id.primary).toBe(false);
    expect(columns.value.primary).toBe(false);
  });

  it("returns valid Drizzle table object", () => {
    const drizzleUser = toDrizzle(userTable);
    // Should have the core Drizzle table shape
    expect(getTableName(drizzleUser)).toBeDefined();
    expect(getTableColumns(drizzleUser)).toBeDefined();
  });

  it("column access works on returned table", () => {
    const drizzleUser = toDrizzle(userTable);
    // Should be able to access columns directly
    expect(drizzleUser.id).toBeDefined();
    expect(drizzleUser.name).toBeDefined();
    expect(drizzleUser.email).toBeDefined();
  });
});
