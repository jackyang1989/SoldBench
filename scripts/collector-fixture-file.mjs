import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";

export async function publishFixtureFile(path, artifact) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(artifact, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    // The supervisor can only see the final name once the full file exists.
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
