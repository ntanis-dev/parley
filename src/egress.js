import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { clean } from "./inbound.js";

// The way out. Everything Parley sends leaves through here, and nothing here
// trusts the agent: it names files, never hands over their content; paths
// are resolved and checked against the project folder before anything is
// read; whole classes of files never leave; and text is scanned for secrets,
// with a refusal (naming the rule and the line, never the secret) instead of
// a quiet edit.

export class Refusal extends Error {}

export const TEXT_MAX = 8 * 1024;
export const PATCH_MAX = 256 * 1024;

const WINDOWS = process.platform === "win32";
const fold = (path) => (WINDOWS ? path.toLowerCase() : path);

// The project folder as the file system names it (symlinks and junctions
// resolved), which is what every check compares against.
export function projectRoot(dir) {
  return realpathSync.native(resolve(dir));
}

export function isInside(root, target) {
  const r = fold(root.endsWith(sep) ? root.slice(0, -1) : root);
  const t = fold(target);
  return t === r || t.startsWith(r + sep);
}

const DEVICE_RE =
  /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\..*)?$/i;

// A path the agent named, as a project-relative path with forward slashes,
// or a Refusal. It must stay inside the project both as written and once
// links are followed.
export function projectPath(root, input) {
  if (typeof input !== "string" || !input.trim() || input.length > 1024)
    throw new Refusal("A path must be a short, non-empty string.");
  const raw = input.trim();
  if (raw.includes("\0"))
    throw new Refusal(`Refused path ${JSON.stringify(raw)}.`);
  if (WINDOWS || /^[\\/]{2}/.test(raw)) {
    if (/^[\\/]{2}/.test(raw))
      throw new Refusal(
        `Refused ${raw}: network and device paths never leave.`,
      );
    // A colon anywhere but after a drive letter names an alternate data
    // stream (file.txt:hidden), which Explorer and git never show.
    if (
      raw.slice(isAbsolute(raw) && /^[a-z]:/i.test(raw) ? 2 : 0).includes(":")
    )
      throw new Refusal(
        `Refused ${raw}: a colon in a path names a hidden stream.`,
      );
    if (raw.split(/[\\/]/).some((part) => DEVICE_RE.test(part)))
      throw new Refusal(`Refused ${raw}: that name is a Windows device.`);
  }
  const full = resolve(root, raw);
  if (!isInside(root, full))
    throw new Refusal(`Refused ${raw}: it is outside the project folder.`);
  // Follow links: the deepest part that exists must still be inside.
  let existing = full;
  while (!existsSync(existing) && dirname(existing) !== existing)
    existing = dirname(existing);
  let real;
  try {
    real = realpathSync.native(existing);
  } catch {
    throw new Refusal(`Refused ${raw}: it could not be resolved.`);
  }
  if (!isInside(root, real))
    throw new Refusal(`Refused ${raw}: it leads outside the project folder.`);
  const rel = relative(root, full).split(sep).join("/");
  return rel === "" ? "." : rel;
}

// ---- What never leaves ------------------------------------------------------

export const DEFAULT_IGNORE = [
  ".git/",
  ".parley/",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.kdbx",
  "*.ppk",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".docker/config.json",
  ".npmrc",
  ".yarnrc.yml",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "credentials.*",
  "secrets.*",
  "*.tfstate",
  "*.tfstate.*",
  "*.tfvars",
  ".mcp.json",
  ".claude/settings.local.json",
];

