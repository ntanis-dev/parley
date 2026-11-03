import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

// Small synchronous file helpers. State files are replaced atomically (a
// temporary file in the same folder, then a rename), so a reader never sees
// half a file, not even after a crash in the middle of a write. Files that
// hold keys are readable by their owner only (where the OS has such modes;
// on Windows the profile folder's own permissions already do that).

const sleeper = new Int32Array(new SharedArrayBuffer(4));
export const sleepSync = (ms) => Atomics.wait(sleeper, 0, 0, ms);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(file, text, { private: secret = false } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  writeFileSync(tmp, text, { mode: secret ? 0o600 : 0o644 });
  // Windows refuses a rename over a file another process has open without
  // delete sharing (a virus scanner, an editor); retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) {
        rmSync(tmp, { force: true });
        throw error;
      }
      sleepSync(5 * (attempt + 1));
    }
  }
}

export const writeJsonAtomic = (file, value, options) =>
  writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n", options);
