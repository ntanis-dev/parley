import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseClaudeArgs } from "./claude-args.js";
import { resolveClaude } from "./claude-path.js";
import { isInside } from "./egress.js";
import { readJson, writeJsonAtomic } from "./fsutil.js";
import { notices } from "./compat.js";
import {
  approvedMembers,
  isWelcomed,
  loadIdentity,
  loadRoom,
  pendingMembers,
  projectFor,
} from "./rooms.js";
import { syncRoom } from "./ops.js";
import { projectMismatch } from "./project.js";
import { forward } from "./paths.js";
import { launchFile, updateLaunch } from "./sessions.js";

// `parley [claude arguments]`: Claude Code with Parley on, for this run
// only. Everything comes in on the command line, written for this launch
// under ~/.parley/claude/<launch>/ and removed when claude exits:
//   --settings      Parley's hooks (exec form: node + cli.js, no shell);
//                   the status line, Parley's own row under the person's own
//                   status line, which still runs as it did; a rule that
//                   lets the agent run Parley's message watch without a
//                   prompt; and rules that keep its file tools out of
//                   ~/.parley
//   --mcp-config    Parley's MCP server
// Nothing is written to the project or to Claude Code's own settings.

export class LaunchRefused extends Error {}

const REFUSED = [
  [/^--dangerously-skip-permissions$/, "--dangerously-skip-permissions"],
  [
    /^--allow-dangerously-skip-permissions$/,
    "--allow-dangerously-skip-permissions",
  ],
  [/^(-p|--print)$/, "--print"],
];

// Arguments Parley will not start claude with: bypassing permissions would
// let a member's message act without asking, and the message watch needs an
// interactive session.
export function checkArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const [re, name] of REFUSED)
      if (re.test(arg))
        throw new LaunchRefused(
          name === "--print"
            ? "Parley is for interactive sessions; it does not start claude with --print."
            : `Parley does not start claude with ${name}: a member's message could then act without asking you.`,
        );
    const mode = arg.startsWith("--permission-mode=")
      ? arg.slice(18)
      : arg === "--permission-mode"
        ? args[i + 1]
        : null;
    if (mode === "bypassPermissions")
      throw new LaunchRefused(
        "Parley does not start claude in bypassPermissions mode: a member's message could then act without asking you.",
      );
  }
}

// A permission rule's path for `dir` (Claude Code's form: ~/ for the home
// folder, //drive/... for any other absolute path).
export function rulePath(dir, home = homedir()) {
  const full = resolve(dir);
  if (full !== resolve(home) && isInside(resolve(home), full))
    return `~/${forward(relative(home, full))}`;
  const abs = forward(full);
  return /^[A-Za-z]:/.test(abs)
    ? `//${abs[0].toLowerCase()}${abs.slice(2)}`
    : `/${abs}`;
}

// A command line both Git Bash and PowerShell run (status lines and Monitor
// commands go through a shell): an absolute node path cannot be quoted at
// the start of a PowerShell command, so a node path with spaces becomes
// `node` from PATH.
export function nodeCommand(nodePath) {
  const node = forward(nodePath);
  return /\s/.test(node) ? "node" : node;
}

export const watchCommand = (nodePath, cliPath, launchId) =>
  `${nodeCommand(nodePath)} "${forward(cliPath)}" watch --launch ${launchId}`;

// The status line the person would have without Parley: the first of the
// project's local settings, the project's settings and the user's settings
// that sets one. Parley's status line runs it, as it is, above its own row.
export function ownStatusLine({ cwd, env = process.env, home = homedir() }) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  for (const file of [
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(claudeDir, "settings.json"),
  ]) {
    const line = readJson(file)?.statusLine;
    if (line?.type === "command" && typeof line.command === "string")
      return { command: line.command, padding: line.padding ?? null };
  }
  return null;
}

