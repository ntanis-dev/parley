import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { resolveClaude } from "./claude-path.js";
import { isInside } from "./egress.js";
import { writeFileAtomic, writeJsonAtomic } from "./fsutil.js";
import { installedEntry } from "./install.js";
import { notices } from "./compat.js";
import { loadRoom, projectFor } from "./rooms.js";
import { forward } from "./paths.js";
import { launchFile, updateLaunch } from "./sessions.js";

// `parley [claude arguments]`: Claude Code with Parley loaded, for this run
// only. Everything comes in on the command line, written for this launch
// under ~/.parley/claude/<launch>/ and removed when claude exits:
//   --settings      Parley's hooks (exec form: node + cli.js, no shell), and
//                   rules that keep the agent's file tools out of ~/.parley
//   --plugin-dir    a plugin with one command, /parley (on, off, status),
//                   which only the person can run; the prompt hook handles
//                   it before it expands
//   --dangerously-load-development-channels server:parley
//                   lets Parley's MCP server push messages into the session
//                   (Claude Code asks you to confirm this when it starts;
//                   channels are a research preview)
// The MCP server is the one `parley install` added to Claude Code's user
// configuration (install.js), which this launch wakes by setting
// PARLEY_LAUNCH. Before that install the launch passes it with --mcp-config
// instead: everything works but waking, since Claude Code takes a channel
// server only from its own configuration.

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
// let a member's message act without asking, and channels need an
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

// The /parley command. The prompt hook blocks `/parley on` before it
// expands, so this text reaches Claude only when Parley's hooks are not
// running; it then just says so.
const COMMAND = [
  "---",
  "description: Parley in this conversation - on, off or status",
  'argument-hint: "on | off | status"',
  "disable-model-invocation: true",
  "---",
  "",
  "Parley's hooks did not handle this command, so Parley is not running in this session. Tell the user in one line to start Claude Code with `parley` (not `claude`) to use it here. Do nothing else.",
  "",
].join("\n");

export function launchFiles({
  paths,
  launchId,
  nodePath = process.execPath,
  cliPath,
  env = process.env,
  installed = false,
}) {
  const dir = join(paths.claude, launchId);
  const hook = (event) => ({
    type: "command",
    command: forward(nodePath),
    args: [forward(cliPath), "hook", event, "--launch", launchId],
    timeout: 10,
  });
  const own = rulePath(paths.root);
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [hook("session-start")] }],
      UserPromptSubmit: [{ hooks: [hook("user-prompt")] }],
      PreToolUse: [{ matcher: "*", hooks: [hook("pre-tool-use")] }],
      Stop: [{ hooks: [hook("stop")] }],
      SessionEnd: [{ hooks: [hook("session-end")] }],
    },
    permissions: {
      deny: [`Read(${own}/**)`, `Edit(${own}/**)`, `Write(${own}/**)`],
    },
  };
  const mcp = installed
    ? null
    : {
        mcpServers: {
          parley: {
            type: "stdio",
            command: forward(nodePath),
            args: [forward(cliPath), "mcp", "--launch", launchId],
            env: env.PARLEY_HOME ? { PARLEY_HOME: env.PARLEY_HOME } : {},
          },
        },
      };
  const plugin = join(dir, "plugin");
  return {
    dir,
    settingsFile: join(dir, "settings.json"),
    mcpFile: mcp ? join(dir, "mcp.json") : null,
    pluginDir: plugin,
    settings,
    mcp,
    pluginFiles: {
      [join(plugin, ".claude-plugin", "plugin.json")]:
        JSON.stringify(
          {
            name: "parley",
            description: "The /parley command of a parley launch",
            version: "0.1.0",
          },
          null,
          2,
        ) + "\n",
      [join(plugin, "commands", "parley.md")]: COMMAND,
    },
  };
}

export function claudeArgs(files, args) {
  return [
    "--settings",
    files.settingsFile,
    ...(files.mcpFile ? ["--mcp-config", files.mcpFile] : []),
    "--plugin-dir",
    files.pluginDir,
    "--dangerously-load-development-channels",
    "server:parley",
    ...args,
  ];
}

export async function launch({
  paths,
  args,
  cwd = process.cwd(),
  env = process.env,
  cliPath,
  stderr = process.stderr,
}) {
  checkArgs(args);
  const claude = resolveClaude({ env, home: paths.home });
  const launchId = randomBytes(12).toString("base64url");
  const installed = Boolean(installedEntry({ env, home: paths.home }));
  // What the room last said about versions (no network here).
  try {
    const project = projectFor(paths, cwd);
    const room = project && loadRoom(paths, project.roomId);
    if (room)
      for (const line of notices(room))
        stderr.write(`parley: ${line}
`);
  } catch (error) {
    stderr.write(`parley: ${error.message}
`);
  }
  if (!installed)
    stderr.write(
      "parley: run `parley install` once so new messages can wake this session; until then Claude reads them when it checks the inbox.\n",
    );
  const files = launchFiles({ paths, launchId, cliPath, env, installed });
  mkdirSync(files.dir, { recursive: true });
  writeJsonAtomic(files.settingsFile, files.settings);
  if (files.mcp) writeJsonAtomic(files.mcpFile, files.mcp);
  for (const [file, text] of Object.entries(files.pluginFiles))
    writeFileAtomic(file, text);
  updateLaunch(paths, launchId, (l) => {
    l.pid = process.pid;
    l.cwd = cwd;
    l.started = Date.now();
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
          env: { ...env, PARLEY_LAUNCH: launchId },
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
