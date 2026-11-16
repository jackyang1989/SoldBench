import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/** Private local object adapter for offline development. No public URLs. */
export class PrivateMediaStore {
  constructor(readonly root: string) {}
  private async path(sourceId: string, hash: string) {
    if (!/^[a-f0-9-]{36}$/.test(sourceId) || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error("invalid_media_key");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    const folder = join(root, sourceId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if ((await lstat(folder)).isSymbolicLink() || !(await realpath(folder)).startsWith(root + sep))
      throw new Error("unsafe_media_directory");
    return join(folder, `${hash}.webp`);
  }
  async put(sourceId: string, bytes: Uint8Array): Promise<{ key: string; hash: string }> {
    if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024)
      throw new Error("invalid_media_object_size");
    const hash = createHash("sha256").update(bytes).digest("hex"),
      path = await this.path(sourceId, hash);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      try {
        await link(temporary, path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        await this.get(`${sourceId}/${hash}.webp`);
      }
    } finally {
      await file.close();
      await unlink(temporary).catch(() => {});
    }
    return { key: `${sourceId}/${hash}.webp`, hash };
  }
  async get(key: string): Promise<Buffer> {
    const match = /^([a-f0-9-]{36})\/([a-f0-9]{64})\.webp$/.exec(key);
    if (!match?.[1] || !match[2]) throw new Error("invalid_media_key");
    const path = await this.path(match[1], match[2]);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error("invalid_media_object");
      const bytes = await file.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== match[2])
        throw new Error("media_hash_mismatch");
      return bytes;
    } finally {
      await file.close();
    }
  }
  async remove(key: string) {
    const m = /^([a-f0-9-]{36})\/([a-f0-9]{64})\.webp$/.exec(key);
    if (!m?.[1] || !m[2]) throw new Error("invalid_media_key");
    try {
      await unlink(await this.path(m[1], m[2]));
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
  }
  /** Delete only generated objects/staging files, without traversing links or subdirectories. */
  async purgeNamespace(sourceId: string) {
    const directory = dirname(await this.path(sourceId, "0".repeat(64)));
    const entries = await readdir(directory, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.webp(?:\.[a-f0-9-]{36}\.tmp)?$/.test(entry.name) || entry.isDirectory()) continue;
      try {
        await unlink(join(directory, entry.name));
        removed++;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return removed;
  }
  async sweepUnreferenced(sourceId: string, referenced: ReadonlySet<string>, cutoff: Date) {
    const directory = dirname(await this.path(sourceId, "0".repeat(64)));
    let removed = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() ||
        !/^[a-f0-9]{64}\.webp(?:\.[a-f0-9-]{36}\.tmp)?$/.test(entry.name) ||
        referenced.has(`${sourceId}/${entry.name}`)
      )
        continue;
      const path = join(directory, entry.name);
      try {
        if ((await lstat(path)).mtime <= cutoff) {
          await unlink(path);
          removed++;
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return removed;
  }
}
