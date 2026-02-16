import type { StarRocksConfig } from "./types";

// Test config — ports are set by the preload script (test/global-setup.ts)
// which starts a Docker container with random ports.
export const testConfig: StarRocksConfig = {
  host: process.env.STARROCKS_TEST_HOST ?? "127.0.0.1",
  port: Number(process.env.STARROCKS_TEST_PORT ?? 19030),
  user: process.env.STARROCKS_TEST_USER ?? "root",
  password: process.env.STARROCKS_TEST_PASSWORD ?? "",
  database: process.env.STARROCKS_TEST_DATABASE,
};

/** FE HTTP port (8030 inside the container). */
export const httpPort = Number(process.env.STARROCKS_TEST_HTTP_PORT ?? 18030);

/** BE HTTP port (8040 inside the container). Use this for Stream Load / 2PC
 *  to avoid the FE→BE redirect that exposes the container-internal port. */
export const beHttpPort = Number(process.env.STARROCKS_TEST_BE_HTTP_PORT ?? 18040);

export const TEST_DATABASE = "starrocks_test";
