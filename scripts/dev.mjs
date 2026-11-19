import { spawn } from "node:child_process";
import { localDatabaseUrl } from "./local-db.mjs";

const childOptions = {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? localDatabaseUrl() },
};
const api = spawn(process.execPath, ["apps/api/dist/server.js"], childOptions);
let worker;
let restartTimer;
let restartAttempts = 0;
let stopping = false;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  api.kill(signal);
  worker?.kill(signal);
  setTimeout(() => {
    api.kill("SIGKILL");
    worker?.kill("SIGKILL");
  }, 5000).unref();
}

function startWorker() {
  const started = performance.now();
  worker = spawn(process.execPath, ["scripts/query-worker.mjs", "--watch"], childOptions);
  worker.on("error", () => console.error("soldbench_query_worker_spawn_failed"));
  worker.once("spawn", () => console.log(JSON.stringify({ event: "query_worker_started", pid: worker.pid })));
  worker.once("close", (code, signal) => {
    worker = undefined;
    if (stopping) return;
    if (performance.now() - started >= 60000) restartAttempts = 0;
    const delay = restartAttempts < 3 ? 1000 * 2 ** restartAttempts : null;
    console.error(JSON.stringify({ event: "query_worker_exited", code, signal, restart_ms: delay }));
    if (delay === null) return;
    restartAttempts++;
    restartTimer = setTimeout(startWorker, delay);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
api.on("error", () => console.error("soldbench_api_spawn_failed"));
api.once("close", (code) => {
  if (!stopping) process.exitCode = code || 1;
  stop("SIGTERM");
});
startWorker();
