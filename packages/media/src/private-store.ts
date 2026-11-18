import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const generatedObject = /^[a-f0-9]{64}\.webp(?:\.[a-f0-9-]{36}\.tmp)?$/;

/** Private local object adapter for offline development. No public URLs. */
export class PrivateMediaStore {
  constructor(readonly root: string) {}
  private async directoryIdentity(root: string) {
    const info = await stat(root, { bigint: true });
    if (!info.isDirectory()) throw new Error("unsafe_media_directory");
    return createHash("sha256")
      .update(JSON.stringify([root, String(info.dev), String(info.ino), String(info.birthtimeNs)]))
      .digest("hex");
  }
  async storageIdentity(create = false): Promise<string | null> {
    try {
      if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
      return await this.directoryIdentity(await realpath(this.root));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  private async path(sourceId: string, hash: string, create = false, expectedIdentity?: string) {
    if (!/^[a-f0-9-]{36}$/.test(sourceId) || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error("invalid_media_key");
    if (create && !expectedIdentity) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    if (expectedIdentity && expectedIdentity !== (await this.directoryIdentity(root)))
      throw new Error("media_store_mismatch");
    const folder = join(root, sourceId);
    if (create) await mkdir(folder, { recursive: true, mode: 0o700 });
    if (!(await lstat(folder)).isDirectory() || !(await realpath(folder)).startsWith(root + sep))
      throw new Error("unsafe_media_directory");
    return join(folder, `${hash}.webp`);
  }
  async put(
    sourceId: string,
    bytes: Uint8Array,
    expectedIdentity?: string,
  ): Promise<{ key: string; hash: string }> {
    if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024)
      throw new Error("invalid_media_object_size");
    const hash = createHash("sha256").update(bytes).digest("hex"),
      path = await this.path(sourceId, hash, true, expectedIdentity);
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
        await this.get(`${sourceId}/${hash}.webp`, expectedIdentity);
      }
    } finally {
      await file.close();
      await unlink(temporary).catch(() => {});
    }
    return { key: `${sourceId}/${hash}.webp`, hash };
  }
  async get(key: string, expectedIdentity?: string): Promise<Buffer> {
    const match = /^([a-f0-9-]{36})\/([a-f0-9]{64})\.webp$/.exec(key);
    if (!match?.[1] || !match[2]) throw new Error("invalid_media_key");
    const path = await this.path(match[1], match[2], false, expectedIdentity);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
  async remove(key: string, expectedIdentity?: string) {
    const m = /^([a-f0-9-]{36})\/([a-f0-9]{64})\.webp$/.exec(key);
    if (!m?.[1] || !m[2]) throw new Error("invalid_media_key");
    try {
      await unlink(await this.path(m[1], m[2], false, expectedIdentity));
    } catch (e) {
      if (!missing(e)) throw e;
    }
  }
  private async namespace(sourceId: string, expectedIdentity?: string) {
    try {
      return dirname(await this.path(sourceId, "0".repeat(64), false, expectedIdentity));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  /** Delete only generated objects/staging files, without traversing links or subdirectories. */
  async purgeNamespace(sourceId: string, expectedIdentity?: string) {
    const directory = await this.namespace(sourceId, expectedIdentity);
    if (!directory) return 0;
    const entries = await readdir(directory, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!generatedObject.test(entry.name) || entry.isDirectory()) continue;
      try {
        await unlink(join(directory, entry.name));
        removed++;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return removed;
  }
  async sweepUnreferenced(
    sourceId: string,
    referenced: ReadonlySet<string>,
    cutoff: Date,
    expectedIdentity?: string,
  ) {
    const directory = await this.namespace(sourceId, expectedIdentity);
    if (!directory) return 0;
    let removed = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() ||
        !generatedObject.test(entry.name) ||
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
