import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";

// Is this folder the same project as the room's? Every clone of a repository
// shares its first (root) commit; an unrelated repository, or a copy whose
// history was started over, does not. The room keeps its root commits as
// HMACs under a key derived from the room secret, so the invite and room.json
// say "same project" without naming a commit anyone could look up.

const git = (root, args) => {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  return result.status === 0 ? result.stdout.trim() : null;
};

// { git, shallow, roots: [commit ids] } for the repository at `root`.
export function projectRoots(root) {
  if (git(root, ["rev-parse", "--git-dir"]) === null)
    return { git: false, shallow: false, roots: [] };
  const shallow =
    git(root, ["rev-parse", "--is-shallow-repository"]) === "true";
  const roots = (git(root, ["rev-list", "--max-parents=0", "HEAD"]) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(line));
  return { git: true, shallow, roots: [...new Set(roots)].sort() };
}

export const tagRoots = (secret, roots) =>
  roots.map((commit) =>
    createHmac("sha256", Buffer.from(secret))
      .update(`parley/v1/root-commit|${commit}`)
      .digest("base64url"),
  );

export function sameProject(tags, secret, roots) {
  const mine = new Set(tagRoots(secret, roots));
  return tags.some((tag) => mine.has(tag));
}

// Why `root` is not the room's project, or null when it is (or when the room
// has nothing to compare: it was opened in a folder without commits).
export function projectMismatch(root, { tags = [], secret, who = "the room" }) {
  if (!tags.length) return null;
  const here = projectRoots(root);
  if (!here.git)
    return `This folder is not a git repository, so it cannot be the same project as ${who}'s. Join from your clone of it.`;
  if (sameProject(tags, secret, here.roots)) return null;
  if (here.shallow)
    return `This is a shallow clone, so its first commit is not the project's. Run \`git fetch --unshallow\` here, then try again.`;
  if (!here.roots.length)
    return `This repository has no commits yet, so it cannot be the same project as ${who}'s. Clone theirs, or pull it here first.`;
  return `This folder is a different repository from ${who}'s: they share no first commit. Use your clone of the same project.`;
}

export const hasCommit = (root, commit) =>
  /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit ?? "") &&
  git(root, ["cat-file", "-e", `${commit}^{commit}`]) !== null;
