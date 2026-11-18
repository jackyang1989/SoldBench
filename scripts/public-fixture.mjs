import { resolve } from "node:path";
import { AuthService, localAuthSecrets } from "@soldbench/auth";
import { BillingService } from "@soldbench/billing";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { PublicResults, QueryService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const [action, id, ...extra] = process.argv.slice(2);
if (action !== "publish" || extra.length || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id ?? ""))
  throw new Error("usage_public_fixture_publish_query_uuid");
const config = loadConfig(process.env),
  url = config.databaseUrl ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url);
try {
  await migrate(db);
  const auth = new AuthService(db, localAuthSecrets(resolve(config.localStateRoot)), config.origin),
    query = new QueryService(
      db,
      auth,
      new BillingService(db),
      new PrivateMediaStore(resolve(config.mediaRoot)),
    );
  console.log(JSON.stringify(await new PublicResults(query).publishFixture(id)));
} finally {
  await db.end();
}
