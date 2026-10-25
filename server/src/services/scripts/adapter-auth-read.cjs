// The descriptor-bound credential read helper. The server runs it in the sandbox
// as `node -e <this file> <sessionHome> <maxBytes> [<expectedUid>]`. The sandbox
// already runs node for the Paperclip bridge, so the helper needs no extra
// runtime.
//
// The helper closes the time-of-check-to-time-of-use (TOCTOU) window. It opens
// the filesystem root, then opens each session-home component relative to the
// previous directory descriptor. Linux O_PATH | O_NOFOLLOW returns a descriptor
// for a final symlink itself rather than following it; fstat on that same opened
// descriptor enforces that each component is a directory before advancing. Node
// has no openat, so `/proc/self/fd/<dfd>/<component>` keeps each lookup bound to
// the prior descriptor rather than re-resolving the original pathname.
//
// The helper opens `auth.json` relative to the final directory descriptor with
// `O_NOFOLLOW`, runs `fstat` on that one descriptor, and reads only from it. The
// `fstat` check requires a regular file, the expected owner, exact mode `0600`,
// and a size at or below the bound. The helper never re-opens the pathname after
// the check.
//
// Security: the helper prints only the base64 of the credential bytes on the
// fully validated success path. It prints one fixed error token on stderr on every
// failed path. It never prints the pathname, the raw bytes, or any other detail.

"use strict";

const fs = require("node:fs");

const NAME = "auth.json";
const home = process.argv[1];
const max = Number.parseInt(process.argv[2], 10);
const expectedUid =
  process.argv[3] !== undefined ? Number.parseInt(process.argv[3], 10) : process.getuid();

function fail() {
  process.stderr.write("AUTH_READ_FAILED\n");
  process.exit(1);
}

if (!Number.isInteger(max) || max <= 0) fail();
if (typeof home !== "string" || !home.startsWith("/")) fail();
const parts = home.split("/").filter((component) => component.length > 0);
if (parts.length === 0) fail();

// O_PATH | O_NOFOLLOW opens a terminal symlink as a descriptor; fstat of that
// same descriptor rejects it unless it is actually a directory.
let dfd;
try {
  dfd = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
} catch {
  fail();
}
for (const part of parts) {
  let next;
  try {
    next = fs.openSync(
      `/proc/self/fd/${dfd}/${part}`,
      0x200000 | fs.constants.O_NOFOLLOW,
    );
    if (!fs.fstatSync(next).isDirectory()) throw new Error();
  } catch {
    if (next !== undefined) fs.closeSync(next);
    fs.closeSync(dfd);
    fail();
  }
  const previous = dfd;
  dfd = next;
  fs.closeSync(previous);
}

// Open the credential relative to the final directory descriptor with a no-follow
// open, so a symlink credential fails and a missing credential fails.
let ffd;
try {
  ffd = fs.openSync(`/proc/self/fd/${dfd}/${NAME}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
} catch {
  fs.closeSync(dfd);
  fail();
}
fs.closeSync(dfd);

// Validate the opened descriptor, then read only from it.
const st = fs.fstatSync(ffd);
if (!st.isFile()) fail();
if (st.uid !== expectedUid) fail();
if ((st.mode & 0o7777) !== 0o600) fail();
if (st.size > max) fail();

const buffer = Buffer.allocUnsafe(65536);
const chunks = [];
let total = 0;
for (;;) {
  const read = fs.readSync(ffd, buffer, 0, buffer.length, null);
  if (read === 0) break;
  chunks.push(Buffer.from(buffer.subarray(0, read)));
  total += read;
  if (total > max) fail();
}

process.stdout.write(Buffer.concat(chunks).toString("base64"));
process.exit(0);
