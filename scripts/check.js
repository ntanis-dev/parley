import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Syntax check of every JavaScript file (node --check), and no character
// outside ASCII in the code: Parley strips invisible and direction-changing
// characters from what it receives, and its own source should not hide any
// either (they are written as \u escapes).
const NON_ASCII = /[^\t\n\r\x20-\x7e]/;
let bad = 0;
for (const dir of [
  "src",
  "src/relay",
  "src/view",
  "scripts",
  "test",
  "relay/cloudflare",
]) {
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    continue;
  }
  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    const path = join(dir, file);
    const result = spawnSync(process.execPath, ["--check", path], {
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
    (await readFile(path, "utf8")).split("\n").forEach((line, i) => {
      if (!NON_ASCII.test(line)) return;
      console.error(
        `${path}:${i + 1}: a character outside ASCII; write it as a unicode escape`,
      );
      bad++;
    });
  }
}
if (bad) process.exit(1);
console.log("JavaScript syntax checks passed.");
