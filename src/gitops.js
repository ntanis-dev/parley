import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Refusal,
  ignoreRules,
  isIgnored,
  patchSecrets,
  projectPath,
} from "./egress.js";

// The git work Parley does for an agent, so it can keep in step with the
// others (also in a turn a member's message started) without a shell: look,
// pull, mark conflicts resolved, back out, commit and push. Fixed commands
// only: no force, no history rewriting beyond replaying local commits on a
// pull, and commits leave out what the ignore rules keep out. Uncommitted
// work is stashed before a pull and put back after it, under a stash message
// Parley recognises.

const STASH = "parley: before pull";

function git(root, args, { input } = {}) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 << 20,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GIT_MERGE_AUTOEDIT: "no",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  if (result.error) throw new Refusal("git is not available here.");
  return {
    ok: result.status === 0,
    out: (result.stdout ?? "").trim(),
    err: (result.stderr ?? "").trim(),
  };
}

const lines = (text) => text.split("\n").filter(Boolean);
const gitPath = (root, name) => {
  const out = git(root, ["rev-parse", "--git-path", name]).out;
  return out ? join(root, out) : null;
};

// What is going on: branch, upstream, ahead/behind, changes, conflicts, and a
// rebase or merge that is waiting to be finished.
export function repoStatus(root, { fetch = false } = {}) {
  if (!git(root, ["rev-parse", "--git-dir"]).ok)
    throw new Refusal("This project is not a git repository.");
  const fetched = fetch ? git(root, ["fetch", "--quiet"]) : null;
  const branch = git(root, ["branch", "--show-current"]).out || null;
  const upstream =
    git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
      .out || null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = git(root, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{u}",
    ]).out.split(/\s+/);
    ahead = Number(counts[0]) || 0;
    behind = Number(counts[1]) || 0;
  }
  const changed = lines(git(root, ["status", "--porcelain=v1"]).out);
  const conflicts = lines(
    git(root, ["diff", "--name-only", "--diff-filter=U"]).out,
  );
  const rebase = ["rebase-merge", "rebase-apply"].some((n) => {
    const p = gitPath(root, n);
    return p && existsSync(p);
  });
  const merging = (() => {
    const p = gitPath(root, "MERGE_HEAD");
    return Boolean(p && existsSync(p));
  })();
  const stashed = lines(git(root, ["stash", "list"]).out).some((l) =>
    l.includes(STASH),
  );
  return {
    branch,
    upstream,
    ahead,
    behind,
    changed: changed.length,
    conflicts,
    rebase,
    merging,
    stashed,
    fetchError: fetched && !fetched.ok ? fetched.err : null,
  };
}

