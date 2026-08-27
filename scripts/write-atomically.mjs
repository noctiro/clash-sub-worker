import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";

export async function writeTextAtomically(
  path,
  content,
  { mode = 0o644 } = {},
) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath =
    path +
    "." +
    String(process.pid) +
    "." +
    randomBytes(8).toString("hex") +
    ".tmp";
  let handle;

  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
    // rename 会保留临时文件权限，但显式 chmod 也能修复已有宽松产物。
    await chmod(path, mode);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
