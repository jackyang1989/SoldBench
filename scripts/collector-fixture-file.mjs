import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { loadFixtureArtifact } from "@soldbench/collector";

export const fixtureJobId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function readFixtureFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("fixture_artifact_file_invalid");
    const bytes = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await file.read(bytes, total, bytes.length - total, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    if (total !== stat.size) throw new Error("fixture_artifact_file_changed");
    return loadFixtureArtifact(bytes.subarray(0, total));
  } finally {
    await file.close();
  }
}

export async function publishFixtureFile(path, artifact) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      const body = Buffer.from(JSON.stringify(artifact));
      if (body.length > 16 * 1024 * 1024) throw new Error("fixture_artifact_too_large");
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    // The supervisor can only see the final name once the full file exists.
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}