export function describeStatus(s) {
  return [
    s.branch ? `On ${s.branch}` : "Not on a branch",
    s.upstream
      ? `tracking ${s.upstream}: ${s.ahead} ahead, ${s.behind} behind`
      : "with no upstream",
    `${s.changed} changed file${s.changed === 1 ? "" : "s"}`,
    s.conflicts.length ? `conflicts in ${s.conflicts.join(", ")}` : "",
    s.rebase ? "a rebase is waiting to be finished (resolve or abort)" : "",
    s.merging ? "a merge is waiting to be finished (resolve or abort)" : "",
    s.stashed ? "your work from before the pull is stashed" : "",
    s.fetchError ? `fetching failed: ${s.fetchError}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

// Catches up with the upstream branch: fast-forward when there is nothing
// local, otherwise replay the local commits on top (rebase). Uncommitted
// work is stashed first and put back after.
export function pull(root) {
  const before = repoStatus(root, { fetch: true });
  if (before.fetchError)
    throw new Refusal(`Could not fetch: ${before.fetchError}`);
  if (before.rebase || before.merging || before.conflicts.length)
    throw new Refusal(
      `Finish what is in progress first: ${describeStatus(before)}.`,
    );
  if (!before.upstream)
    throw new Refusal("This branch tracks no upstream branch to pull from.");
  if (!before.behind) return `Already up to date with ${before.upstream}.`;
  const stash = before.changed > 0;
  if (stash) {
    const saved = git(root, [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      STASH,
    ]);
    if (!saved.ok)
      throw new Refusal(`Could not stash your changes: ${saved.err}`);
  }
  const integrate = before.ahead
    ? git(root, ["rebase", "@{u}"])
    : git(root, ["merge", "--ff-only", "@{u}"]);
  const how = before.ahead ? "rebased on" : "fast-forwarded to";
  if (!integrate.ok) {
    const now = repoStatus(root);
    if (now.conflicts.length)
      return `Pulled ${before.behind} commit${before.behind === 1 ? "" : "s"} from ${before.upstream}, but your commits conflict with them in ${now.conflicts.join(", ")}. Resolve the conflict markers in those files, then call resolve (or abort).`;
    if (stash) git(root, ["stash", "pop"]);
    throw new Refusal(`The pull did not go through: ${integrate.err}`);
  }
  if (!stash)
    return `Pulled ${before.behind} commit${before.behind === 1 ? "" : "s"}: ${how} ${before.upstream}.`;
  const restored = git(root, ["stash", "pop"]);
  const now = repoStatus(root);
  if (!restored.ok || now.conflicts.length)
    return `Pulled ${before.behind} commit${before.behind === 1 ? "" : "s"} (${how} ${before.upstream}); putting your uncommitted work back conflicts in ${now.conflicts.join(", ") || "some files"}. Resolve the conflict markers, then call resolve (or abort to undo the pull).`;
  return `Pulled ${before.behind} commit${before.behind === 1 ? "" : "s"} (${how} ${before.upstream}) and put your uncommitted work back.`;
}

const MARKER_RE = /^(<{7}|>{7})( |$)/m;

// Marks resolved files as such and finishes what was waiting: a rebase goes
// on, a stash that was put back is dropped. Refuses files that still hold
// conflict markers.
export function resolve(root, paths = []) {
  const s = repoStatus(root);
  if (!s.conflicts.length && !s.rebase && !s.merging)
    return "There is nothing to resolve.";
  const wanted = paths.length
    ? paths.map((p) => projectPath(root, p))
    : s.conflicts;
  const left = wanted.filter((rel) => {
    try {
      return MARKER_RE.test(readFileSync(join(root, rel), "utf8"));
    } catch {
      return false;
    }
  });
  if (left.length)
    throw new Refusal(
      `These still have conflict markers: ${left.join(", ")}. Edit them first.`,
    );
  if (wanted.length) {
    const added = git(root, ["add", "--", ...wanted]);
    if (!added.ok) throw new Refusal(`git add failed: ${added.err}`);
  }
  if (s.rebase) {
    const next = git(root, ["rebase", "--continue"]);
    if (!next.ok) {
      const now = repoStatus(root);
      if (now.conflicts.length)
        return `The next commit conflicts too, in ${now.conflicts.join(", ")}. Resolve those, then call resolve again.`;
      throw new Refusal(`The rebase did not go on: ${next.err}`);
    }
  } else if (s.merging) {
    const done = git(root, ["commit", "--no-edit"]);
    if (!done.ok) throw new Refusal(`The merge did not finish: ${done.err}`);
  } else {
    // A stash that was put back with conflicts: keep the work unstaged, and
    // drop the stash it came from.
    git(root, ["reset", "--quiet"]);
    const top = git(root, ["stash", "list", "-n", "1"]).out;
    if (top.includes(STASH)) git(root, ["stash", "drop", "--quiet"]);
  }
  const after = repoStatus(root);
  if (after.stashed && !after.conflicts.length && !after.rebase) {
    const restored = git(root, ["stash", "pop"]);
    const now = repoStatus(root);
    if (!restored.ok || now.conflicts.length)
      return `Done; putting your uncommitted work back conflicts in ${now.conflicts.join(", ") || "some files"}. Resolve those, then call resolve again.`;
  }
  return `Resolved. ${describeStatus(repoStatus(root))}.`;
}

// Backs out of a pull that is half done: the rebase or merge is undone and
// stashed work is put back.
export function abort(root) {
  const s = repoStatus(root);
  if (s.rebase) git(root, ["rebase", "--abort"]);
  else if (s.merging) git(root, ["merge", "--abort"]);
  else if (s.conflicts.length) {
    // Conflicts from putting stashed work back: return to the pulled state
    // and leave the stash for later.
    git(root, ["reset", "--hard", "--quiet"]);
    return "Undid putting your work back; it is still stashed (git stash list), on top of the pulled code.";
  }
  const now = repoStatus(root);
  if (now.stashed && !now.rebase && !now.merging) git(root, ["stash", "pop"]);
  return `Backed out. ${describeStatus(repoStatus(root))}.`;
}

// Commits the project's changes: changed and new files, except those the
// ignore rules keep out (keys, environment files, .parleyignore), and never
// anything that looks like a secret. The repository's own hooks run as
// always. `by` (an approved member's name) is noted in the message when a
// member asked for it.
export function commit(root, { message, paths = [], by = null }) {
  const s = repoStatus(root);
  if (s.rebase || s.merging || s.conflicts.length)
    throw new Refusal(
      `Finish what is in progress first: ${describeStatus(s)}.`,
    );
  if (typeof message !== "string" || !message.trim() || message.length > 4000)
    throw new Refusal("A commit needs a message (at most 4000 characters).");
  const wanted = paths.map((p) => projectPath(root, p));
  const within = (file) =>
    !wanted.length ||
    wanted.some((p) => p === "." || file === p || file.startsWith(`${p}/`));
  const rules = ignoreRules(root);
  const candidates = [
    ...new Set([
      ...lines(git(root, ["diff", "--name-only", "HEAD"]).out),
      ...lines(git(root, ["diff", "--name-only", "--cached"]).out),
      ...lines(git(root, ["ls-files", "--others", "--exclude-standard"]).out),
    ]),
  ].filter(within);
  const files = candidates.filter((f) => !isIgnored(f, rules));
  const skipped = candidates.filter((f) => isIgnored(f, rules));
  if (!files.length)
    return `Nothing to commit${skipped.length ? ` (left out, never committed by Parley: ${skipped.join(", ")})` : ""}.`;
  git(root, ["reset", "--quiet"]);
  const added = git(
    root,
    ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
    {
      input: files.join("\0") + "\0",
    },
  );
  if (!added.ok) throw new Refusal(`git add failed: ${added.err}`);
  const findings = patchSecrets(
    git(root, ["diff", "--cached", "--no-color", "--no-ext-diff"]).out,
  );
  if (findings.length) {
    git(root, ["reset", "--quiet"]);
    throw new Refusal(
      `Not committed: the changes look like they hold a secret (${findings
        .slice(0, 5)
        .map((f) => `${f.file}:${f.line} ${f.rule}`)
        .join("; ")}). Move it out of the code first.`,
    );
  }
  const body = by
    ? `${message.trim()}\n\nParley-Requested-By: ${by}`
    : message.trim();
  const done = git(root, ["commit", "--quiet", "-F", "-"], { input: body });
  if (!done.ok) {
    git(root, ["reset", "--quiet"]);
    throw new Refusal(`The commit did not go through: ${done.err || done.out}`);
  }
  const sha = git(root, ["rev-parse", "--short", "HEAD"]).out;
  return `Committed ${files.length} file${files.length === 1 ? "" : "s"} as ${sha}${skipped.length ? ` (left out: ${skipped.join(", ")})` : ""}.`;
}

// Pushes the branch to its upstream: a plain push, never forced.
export function push(root) {
  const s = repoStatus(root, { fetch: true });
  if (!s.upstream)
    throw new Refusal("This branch tracks no upstream branch to push to.");
  if (s.behind)
    throw new Refusal(
      `${s.upstream} has ${s.behind} commit${s.behind === 1 ? "" : "s"} you do not: pull first.`,
    );
  if (!s.ahead) return `Nothing to push: ${s.upstream} is up to date.`;
  const pushed = git(root, ["push", "--quiet"]);
  if (!pushed.ok)
    throw new Refusal(`The push did not go through: ${pushed.err}`);
  return `Pushed ${s.ahead} commit${s.ahead === 1 ? "" : "s"} to ${s.upstream}.`;
}
