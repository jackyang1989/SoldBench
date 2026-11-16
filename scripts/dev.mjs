import { spawn } from "node:child_process";
import { localDatabaseUrl } from "./local-db.mjs";

const child = spawn(process.execPath, ["apps/api/dist/server.js"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? localDatabaseUrl() },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