// A gitignore-style pattern as a test of a project-relative path: no slash
// (but a trailing one) matches a name at any depth, a slash anchors it to the
// project, * stays within a name, ** crosses folders, a trailing slash means
// everything under that folder, and ! takes a path back.
function compile(pattern) {
  let p = pattern.trim();
  if (!p || p.startsWith("#")) return null;
  const negate = p.startsWith("!");
  if (negate) p = p.slice(1);
  const dir = p.endsWith("/");
  if (dir) p = p.slice(0, -1);
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      re += p[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += p[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(
    `${anchored ? "^" : "(?:^|/)"}${re}${dir ? "(?:/|$)" : "(?:$|/)"}`,
    WINDOWS ? "i" : "",
  );
  return { negate, test: (path) => regex.test(path) };
}

export function ignoreRules(root) {
  const lines = [...DEFAULT_IGNORE];
  try {
    lines.push(
      ...readFileSync(join(root, ".parleyignore"), "utf8").split(/\r?\n/),
    );
  } catch {}
  return lines.map(compile).filter(Boolean);
}

// The last rule that matches decides, as in .gitignore.
export function isIgnored(rel, rules) {
  let ignored = false;
  for (const rule of rules) if (rule.test(rel)) ignored = !rule.negate;
  return ignored;
}

// ---- Secrets ---------------------------------------------------------------------

const PLACEHOLDER_RE =
  /^(?:\$\{?[\w.]+\}?|<[^>]*>|\{\{.*\}\}|%[\w]+%|process\.env\.\w+|os\.environ.*|env\(.*|x{4,}|\*{3,}|\.{3,}|changeme|example|placeholder|your[_-]?\w*|redacted|dummy|test(?:ing)?|secret|password|none|null|undefined|true|false)$/i;

const RULES = [
  ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
  ],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Slack webhook", /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/],
  ["Discord webhook", /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/],
  ["Stripe key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["PyPI token", /\bpypi-[A-Za-z0-9_-]{50,}/],
  [
    "JSON Web Token",
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  ],
];

const URL_CREDENTIAL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{3,})@/gi;
const ASSIGNMENT_RE =
  /(?:pass(?:word|wd)?|pwd|secret|api[_-]?key|access[_-]?(?:key|token)|auth[_-]?token|client[_-]?secret|private[_-]?key|bearer)["']?\s*[:=]\s*["'`]?([^\s"'`,;)]{8,})/gi;
const TOKEN_RE = /[A-Za-z0-9+=_-]{32,}/g;

function entropy(text) {
  const counts = new Map();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values())
    bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

// Random-looking enough to be a credential: long, mixed, and denser than hex
// (so commit ids and hashes in lockfiles pass).
function looksRandom(token, line, index) {
  if (/^[0-9a-f]+$/i.test(token)) return false;
  if (!/[0-9]/.test(token) || !/[a-z]/.test(token) || !/[A-Z]/.test(token))
    return false;
  if (
    /(?:sha(?:1|256|384|512)-|integrity|nonce|hash)\W*$/i.test(
      line.slice(0, index),
    )
  )
    return false;
  return entropy(token) >= 4.3;
}

// Findings as [{ rule, line }] for `text` (lines numbered from `firstLine`).
export function findSecrets(text, firstLine = 1) {
  const findings = [];
  String(text)
    .split("\n")
    .forEach((line, i) => {
      const at = firstLine + i;
      for (const [rule, re] of RULES)
        if (re.test(line)) findings.push({ rule, line: at });
      for (const m of line.matchAll(URL_CREDENTIAL_RE))
        if (!PLACEHOLDER_RE.test(m[1]))
          findings.push({ rule: "password in a URL", line: at });
      for (const m of line.matchAll(ASSIGNMENT_RE))
        if (!PLACEHOLDER_RE.test(m[1]) && entropy(m[1]) >= 3)
          findings.push({ rule: "credential assignment", line: at });
      for (const m of line.matchAll(TOKEN_RE))
        if (looksRandom(m[0], line, m.index))
          findings.push({ rule: "random-looking token", line: at });
    });
  const seen = new Set();
  return findings.filter(
    ({ rule, line }) =>
      !seen.has(`${rule}:${line}`) && seen.add(`${rule}:${line}`),
  );
}

const describe = (findings, where = (f) => `line ${f.line}`) =>
  findings
    .slice(0, 8)
    .map((f) => `${where(f)}: ${f.rule}`)
    .join("; ") +
  (findings.length > 8 ? `; and ${findings.length - 8} more` : "");

// Replaces the project folder and the home folder in outgoing text, so a
// message never says where things are on this computer or whose it is.
export function scrub(text, { root, home = homedir() }) {
  let out = String(text);
  for (const [path, label] of [
    [root, "<project>"],
    [home, "~"],
  ]) {
    if (!path || path.length < 3) continue;
    for (const variant of new Set([
      path,
      path.split(sep).join("/"),
      path.split("/").join("\\"),
    ])) {
      const re = new RegExp(
        variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        WINDOWS ? "gi" : "g",
      );
      out = out.replace(re, label);
    }
  }
  return out;
}

// Text the agent wants to send (a message, a note): scrubbed, then refused
// if it is too long or holds anything that looks like a secret.
export function outgoingText(
  text,
  { root, home, max = TEXT_MAX, what = "message" },
) {
  if (typeof text !== "string" || !text.trim())
    throw new Refusal(`The ${what} is empty.`);
  // Cleaned like incoming text, so what the person approves is all there
  // is: invisible characters could otherwise carry a second, hidden message.
  const out = scrub(clean(text, max * 2).trim(), { root, home });
  if (!out) throw new Refusal(`The ${what} is empty.`);
  if (out.length > max)
    throw new Refusal(
      `The ${what} is ${out.length} characters; the limit is ${max}.`,
    );
  const findings = findSecrets(out);
  if (findings.length)
    throw new Refusal(
      `Not sent: the ${what} looks like it holds a secret (${describe(findings)}). Take it out and try again; Parley never sends credentials.`,
    );
  return out;
}

// ---- Diffs ------------------------------------------------------------------------

function git(root, args, { env = {}, input } = {}) {
  const result = spawnSync(
    "git",
    // A project's own git config can name programs to run (a file system
    // monitor, an external diff); none of them run for Parley.
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.quotepath=off",
      "-c",
      "diff.external=",
      ...args,
    ],
    {
      cwd: root,
      input,
      maxBuffer: 64 << 20,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_EXTERNAL_DIFF: "",
        ...env,
      },
    },
  );
  if (result.error) throw new Refusal("git is not available here.");
  return {
    ok: result.status === 0,
    out: result.stdout?.toString("utf8") ?? "",
    err: result.stderr?.toString("utf8").trim() ?? "",
  };
}

const nulList = (text) => text.split("\0").filter(Boolean);

// The uncommitted work in `paths` (default: the whole project) as one patch
// against HEAD, built in a temporary index so the user's own staging is
// never touched. Files the ignore rules name are left out and listed.
export function collectDiff(root, { paths = [], scratch }) {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top.ok)
    throw new Refusal(
      "This project is not a git repository, so there is no diff to share.",
    );
  if (fold(realpathSync.native(top.out.trim())) !== fold(root))
    throw new Refusal(
      "Diffs are shared from the top of the repository; open Parley there.",
    );
  const hasHead = git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const base = hasHead.ok
    ? hasHead.out.trim()
    : git(root, ["hash-object", "-t", "tree", "--stdin"], {
        input: "",
      }).out.trim();

  const wanted = paths.map((p) => projectPath(root, p));
  const within = (file) =>
    !wanted.length ||
    wanted.some((p) => p === "." || file === p || file.startsWith(`${p}/`));
  const candidates = new Set([
    ...nulList(
      git(root, ["diff", "--name-only", "-z", "--no-renames", base]).out,
    ),
    ...nulList(
      git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).out,
    ),
  ]);
  const rules = ignoreRules(root);
  const files = [];
  const skipped = [];
  for (const file of [...candidates].filter(within).sort())
    (isIgnored(file, rules) ? skipped : files).push(file);
  if (!files.length) return { base, files: [], skipped, patch: "" };

  const tmp = mkdtempSync(join(scratch, "diff-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    const read = hasHead.ok
      ? git(root, ["read-tree", "HEAD"], { env })
      : git(root, ["read-tree", "--empty"], { env });
    if (!read.ok)
      throw new Refusal(`git could not prepare the diff: ${read.err}`);
    const list = join(tmp, "paths");
    writeFileSync(list, files.join("\0") + "\0");
    const add = git(
      root,
      ["add", "-A", "--pathspec-from-file", list, "--pathspec-file-nul"],
      { env },
    );
    if (!add.ok)
      throw new Refusal(`git could not prepare the diff: ${add.err}`);
    const diffArgs = [
      "diff",
      "--cached",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-M",
    ];
    const patch = git(root, [...diffArgs, base], { env }).out;
    const stat = nulList(
      git(root, [...diffArgs, "--numstat", "-z", "--no-renames", base], { env })
        .out,
    );
    return {
      base,
      files: stat.map((line) => {
        const [added, removed, ...rest] = line.split("\t");
        return {
          path: rest.join("\t"),
          added: Number(added) || 0,
          removed: Number(removed) || 0,
        };
      }),
      skipped,
      patch,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Secrets on the lines a patch adds, as file:line.
export function patchSecrets(patch) {
  const findings = [];
  let file = null;
  let line = 0;
  for (const text of patch.split("\n")) {
    if (text.startsWith("+++ ")) {
      file = text.slice(4).replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (text.startsWith("+")) {
      for (const f of findSecrets(text.slice(1), line))
        findings.push({ ...f, file });
      line++;
    } else if (!text.startsWith("-") && !text.startsWith("\\")) line++;
  }
  return findings;
}

// The diff that may leave, or a Refusal that says why not.
export function outgoingDiff(root, { paths, scratch }) {
  const diff = collectDiff(root, { paths, scratch });
  if (!diff.patch) {
    const why = diff.skipped.length
      ? ` (left out because they never leave: ${diff.skipped.join(", ")})`
      : "";
    throw new Refusal(`There are no uncommitted changes to share${why}.`);
  }
  if (diff.patch.length > PATCH_MAX)
    throw new Refusal(
      `The diff is ${Math.round(diff.patch.length / 1024)} KiB; the limit is ${PATCH_MAX / 1024} KiB. Share fewer paths.`,
    );
  const findings = patchSecrets(diff.patch);
  if (findings.length)
    throw new Refusal(
      `Not shared: the diff looks like it holds a secret (${describe(findings, (f) => `${f.file}:${f.line}`)}). Move it out of the code, or list that file in .parleyignore.`,
    );
  return diff;
}
