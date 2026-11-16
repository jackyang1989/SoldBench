import assert from "node:assert/strict";
import test from "node:test";
import { assertLocalDatabaseUrl } from "@soldbench/db";

test("offline tools validate the PG-effective target, not the URL display host", () => {
  for (const url of ["postgresql://localhost/demo", "postgresql://127.0.0.1/demo", "postgresql://[::1]/demo"])
    assert.doesNotThrow(() => assertLocalDatabaseUrl(url));
  assert.doesNotThrow(() =>
    assertLocalDatabaseUrl("postgresql://localhost/demo?host=%2Ftmp%2Fapproved&port=55439", [
      "/tmp/approved",
    ]),
  );
  for (const url of [
    "postgresql://localhost/demo?host=remote.example.test",
    "postgresql://localhost/demo?host=localhost,remote.example.test",
    "postgresql://localhost/demo?hostaddr=8.8.8.8",
    "postgresql://localhost/demo?service=remote",
    "postgresql://localhost/demo?host=localhost&host=remote.example.test",
    "postgresql://localhost/demo?host=%2Ftmp%2Funapproved",
    "postgresql://localhost/demo?sslkey=%2Fprivate%2Fsecret",
    "postgresql://remote.example.test/demo",
    "https://localhost/demo",
  ])
    assert.throws(() => assertLocalDatabaseUrl(url, ["/tmp/approved"]));
  const old = process.env.PGHOST;
  try {
    process.env.PGHOST = "remote.example.test";
    assert.throws(() => assertLocalDatabaseUrl("postgresql:///demo"));
  } finally {
    if (old === undefined) delete process.env.PGHOST;
    else process.env.PGHOST = old;
  }
});
