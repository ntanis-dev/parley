import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parleyPaths } from "../src/paths.js";

// Test homes live in <repo>/.cache (gitignored), never in the real home.
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(REPO, "src", "cli.js");

export function tempHome(t, name = "home") {
  const root = join(REPO, ".cache", `test-${randomBytes(5).toString("hex")}`);
  const home = join(root, name);
  if (!home.startsWith(join(REPO, ".cache") + sep))
    throw new Error("test home outside .cache");
  mkdirSync(home, { recursive: true });
  t?.after?.(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, paths: parleyPaths(home) };
}

export function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
}

export function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

// A git repository with one commit.
export function repo(dir, files = { "README.md": "hello\n" }) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  for (const [name, content] of Object.entries(files))
    write(join(dir, name), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

export async function until(check, { timeoutMs = 8000, everyMs = 25 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
