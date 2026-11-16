import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export function pgBinaries() {
  const directory = execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
  const version = execFileSync(join(directory, "pg_ctl"), ["--version"], { encoding: "utf8" });
  if (!version.includes(" 16.")) throw new Error("PostgreSQL 16 is required");
  return directory;
}
export function initializeCluster(directory) {
  const binaries = pgBinaries();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const data = join(directory, "data");
  const socket = join(directory, "socket");
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  if (!existsSync(join(data, "PG_VERSION"))) {
    execFileSync(
      join(binaries, "initdb"),
      ["-D", data, "--username=soldbench", "--auth-local=trust", "--encoding=UTF8", "--no-locale"],
      { stdio: "pipe" },
    );
  }
  const configuration = { directory, data, socket, port: 55439, binaries };
  return configuration;
}
export function startCluster(config) {
  try {
    execFileSync(join(config.binaries, "pg_ctl"), ["-D", config.data, "status"], { stdio: "pipe" });
    return;
  } catch {
    /* This cluster is currently stopped. */
  }
  execFileSync(
    join(config.binaries, "pg_ctl"),
    [
      "-D",
      config.data,
      "-l",
      join(config.directory, "postgres.log"),
      "-o",
      `-k ${config.socket} -p ${config.port} -h ''`,
      "-w",
      "start",
    ],
    { stdio: "pipe" },
  );
}
export function stopCluster(config) {
  execFileSync(join(config.binaries, "pg_ctl"), ["-D", config.data, "-m", "fast", "-w", "stop"], {
    stdio: "pipe",
  });
}
export function urlFor(config, name) {
  const url = new URL(`postgresql://soldbench@localhost/${name}`);
  url.searchParams.set("host", config.socket);
  url.searchParams.set("port", String(config.port));
  return url.href;
}
export function localDatabaseUrl() {
  const path = join(root, ".local/database.json");
  if (!existsSync(path)) throw new Error("Run npm run db:start first, or set DATABASE_URL");
  return JSON.parse(readFileSync(path, "utf8")).url;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = initializeCluster(join(root, ".local/postgres"));
  const command = process.argv[2] ?? "start";
  if (command === "stop") stopCluster(config);
  else if (command === "start") {
    startCluster(config);
    try {
      execFileSync(
        join(config.binaries, "createdb"),
        ["-h", config.socket, "-p", String(config.port), "-U", "soldbench", "soldbench"],
        { stdio: "pipe" },
      );
    } catch (error) {
      if (!String(error.stderr).includes("already exists")) throw error;
    }
    writeFileSync(
      join(root, ".local/database.json"),
      `${JSON.stringify({ url: urlFor(config, "soldbench") })}\n`,
      { mode: 0o600 },
    );
    console.log("Local PostgreSQL 16 is ready. Run npm run db:migrate, then npm run dev.");
  } else throw new Error("Use start or stop");
}
