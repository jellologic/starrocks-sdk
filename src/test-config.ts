import type { StarRocksConfig } from "./types";

// Test config uses different port (19030) for isolated testing
// Production uses standard port (9030)
export const testConfig: StarRocksConfig = {
  host: process.env.STARROCKS_TEST_HOST ?? "127.0.0.1",
  port: Number(process.env.STARROCKS_TEST_PORT ?? 19030),
  user: process.env.STARROCKS_TEST_USER ?? "root",
  password: process.env.STARROCKS_TEST_PASSWORD ?? "",
  database: process.env.STARROCKS_TEST_DATABASE,
};

export const TEST_DATABASE = "starrocks_test";
