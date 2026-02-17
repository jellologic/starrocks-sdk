import { describe, test, expect } from "bun:test";
import {
  escapeString,
  quoteString,
  escapeDoubleQuoted,
  quoteIdentifier,
  validateIdentifier,
  validatePartitionName,
  validateIntervalUnit,
  validatePositiveInteger,
  formatDefaultValue,
} from "../src/schema/index";

describe("escapeString", () => {
  test("escapes single quotes", () => {
    expect(escapeString("test's value")).toBe("test''s value");
  });

  test("escapes backslashes", () => {
    expect(escapeString("back\\slash")).toBe("back\\\\slash");
  });

  test("escapes both quotes and backslashes", () => {
    expect(escapeString("it's a \\test")).toBe("it''s a \\\\test");
  });

  test("returns empty string unchanged", () => {
    expect(escapeString("")).toBe("");
  });

  test("returns plain string unchanged", () => {
    expect(escapeString("hello world")).toBe("hello world");
  });

  test("handles multiple single quotes", () => {
    expect(escapeString("it's Bob's")).toBe("it''s Bob''s");
  });
});

describe("quoteString", () => {
  test("wraps in single quotes", () => {
    expect(quoteString("hello")).toBe("'hello'");
  });

  test("escapes inner quotes and wraps", () => {
    expect(quoteString("test's value")).toBe("'test''s value'");
  });

  test("wraps empty string", () => {
    expect(quoteString("")).toBe("''");
  });
});

describe("escapeDoubleQuoted", () => {
  test("escapes double quotes", () => {
    expect(escapeDoubleQuoted('test"value')).toBe('test""value');
  });

  test("escapes backslashes", () => {
    expect(escapeDoubleQuoted("back\\slash")).toBe("back\\\\slash");
  });

  test("escapes both", () => {
    expect(escapeDoubleQuoted('a"b\\c')).toBe('a""b\\\\c');
  });
});

describe("quoteIdentifier", () => {
  test("wraps in backticks", () => {
    expect(quoteIdentifier("my_table")).toBe("`my_table`");
  });

  test("wraps hyphenated name", () => {
    expect(quoteIdentifier("my-table")).toBe("`my-table`");
  });

  test("escapes inner backticks by doubling them", () => {
    expect(quoteIdentifier("table`name")).toBe("`table``name`");
  });

  test("handles empty string", () => {
    expect(quoteIdentifier("")).toBe("``");
  });
});

describe("validateIdentifier", () => {
  test("accepts valid identifier", () => {
    expect(() => validateIdentifier("my_table")).not.toThrow();
  });

  test("accepts identifier starting with underscore", () => {
    expect(() => validateIdentifier("_private")).not.toThrow();
  });

  test("accepts identifier with hyphens", () => {
    expect(() => validateIdentifier("my-table")).not.toThrow();
  });

  test("rejects identifier starting with number", () => {
    expect(() => validateIdentifier("123bad")).toThrow("Invalid");
  });

  test("rejects empty string", () => {
    expect(() => validateIdentifier("")).toThrow("Invalid");
  });

  test("rejects identifier with spaces", () => {
    expect(() => validateIdentifier("my table")).toThrow("Invalid");
  });

  test("rejects identifier with special characters", () => {
    expect(() => validateIdentifier("table;drop")).toThrow("Invalid");
  });

  test("includes custom type name in error", () => {
    expect(() => validateIdentifier("123", "column name")).toThrow("Invalid column name");
  });
});

describe("validatePartitionName", () => {
  test("accepts valid partition name", () => {
    expect(() => validatePartitionName("p2024")).not.toThrow();
  });

  test("rejects invalid partition name", () => {
    expect(() => validatePartitionName("123invalid")).toThrow("partition name");
  });
});

describe("validateIntervalUnit", () => {
  test("accepts SECOND", () => {
    expect(() => validateIntervalUnit("SECOND")).not.toThrow();
  });

  test("accepts MINUTE", () => {
    expect(() => validateIntervalUnit("MINUTE")).not.toThrow();
  });

  test("accepts HOUR", () => {
    expect(() => validateIntervalUnit("HOUR")).not.toThrow();
  });

  test("accepts DAY", () => {
    expect(() => validateIntervalUnit("DAY")).not.toThrow();
  });

  test("accepts WEEK", () => {
    expect(() => validateIntervalUnit("WEEK")).not.toThrow();
  });

  test("accepts MONTH", () => {
    expect(() => validateIntervalUnit("MONTH")).not.toThrow();
  });

  test("accepts YEAR", () => {
    expect(() => validateIntervalUnit("YEAR")).not.toThrow();
  });

  test("accepts lowercase", () => {
    expect(() => validateIntervalUnit("day")).not.toThrow();
  });

  test("rejects invalid unit", () => {
    expect(() => validateIntervalUnit("INVALID")).toThrow("Invalid interval unit");
  });

  test("rejects empty string", () => {
    expect(() => validateIntervalUnit("")).toThrow("Invalid interval unit");
  });
});

describe("validatePositiveInteger", () => {
  test("accepts positive integer", () => {
    expect(() => validatePositiveInteger(1, "buckets")).not.toThrow();
  });

  test("accepts large positive integer", () => {
    expect(() => validatePositiveInteger(1000, "buckets")).not.toThrow();
  });

  test("rejects zero", () => {
    expect(() => validatePositiveInteger(0, "buckets")).toThrow("positive integer");
  });

  test("rejects negative number", () => {
    expect(() => validatePositiveInteger(-1, "buckets")).toThrow("positive integer");
  });

  test("rejects non-integer", () => {
    expect(() => validatePositiveInteger(1.5, "buckets")).toThrow("positive integer");
  });

  test("includes field name in error", () => {
    expect(() => validatePositiveInteger(0, "replication_num")).toThrow("replication_num");
  });
});

describe("formatDefaultValue", () => {
  test("formats null as NULL", () => {
    expect(formatDefaultValue(null)).toBe("NULL");
  });

  test("formats true as SQL keyword", () => {
    expect(formatDefaultValue(true)).toBe("TRUE");
  });

  test("formats false as SQL keyword", () => {
    expect(formatDefaultValue(false)).toBe("FALSE");
  });

  test("formats number as string", () => {
    expect(formatDefaultValue(42)).toBe("42");
  });

  test("formats float as string", () => {
    expect(formatDefaultValue(3.14)).toBe("3.14");
  });

  test("formats CURRENT_TIMESTAMP as SQL keyword", () => {
    expect(formatDefaultValue("CURRENT_TIMESTAMP")).toBe("CURRENT_TIMESTAMP");
  });

  test("formats NOW() as SQL keyword", () => {
    expect(formatDefaultValue("NOW()")).toBe("NOW()");
  });

  test("formats regular string as quoted string", () => {
    expect(formatDefaultValue("hello")).toBe("'hello'");
  });

  test("formats string with quotes", () => {
    expect(formatDefaultValue("it's")).toBe("'it''s'");
  });

  test("throws for unsupported types", () => {
    expect(() => formatDefaultValue({ key: "val" })).toThrow("Unsupported default value type");
  });

  test("throws for undefined", () => {
    expect(() => formatDefaultValue(undefined)).toThrow("Unsupported default value type");
  });
});
