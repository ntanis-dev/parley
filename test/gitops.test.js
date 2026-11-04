import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  abort,
  commit,
  pull,
  push,
  repoStatus,
  resolve,
} from "../src/gitops.js";
import { cloneOf, git, repo, tempHome, write } from "./helpers.js";

// A shared bare repository and two clones of it, as two people have.
function team(t) {
  const { root } = tempHome(t);
  const seed = repo(join(root, "seed"), { "app.js": "one\ntwo\nthree\n" });
  const origin = join(root, "origin.git");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "-u", "origin", "main");
  const clone = (name) => {
    const dir = realpathSync.native(cloneOf(origin, join(root, name)));
    git(dir, "config", "user.name", name);
    git(dir, "config", "user.email", `${name}@example.com`);
    return dir;
  };
  return { alice: clone("alice"), bob: clone("bob") };
}

test("commit leaves out keys and refuses secrets; push never forces", (t) => {
  const { alice, bob } = team(t);
  write(join(alice, "app.js"), "one\ntwo\nthree\nfour\n");
  write(join(alice, ".env"), "TOKEN=abc\n");
  const done = commit(alice, { message: "Add four", by: "Bob" });
  assert.match(done, /Committed 1 file as [0-9a-f]+ \(left out: \.env\)/);
  assert.match(
    git(alice, "log", "-1", "--format=%B"),
    /Parley-Requested-By: Bob/,
  );
  write(join(alice, "config.js"), "const key = 'AKIAIOSFODNN7EXAMPLE';\n");
  assert.throws(
    () => commit(alice, { message: "oops" }),
    /look like they hold a secret/,
  );
  assert.equal(git(alice, "diff", "--cached", "--name-only"), "");
  assert.match(push(alice), /Pushed 1 commit to origin\/main/);
  // Bob's branch moved on: he has to pull before he can push.
  write(join(bob, "b.txt"), "b\n");
  commit(bob, { message: "b" });
  assert.throws(() => push(bob), /pull first/);
});

test("pull fast-forwards, keeping uncommitted work", (t) => {
  const { alice, bob } = team(t);
  write(join(alice, "app.js"), "one\ntwo\nthree\nfour\n");
  commit(alice, { message: "four" });
  push(alice);
  write(join(bob, "notes.md"), "mine\n");
  assert.match(
    pull(bob),
    /Pulled 1 commit .*fast-forwarded.*put your uncommitted work back/,
  );
  assert.equal(
    readFileSync(join(bob, "app.js"), "utf8"),
    "one\ntwo\nthree\nfour\n",
  );
  assert.equal(readFileSync(join(bob, "notes.md"), "utf8"), "mine\n");
  assert.match(pull(bob), /Already up to date/);
});

test("a conflicting pull is resolved, or backed out", (t) => {
  const { alice, bob } = team(t);
  write(join(alice, "app.js"), "one\nALICE\nthree\n");
  commit(alice, { message: "alice" });
  push(alice);
  write(join(bob, "app.js"), "one\nBOB\nthree\n");
  commit(bob, { message: "bob" });
  assert.match(pull(bob), /conflict with them in app\.js.*resolve/);
  assert.equal(repoStatus(bob).rebase, true);
  assert.throws(() => resolve(bob), /still have conflict markers: app\.js/);
  write(join(bob, "app.js"), "one\nALICE and BOB\nthree\n");
  assert.match(resolve(bob), /Resolved/);
  const after = repoStatus(bob);
  assert.equal(after.rebase, false);
  assert.equal(after.ahead, 1);
  assert.equal(after.behind, 0);
  assert.match(push(bob), /Pushed 1 commit/);

  // And backing out of one instead.
  write(join(alice, "app.js"), "one\nALICE again\nthree\n");
  commit(alice, { message: "alice 2" });
  assert.throws(() => push(alice), /pull first/);
  assert.match(pull(alice), /conflict/);
  assert.match(abort(alice), /Backed out/);
  assert.equal(repoStatus(alice).rebase, false);
  assert.equal(
    readFileSync(join(alice, "app.js"), "utf8"),
    "one\nALICE again\nthree\n",
  );
});