export function launchFiles({
  paths,
  launchId,
  nodePath = process.execPath,
  cliPath,
  env = process.env,
}) {
  const dir = join(paths.claude, launchId);
  const hook = (event) => ({
    type: "command",
    command: forward(nodePath),
    args: [forward(cliPath), "hook", event, "--launch", launchId],
    timeout: 10,
  });
  const own = rulePath(paths.root);
  const watch = watchCommand(nodePath, cliPath, launchId);
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [hook("session-start")] }],
      UserPromptSubmit: [{ hooks: [hook("user-prompt")] }],
      PreToolUse: [{ matcher: "*", hooks: [hook("pre-tool-use")] }],
      PostToolUse: [
        { matcher: "mcp__parley__.*", hooks: [hook("post-tool-use")] },
      ],
      Stop: [{ hooks: [hook("stop")] }],
      SessionEnd: [{ hooks: [hook("session-end")] }],
    },
    statusLine: {
      type: "command",
      command: `${nodeCommand(nodePath)} "${forward(cliPath)}" statusline --launch ${launchId}`,
      // Idle sessions get no events to refresh on; new messages should
      // still show.
      refreshInterval: 5,
    },
    permissions: {
      // The message watch, exactly as Parley's instructions give it.
      allow: [`Bash(${watch})`],
      // Edit rules cover every file-editing tool (Write included); Claude
      // Code does not match Write(...) rules at all.
      deny: [`Read(${own}/**)`, `Edit(${own}/**)`],
    },
  };
  const mcp = {
    mcpServers: {
      parley: {
        type: "stdio",
        command: forward(nodePath),
        args: [forward(cliPath), "mcp", "--launch", launchId],
        env: env.PARLEY_HOME ? { PARLEY_HOME: env.PARLEY_HOME } : {},
      },
    },
  };
  return {
    dir,
    settingsFile: join(dir, "settings.json"),
    mcpFile: join(dir, "mcp.json"),
    settings,
    mcp,
    watch,
  };
}

// What Claude is asked first in a launch that does not start with a prompt
// of the person's own, which the person sees as their first message, so it
// is one line: arm the message watch and keep it armed. What Parley is, its
// MCP instructions and the session start context already say. A resumed
// conversation knows the rest from before; this launch's watch is a new one,
// so it is only asked to arm that. (With a prompt of theirs, the prompt hook
// asks the same, and the Stop hook makes sure of it at the end of every turn.)
const watchHow = (watch) =>
  `the Monitor tool with command: ${watch}, description: "Parley messages", timeout_ms: 1800000 (load Monitor with ToolSearch if needed; use exactly that command)`;

export const openingPrompt = (watch, resumed = false) =>
  resumed
    ? `Parley is on again: arm its new message watch, ${watchHow(watch)}, keep it armed, and wait for me.`
    : `Parley is on: arm its message watch, ${watchHow(watch)}, keep it armed all session, then say in one line that you are listening.`;

// The person's arguments first (so a prompt of theirs is not read as a value
// of --mcp-config, which takes several), then Parley's. A launch without a
// prompt of its own starts with the opening prompt.
export function claudeArgs(files, args) {
  const parsed = parseClaudeArgs(args);
  const opening =
    parsed.interactive && !parsed.positionals.length
      ? [openingPrompt(files.watch, parsed.session.mode !== "new")]
      : [];
  return [
    ...opening,
    ...args,
    "--settings",
    files.settingsFile,
    "--mcp-config",
    files.mcpFile,
  ];
}

// Whether Parley can work in `cwd` at all: keys set up, the folder in a room,
// and the folder a copy of the room's repository. Otherwise there is nothing
// for a `parley` session to do, and it does not start (plain `claude` does).
export function checkFolder({ paths, cwd }) {
  if (!loadIdentity(paths))
    throw new LaunchRefused(
      "Parley is not set up on this computer: run `parley setup` first (or start plain `claude`).",
    );
  const project = projectFor(paths, cwd);
  const room = project && loadRoom(paths, project.roomId);
  if (!room)
    throw new LaunchRefused(
      "This folder is not in a Parley room: open one with `parley create`, join one with `parley join <invite>`, or start plain `claude` here.",
    );
  const mismatch = projectMismatch(project.root, {
    tags: room.tags ?? [],
    secret: Buffer.from(room.secret, "base64url"),
    who: `room "${room.name}"`,
  });
  if (mismatch)
    throw new LaunchRefused(`Parley does not start here. ${mismatch}`);
  return { room, root: project.root };
}

