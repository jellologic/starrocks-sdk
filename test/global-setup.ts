/**
 * Bun test preload script — auto-manages a StarRocks Docker container.
 *
 * 1. Finds 3 free TCP ports.
 * 2. Starts `starrocks/allin1-ubuntu` with those ports mapped to 9030/8030/8040.
 * 3. Polls MySQL readiness (up to ~120 s).
 * 4. Sets process.env so test-config.ts picks them up.
 * 5. Tears down the container on exit / SIGINT / SIGTERM.
 */

import net from "node:net";
import { execSync } from "node:child_process";
import mysql from "mysql2/promise";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a free TCP port by briefly binding to port 0. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("Could not determine port")));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Wait until MySQL on `host:port` answers `SELECT 1`. */
async function waitForMySQL(
  host: string,
  port: number,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const intervalMs = 2_000;

  while (Date.now() < deadline) {
    try {
      const conn = await mysql.createConnection({
        host,
        port,
        user: "root",
        connectTimeout: 3_000,
      });
      await conn.execute("SELECT 1");
      await conn.end();
      return;
    } catch {
      // Not ready yet — wait and retry.
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(
    `StarRocks MySQL not ready on ${host}:${port} after ${timeoutMs / 1000}s`,
  );
}

// ---------------------------------------------------------------------------
// Main setup
// ---------------------------------------------------------------------------

const suffix = Math.random().toString(36).slice(2, 8);
const containerName = `starrocks-test-${suffix}`;

const [mysqlPort, feHttpPort, beHttpPort] = await Promise.all([
  getFreePort(),
  getFreePort(),
  getFreePort(),
]);

console.log(
  `[global-setup] Starting ${containerName}  mysql=${mysqlPort} fe-http=${feHttpPort} be-http=${beHttpPort}`,
);

// Start the container (detached).
execSync(
  [
    "docker run -d",
    `--name ${containerName}`,
    `-p ${mysqlPort}:9030`,
    `-p ${feHttpPort}:8030`,
    `-p ${beHttpPort}:8040`,
    "starrocks/allin1-ubuntu",
  ].join(" "),
  { stdio: "pipe" },
);

// ---------------------------------------------------------------------------
// Cleanup handler — remove the container no matter what.
// ---------------------------------------------------------------------------
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  console.log(`[global-setup] Removing container ${containerName}`);
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: "pipe" });
  } catch {
    // best-effort
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

// ---------------------------------------------------------------------------
// Wait for readiness, then expose ports via env vars.
// ---------------------------------------------------------------------------
console.log("[global-setup] Waiting for StarRocks to become ready…");
await waitForMySQL("127.0.0.1", mysqlPort);
console.log("[global-setup] StarRocks is ready!");

process.env.STARROCKS_TEST_PORT = String(mysqlPort);
process.env.STARROCKS_TEST_HTTP_PORT = String(feHttpPort);
process.env.STARROCKS_TEST_BE_HTTP_PORT = String(beHttpPort);
