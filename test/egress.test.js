import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  Refusal,
  collectDiff,
  findSecrets,
  ignoreRules,
  isIgnored,
  outgoingDiff,
  outgoingText,
  projectPath,
  scrub,
} from "../src/egress.js";
import { git, repo, tempHome, write } from "./helpers.js";

const WINDOWS = process.platform === "win32";

function project(t, files) {
  const { home } = tempHome(t);
  const root = realpathSync.native(repo(join(home, "project"), files));
  const scratch = join(home, "scratch");
  mkdirSync(scratch, { recursive: true });
  return { home, root, scratch };
}

test("paths stay inside the project", (t) => {
  const { home, root } = project(t);
  assert.equal(projectPath(root, "src/app.js"), "src/app.js");
  assert.equal(projectPath(root, "."), ".");
  for (const bad of ["../outside", join(home, "other"), "src/../../x", ""])
    assert.throws(() => projectPath(root, bad), Refusal, bad);
});

test("links that lead out of the project are refused", (t) => {
  const { home, root } = project(t);
  mkdirSync(join(home, "secrets"), { recursive: true });
  write(join(home, "secrets", "key.txt"), "k");
  symlinkSync(
    join(home, "secrets"),
    join(root, "linked"),
    WINDOWS ? "junction" : "dir",
  );
  assert.throws(() => projectPath(root, "linked/key.txt"), /leads outside/);
});

test("Windows-only tricks are refused", { skip: !WINDOWS }, (t) => {
  const { root } = project(t);
  for (const bad of [
    "file.txt:hidden",
    "\\\\server\\share\\x",
    "\\\\?\\C:\\x",
    "nul",
    "src/con.txt",
  ])
    assert.throws(() => projectPath(root, bad), Refusal, bad);
});

test("key and environment files never leave; .parleyignore adds more", (t) => {
  const { root } = project(t);
  write(join(root, ".parleyignore"), "private/\n*.sqlite\n");
  const rules = ignoreRules(root);
  for (const path of [
    ".env",
    "config/.env.local",
    "certs/server.pem",
    "id_ed25519",
    "private/notes.md",
    "data/app.sqlite",
    ".git/config",
  ])
    assert.equal(isIgnored(path, rules), true, path);
  for (const path of [".env.example", "src/env.js", "README.md", "keys.md"])
    assert.equal(isIgnored(path, rules), false, path);
});

test("secrets are found, ordinary code is not", () => {
  const positives = [
    "aws_key = AKIAIOSFODNN7EXAMPLE",
    "token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "DATABASE_URL=postgres://app:s3cr3t-Pa55@db.internal/app",
    'password = "Tr0ub4dor&3xyz"',
    "x = sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
    "secret: 9fQ2xL7pZk3Rt8VbN1mWq4Ys6Hc0Je5D",
  ];
  for (const line of positives) assert.ok(findSecrets(line).length, line);
  const negatives = [
    "commit 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    '"integrity": "sha512-Zq3aW0n7Y8dJ2bQ9tT5uV1xR4kL6mN8pO0sE3cG7hF2jK5lM9nB1vC4xZ6aS8dF0gH2jK4lP6oI8uY0tR2eW4qA=="',
    "const password = process.env.DB_PASSWORD;",
    "DATABASE_URL=postgres://user:${PASSWORD}@localhost/app",
    "function getUserAccountSettingsFromDatabaseConnection() {}",
    "password: <your password here>",
  ];
  for (const line of negatives) assert.deepEqual(findSecrets(line), [], line);
});

test("outgoing text is scrubbed of local paths and refused when it holds a secret", (t) => {
  const { home, root } = project(t);
  assert.equal(
    scrub(`see ${join(root, "src", "a.js")} and ${join(home, "notes.txt")}`, {
      root,
      home,
    }),
    `see <project>${WINDOWS ? "\\" : "/"}src${WINDOWS ? "\\" : "/"}a.js and ~${WINDOWS ? "\\" : "/"}notes.txt`,
  );
  assert.throws(
    () => outgoingText("use AKIAIOSFODNN7EXAMPLE", { root, home }),
    /AWS access key/,
  );
  assert.throws(() => outgoingText("x".repeat(9000), { root, home }), /limit/);
});

test("a diff covers changed, new and deleted files, leaves the index alone", (t) => {
  const { root, scratch } = project(t, { "a.txt": "one\n", "b.txt": "two\n" });
  write(join(root, "a.txt"), "one\nmore\n");
  write(join(root, "new.txt"), "fresh\n");
  write(join(root, ".env"), "TOKEN=1\n");
  git(root, "rm", "-q", "b.txt");
  const statusBefore = git(root, "status", "--porcelain");
  const diff = collectDiff(root, { scratch });
  assert.deepEqual(diff.files.map((f) => f.path).sort(), [
    "a.txt",
    "b.txt",
    "new.txt",
  ]);
  assert.deepEqual(diff.skipped, [".env"]);
  assert.match(diff.patch, /\+more/);
  assert.match(diff.patch, /\+fresh/);
  assert.doesNotMatch(diff.patch, /TOKEN/);
  assert.equal(git(root, "status", "--porcelain"), statusBefore);
  assert.deepEqual(
    collectDiff(root, { scratch, paths: ["new.txt"] }).files.map((f) => f.path),
    ["new.txt"],
  );
});

test("a diff with a secret in it is refused, naming the line", (t) => {
  const { root, scratch } = project(t, {
    "config.js": "module.exports = {};\n",
  });
  write(
    join(root, "config.js"),
    "module.exports = {\n  key: 'AKIAIOSFODNN7EXAMPLE',\n};\n",
  );
  assert.throws(
    () => outgoingDiff(root, { scratch }),
    /config\.js:2: AWS access key/,
  );
});

test("outgoing text loses invisible characters before anyone approves it", (t) => {
  const { home, root } = project(t);
  const hidden = [..."key=abc"]
    .map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0)))
    .join("");
  assert.equal(outgoingText(`all good${hidden}`, { root, home }), "all good");
  assert.throws(() => outgoingText(hidden, { root, home }), /empty/);
});