// Whether anyone in the room can hear this person: someone else is in it,
// and, for someone who joined, the others let them in.
export function checkMembership(paths, room) {
  const approved = approvedMembers(room);
  const pending = pendingMembers(room);
  if (!approved.length)
    throw new LaunchRefused(
      pending.length
        ? `${pending.map((m) => `${m.name} (${m.fingerprint})`).join(", ")} asked to join "${room.name}": let them in with \`parley approve\` first, after comparing fingerprints.`
        : `Nobody else is in room "${room.name}" yet: send the invite (\`parley invite\`), and let them in with \`parley approve\` once they join.`,
    );
  if (!isWelcomed(paths, room)) {
    const by =
      approved.find((m) => m.via === "invite")?.name ?? approved[0].name;
    throw new LaunchRefused(
      `${by} has not let you into "${room.name}" yet: ask them to run \`parley approve\`, and compare fingerprints.`,
    );
  }
}

// The room as the relay has it right now, ready for a session, or a refusal
// that says what to do first: a session that cannot reach the relay, or that
// nobody in the room can hear, does not start.
export async function readyToLaunch({ paths, cwd, timeoutMs = 10_000 }) {
  const { room } = checkFolder({ paths, cwd });
  let fresh;
  try {
    fresh = await syncRoom(paths, loadIdentity(paths), room, { timeoutMs });
  } catch (error) {
    throw new LaunchRefused(
      `Parley does not start: ${error.message} Check the relay, or start plain \`claude\`.`,
    );
  }
  checkMembership(paths, fresh);
  return { room: fresh };
}

export async function launch({
  paths,
  args,
  cwd = process.cwd(),
  env = process.env,
  cliPath,
  stderr = process.stderr,
  ui = null,
}) {
  checkArgs(args);
  const say = (text) =>
    ui ? ui.warn(text) : stderr.write(`parley: ${text}\n`);
  const { room } = await readyToLaunch({ paths, cwd });
  const claude = resolveClaude({ env, home: paths.home });
  ui?.ok(`Parley is on in room "${room.name}"`, "starting Claude Code");
  for (const m of pendingMembers(room))
    say(
      `${m.name} (${m.fingerprint}) is waiting to be let in: \`parley approve\`.`,
    );
  // What the room last said about versions (no network here).
  for (const line of notices(room)) say(line);
  // The document ends here: Claude Code has the terminal from now on.
  ui?.end();
  const launchId = randomBytes(12).toString("base64url");
  const files = launchFiles({ paths, launchId, cliPath, env });
  mkdirSync(files.dir, { recursive: true });
  writeJsonAtomic(files.settingsFile, files.settings);
  writeJsonAtomic(files.mcpFile, files.mcp);
  updateLaunch(paths, launchId, (l) => {
    l.pid = process.pid;
    l.cwd = cwd;
    l.started = Date.now();
    l.watchCommand = files.watch;
    l.ownStatusLine = ownStatusLine({ cwd, env, home: paths.home });
  });
  const cleanup = () => {
    rmSync(files.dir, { recursive: true, force: true });
    rmSync(launchFile(paths, launchId), { force: true });
  };
  // Ctrl+C belongs to claude, which shares this console.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    return await new Promise((done) => {
      const child = spawn(
        claude.command,
        [...claude.prefix, ...claudeArgs(files, args)],
        {
          cwd,
          env,
          stdio: "inherit",
          windowsHide: false,
        },
      );
      child.on("error", (error) => {
        stderr.write(`parley: could not start Claude Code: ${error.message}\n`);
        done(1);
      });
      child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
    });
  } finally {
    process.off("SIGINT", ignore);
    cleanup();
  }
}
