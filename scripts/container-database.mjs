import { readFileSync } from "node:fs";

const roles = new Set(["soldbench_migrator", "soldbench_runtime", "soldbench_collector"]);
const role = process.env.SOLDBENCH_DATABASE_ROLE;
if (!roles.has(role) || !/^[a-zA-Z0-9_]+$/.test(process.env.POSTGRES_DB ?? ""))
  throw new Error("invalid_container_database_reference");
if (process.env.DATABASE_URL) throw new Error("container_database_url_override_forbidden");
let password;
try {
  password = readFileSync("/run/secrets/db_password", "utf8").replace(/\r?\n$/, "");
} catch {
  throw new Error("container_database_credential_unavailable");
}
if (!password || password.startsWith("replace-") || /[\r\n]/.test(password) || password.includes("\u0000"))
  throw new Error("invalid_container_database_credential");
process.env.DATABASE_URL =
  `postgresql://${role}:${encodeURIComponent(password)}@localhost/${process.env.POSTGRES_DB}` +
  "?host=%2Frun%2Fsoldbench%2Fpostgres&port=5432";
