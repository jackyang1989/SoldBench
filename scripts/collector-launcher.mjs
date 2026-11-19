import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@soldbench/shared";

/** Deliberately excludes payment/session/API keys and Node preload overrides. */
export function workerEnvironment(input) {
  const result = { COLLECTOR_ENABLED: "false", DATA_MODE: "offline_fixture", PAYMENTS_MODE: "offline" };
  for (const key of [
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "DATABASE_URL",
    "COLLECTOR_DEMO_DIR",
    "MEDIA_ROOT",
    "SOLDBENCH_TEST_SOCKET",
  ])
    if (input[key] !== undefined) result[key] = input[key];
  return result;
}
export async function launchCollector(args, input = process.env, signal) {
  signal?.throwIfAborted();
  loadConfig(input);
  const options = new Map();
  for (const raw of args) {
    const match = /^--(fixture|max-ms|grace-ms|heap-mb|max-pages|media-only|expected-job)=(.+)$/.exec(raw);
    if (!match || options.has(match[1])) throw new Error("invalid_collector_launcher_argument");
    options.set(match[1], match[2]);
  }
  if (options.has("media-only") && (options.get("media-only") !== "true" || options.has("max-pages")))
    throw new Error("invalid_collector_media_option");
  const path = options.get("fixture");
  if (!path) throw new Error("fixture_artifact_path_required");
  function number(key, fallback, min, max) {
    const raw = options.get(key) ?? String(fallback),
      value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error("invalid_collector_launcher_limit");
    return value;
  }
  const maxMs = number("max-ms", 60000, 100, 3600000),
    graceMs = number("grace-ms", 2000, 100, 5000),
    heapMb = number("heap-mb", 192, 64, 512),
    maxPages = options.has("max-pages") ? number("max-pages", 1, 1, 1000) : undefined;
  const worker = fileURLToPath(new URL("./collector-worker.mjs", import.meta.url)),
    start = performance.now(),
    detached = process.platform !== "win32";
  const child = spawn(
    process.execPath,
    [
      `--max-old-space-size=${heapMb}`,
      worker,
      `--fixture=${path}`,
      ...(options.has("expected-job") ? [`--expected-job=${options.get("expected-job")}`] : []),
      ...(options.has("media-only") ? ["--media-only=true"] : []),
      ...(maxPages === undefined ? [] : [`--max-pages=${maxPages}`]),
    ],
    {
      env: workerEnvironment(input),
      detached,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let timedOut = false,
    interrupted = null,
    killTimer,
    finished = false,
    output = "",
    errors = "";
  const send = (signal) => {
    if (finished || !child.pid) return;
    try {
      if (detached) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const stop = () => {
    send("SIGTERM");
    killTimer ??= setTimeout(() => send("SIGKILL"), graceMs);
  };
  const onTerm = () => {
      interrupted ??= "SIGTERM";
      stop();
    },
    onInt = () => {
      interrupted ??= "SIGINT";
      stop();
    };
  const onAbort = () => {
    interrupted ??= "aborted";
    stop();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, maxMs);
  const collect = (text, chunk) => {
    if (text.length + chunk.length > 65536) {
      timedOut = true;
      stop();
      return text;
    }
    return text + chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk) => {
    output = collect(output, chunk);
  });
  child.stderr.on("data", (chunk) => {
    errors = collect(errors, chunk);
  });
  try {
    const outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    finished = true;
    let cycle = null;
    try {
      cycle = JSON.parse(output);
    } catch {
      /* A killed worker may not emit a final report. */
    }
    const exitCode = timedOut
      ? 124
      : interrupted === "SIGINT"
        ? 130
        : interrupted
          ? 143
          : (outcome.code ?? 1);
    return {
      exitCode,
      report: {
        kind: "collector_launcher",
        mode: "offline_fixture",
        onlineVerified: false,
        pid: process.pid,
        workerPid: child.pid,
        workerExited: true,
        workerExitCode: outcome.code,
        workerSignal: outcome.signal,
        timedOut,
        interrupted,
        elapsedMs: Math.ceil(performance.now() - start),
        limits: { maxMs, graceMs, v8HeapMb: heapMb },
        cycle: cycle?.kind === "worker_cycle" ? cycle : null,
        workerReportedError: errors.length > 0,
      },
    };
  } finally {
    finished = true;
    clearTimeout(deadline);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", onAbort);
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await launchCollector(process.argv.slice(2));
    console.log(JSON.stringify(result.report));
    process.exitCode = result.exitCode;
  } catch {
    console.error(
      JSON.stringify({ error: "collector_launcher_failed", mode: "offline_fixture", onlineVerified: false }),
    );
    process.exitCode = 1;
  }
}
