import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { roles } from "./ui.js";

// Parley's row in Claude Code's status line, in a `parley` launch. The
// person's own status line (whatever their settings had: a script, another
// tool's, anything) still runs, with the same input, as it would without Parley; its
// output is left exactly as it is, and Parley's row goes under it:
//
//   [their status line, unchanged]
//   <> parley - shop - with Alex - * live - 2 new
//
// The row comes from what Parley's MCP server publishes in the launch file
// (connection, watch, unread, pending, version notices); it drops parts from
// the end to fit the terminal's width (COLUMNS).

// The shell Claude Code itself runs a status line command in: Git Bash on
// Windows when it is installed (CLAUDE_CODE_GIT_BASH_PATH, or next to git on
// PATH, or the default install), else PowerShell; sh elsewhere.
export function statusLineShell(
  env = process.env,
  platform = process.platform,
) {
  if (platform !== "win32")
    return { command: "/bin/sh", args: (c) => ["-c", c] };
  const candidates = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH)
    candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const dir of (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    const clean = dir.replace(/^"|"$/g, "");
    if (existsSync(join(clean, "git.exe")))
      candidates.push(
        resolve(clean, "..", "bin", "bash.exe"),
        resolve(clean, "..", "..", "bin", "bash.exe"),
      );
  }
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(
    Boolean,
  ))
    candidates.push(join(root, "Git", "bin", "bash.exe"));
  const bash = candidates.find((c) => existsSync(c));
  if (bash) return { command: bash, args: (c) => ["-c", c] };
  return {
    command: "powershell.exe",
    args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c],
  };
}

export function runOwnStatusLine(command, stdinText, { env = process.env }) {
  const shell = statusLineShell(env);
  const result = spawnSync(shell.command, shell.args(command), {
    input: stdinText,
    encoding: "utf8",
    env,
    timeout: 15e3,
    windowsHide: true,
    maxBuffer: 1 << 20,
  });
  return result.stdout ?? "";
}

const GLYPHS = {
  rich: {
    mark: "\u21c4",
    live: "\u25cf",
    wait: "\u25cc",
    off: "\u25cb",
    warn: "\u26a0",
    dot: " \u00b7 ",
  },
  plain: { mark: "<>", live: "*", wait: "~", off: "o", warn: "!", dot: " - " },
};

// Parley's palette (ui.js), as the CLI and `parley view` draw it; muted is
// dim, so it follows the person's own status line colours.
const truecolor = (hex) =>
  `38;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}`;
const COLORS = {
  brand: truecolor(roles.brand),
  bold: "1",
  muted: "2",
  ok: truecolor(roles.ok),
  warn: truecolor(roles.warn),
  bad: truecolor(roles.err),
};

const visible = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

// Parley's row for `status` (the launch file's), at most `columns` wide (0:
// no limit).
export function parleyRow(status, { columns = 0, env = process.env } = {}) {
  const g = GLYPHS[env.PARLEY_GLYPHS === "plain" ? "plain" : "rich"];
  const color = env.NO_COLOR
    ? (_, text) => text
    : (tone, text) =>
        `${tone
          .split(" ")
          .map((t) => `\x1b[${COLORS[t]}m`)
          .join("")}${text}\x1b[0m`;
  const head = color("brand bold", `${g.mark} parley`);
  const parts = [];
  if (!status) parts.push(color("muted", "starting"));
  else if (status.blocked === "not set up")
    parts.push(color("warn", "run parley setup"));
  else if (status.blocked === "no room")
    parts.push(color("muted", "this folder is not in a room"));
  else {
    parts.push(color("bold", status.room ?? "room"));
    if (status.blocked === "other repository")
      parts.push(color("bad", `${g.warn} different repository, paused`));
    else if (status.blocked === "bypass")
      parts.push(color("warn", "paused in bypass mode"));
    else {
      parts.push(
        status.relay === "connected"
          ? color("ok", `${g.live} live`)
          : status.relay === "refused"
            ? color("bad", `${g.warn} relay refused`)
            : status.relay
              ? color("warn", `${g.wait} connecting`)
              : color("muted", `${g.off} offline`),
      );
      if (status.unread)
        parts.push(color("brand bold", `${status.unread} new`));
      // How many of the others are around, and how many are working: counts,
      // not names, so it reads the same for two people or twenty (names are
      // in `parley status` and the agent's status tool).
      if (status.members?.length) {
        const online = status.members.filter(
          (m) => m && m.state && m.state !== "offline",
        );
        const working = online.filter((m) => m.state === "working").length;
        parts.push(
          online.length
            ? color("ok", `${online.length}/${status.members.length} online`)
            : color("muted", "nobody online"),
        );
        if (working) parts.push(color("brand", `${working} working`));
      }
      // A launch arms its watch with its first turn; until then, and for a
      // moment after Claude starts it, that is not a problem yet.
      if (status.relay === "connected" && !status.watching)
        parts.push(
          status.watchState === "arming"
            ? color("muted", "arming watch")
            : color("warn", "watch not armed"),
        );
      if (status.pending)
        parts.push(color("warn", `${status.pending} waiting for approval`));
      if (status.notices)
        parts.push(color("warn", "versions differ: parley status"));
    }
  }
  // Drop parts from the end until it fits.
  for (let n = parts.length; n >= 0; n--) {
    const row = [head, ...parts.slice(0, n)].join(color("muted", g.dot));
    if (columns <= 0 || visible(row).length <= columns) return row;
  }
  return head;
}

// The whole status line: theirs as it is, then Parley's row.
// Armed, still arming (a launch's first minute and a half, or just after
// Claude started it), or off.
export function watchState(launch, now = Date.now()) {
  if (launch.status?.watching) return "armed";
  const recent = (at, ms) => Number(at) > 0 && now - Number(at) < ms;
  return recent(launch.started, 90_000) || recent(launch.armingAt, 15_000)
    ? "arming"
    : "off";
}

export function statusLine({
  launch,
  stdinText,
  env = process.env,
  now = Date.now(),
}) {
  const own = launch?.ownStatusLine?.command
    ? runOwnStatusLine(launch.ownStatusLine.command, stdinText, { env })
    : "";
  if (!launch) return own;
  const status = launch.status
    ? { ...launch.status, watchState: watchState(launch, now) }
    : null;
  const row = parleyRow(status, { columns: Number(env.COLUMNS) || 0, env });
  const theirs = own.replace(/\s+$/, "");
  return theirs ? `${theirs}\n${row}\n` : `${row}\n`;
}
