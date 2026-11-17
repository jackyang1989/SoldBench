import { spawn } from "node:child_process";
import { localDatabaseUrl } from "./local-db.mjs";

const child = spawn(process.execPath, ["apps/api/dist/server.js"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? localDatabaseUrl() },
});
const worker = spawn(process.execPath, ["scripts/query-worker.mjs", "--watch"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? localDatabaseUrl() },
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    child.kill(signal);
    worker.kill(signal);
  });
child.on("exit", (code) => {
  worker.kill("SIGTERM");
  process.exitCode = code ?? 1;
});

worker.on("exit", (code) => {
  if (code && !child.killed) child.kill("SIGTERM");
});
