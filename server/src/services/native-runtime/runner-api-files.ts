import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Open a previously authorized canonical path without following raced symlinks. */
export async function openRunnerApiWorkspaceFile(path: string): Promise<FileHandle> {
  if (!isAbsolute(path)) throw new Error("Workspace file must have a canonical absolute path");
  if (process.platform === "darwin") {
    // Darwin sys/fcntl.h: O_NOFOLLOW_ANY rejects symlinks at every component.
    // Node does not expose this flag in fs.constants. Unsupported kernels fail
    // closed instead of falling back to a pathname check followed by open.
    return open(path, constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
  }
  if (process.platform !== "linux") throw new Error("Workspace uploads require a platform with confined file opens; use an authorized artifact reference");
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || parts.some(part => part === "." || part === "..")) throw new Error("Invalid canonical workspace path");
  let directory = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of parts.slice(0, -1)) {
      // Linux O_PATH lets O_NOFOLLOW open a symlink itself; fstat then rejects it
      // unless the descriptor actually refers to a directory. O_DIRECTORY alone
      // may accept an ancestor symlink on supported kernels.
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`, 0x200000 | constants.O_NOFOLLOW);
      try {
        if (!(await next.stat()).isDirectory()) throw new Error("Workspace path component is not a directory");
      } catch (error) {
        await next.close();
        throw error;
      }
      const previous = directory;
      directory = next;
      await previous.close();
    }
    return await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } finally { await directory.close(); }
}
