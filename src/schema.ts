/**
 * StarRocks-compatible Drizzle schema helpers
 *
 * StarRocks is MySQL-compatible, so we use drizzle-orm/mysql-core
 * but provide additional helpers for StarRocks-specific features
 */

export {
  mysqlTable,
  varchar,
  text,
  int,
  bigint,
  smallint,
  tinyint,
  boolean,
  timestamp,
  datetime,
  date,
  decimal,
  float,
  double,
  json,
  index,
  primaryKey,
  unique,
} from "drizzle-orm/mysql-core";

export { relations, sql, eq, and, or, gt, gte, lt, lte, ne, like, inArray, notInArray, isNull, isNotNull, asc, desc, count, sum, avg, min, max } from "drizzle-orm";
