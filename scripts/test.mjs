import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCluster, startCluster, stopCluster, urlFor } from "./local-db.mjs";

const tests = readdirSync("tests")
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => `tests/${name}`);
const selected = process.argv.slice(2);
if (selected.some((file) => !tests.includes(file))) throw new Error("unknown_test_file");
const directory = mkdtempSync(join(tmpdir(), "soldbench-product-test-"));
const config = initializeCluster(directory);
startCluster(config);
let complete = false;
try {
  for (const [index, test] of (selected.length ? selected : tests).entries()) {
    const name = `soldbench_test_${index}`;
    execFileSync(join(config.binaries, "createdb"), [
      "-h",
      config.socket,
      "-p",
      String(config.port),
      "-U",
      "soldbench",
      name,
    ]);
    const result = spawnSync(process.execPath, ["--import", "./scripts/test-network.mjs", "--test", test], {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: urlFor(config, name),
        SOLDBENCH_TEST_SOCKET: config.socket,
        COLLECTOR_ENABLED: "false",
        DATA_MODE: "offline_fixture",
        PAYMENTS_MODE: "offline",
      },
    });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
  complete = !process.exitCode;
} finally {
  stopCluster(config);
  if (complete && process.env.SOLDBENCH_KEEP_TEST_DATABASES !== "true")
    rmSync(config.data, { recursive: true });
  console.log(`Isolated test evidence retained at ${directory}`);
}
