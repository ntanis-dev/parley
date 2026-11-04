// Reading Claude Code's command line (2.1.302's `claude --help`): which
// options take values, which words are the first prompt, and
// whether the launch opens an interactive session.

const BOOLEAN = [
  "--allow-dangerously-skip-permissions",
  "--ax-screen-reader",
  "--bg",
  "--background",
  "--bare",
  "--brief",
  "--chrome",
  "-c",
  "--continue",
  "--dangerously-skip-permissions",
  "--desktop",
  "--disable-slash-commands",
  "--exclude-dynamic-system-prompt-sections",
  "--fork-session",
  "--forward-subagent-text",
  "-h",
  "--help",
  "--ide",
  "--include-hook-events",
  "--include-partial-messages",
  "--no-chrome",
  "--no-session-persistence",
  "-p",
  "--print",
  "--replay-user-messages",
  "--restricted",
  "--safe-mode",
  "--strict-mcp-config",
  "--tmux",
  "--verbose",
  "-v",
  "--version",
];
const VALUE = [
  "--agent",
  "--agents",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--autocompact",
  "--debug-file",
  "--effort",
  "--environment",
  "--fallback-model",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--max-turns",
  "--model",
  "-n",
  "--name",
  "--output-format",
  "--permission-mode",
  "--permission-prompt-tool",
  "--permission-prompts",
  "--plugin-dir",
  "--plugin-url",
  "--remote-control-session-name-prefix",
  "--session-id",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--system-prompt-file",
  "--system-prompt-snapshot",
];
const OPTIONAL = [
  "--cloud",
  "-d",
  "--debug",
  "--from-pr",
  "--prompt-suggestions",
  "--remote-control",
  "-r",
  "--resume",
  "--teleport",
  "-w",
  "--worktree",
];
const VARIADIC = [
  "--add-dir",
  "--allowedTools",
  "--allowed-tools",
  "--betas",
  "--disallowedTools",
  "--disallowed-tools",
  "--file",
  "--mcp-config",
  "--tools",
];
const SUBCOMMANDS = [
  "agents",
  "attach",
  "auth",
  "auto-mode",
  "doctor",
  "gateway",
  "help",
  "import",
  "install",
  "kill",
  "logs",
  "mcp",
  "plugin",
  "plugins",
  "purge",
  "respawn",
  "rm",
  "setup-token",
  "stop",
  "ultrareview",
  "update",
  "upgrade",
];
const ALIASES = {
  "-c": "--continue",
  "-d": "--debug",
  "-h": "--help",
  "-n": "--name",
  "-p": "--print",
  "-r": "--resume",
  "-v": "--version",
  "-w": "--worktree",
  "--background": "--bg",
  "--allowed-tools": "--allowedTools",
  "--disallowed-tools": "--disallowedTools",
};
const kind = (flag) =>
  BOOLEAN.includes(flag)
    ? "boolean"
    : VALUE.includes(flag)
      ? "value"
      : OPTIONAL.includes(flag)
        ? "optional"
        : VARIADIC.includes(flag)
          ? "variadic"
          : "unknown";

const isFlag = (token) =>
  typeof token === "string" && token.startsWith("-") && token !== "-";

// parseClaudeArgs(args) -> { options: [{ flag, name, values, raw }], positionals,
//   subcommand, session: { mode: new|resume|continue|picker|fork, id }, interactive }
export function parseClaudeArgs(args) {
  const options = [];
  const positionals = [];
  let subcommand = null;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!isFlag(token)) {
      if (
        !options.length &&
        !positionals.length &&
        SUBCOMMANDS.includes(token)
      ) {
        subcommand = token;
        positionals.push(...args.slice(i + 1));
        break;
      }
      positionals.push(token);
      continue;
    }
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq > 0 ? token.slice(0, eq) : token;
    const name = ALIASES[flag] ?? flag;
    const raw = [token];
    const values = [];
    const k = kind(flag);
    if (eq > 0) values.push(token.slice(eq + 1));
    else if (k === "value") {
      if (i + 1 < args.length) {
        values.push(args[++i]);
        raw.push(args[i]);
      }
    } else if (k === "optional") {
      if (i + 1 < args.length && !isFlag(args[i + 1])) {
        values.push(args[++i]);
        raw.push(args[i]);
      }
    } else if (k === "variadic") {
      while (i + 1 < args.length && !isFlag(args[i + 1])) {
        values.push(args[++i]);
        raw.push(args[i]);
      }
    }
    options.push({ flag, name, values, raw });
  }
  const has = (n) => options.some((o) => o.name === n);
  const value = (n) => options.findLast((o) => o.name === n)?.values[0];
  let session = { mode: "new", id: value("--session-id") ?? null };
  if (has("--resume")) {
    const target = value("--resume");
    session = target
      ? { mode: "resume", id: target }
      : { mode: "picker", id: null };
  } else if (has("--continue")) session = { mode: "continue", id: null };
  if (has("--fork-session") && session.mode !== "new")
    session = { mode: "fork", id: null };
  const passthrough =
    !!subcommand ||
    [
      "--print",
      "--help",
      "--version",
      "--bg",
      "--desktop",
      "--cloud",
      "--teleport",
      "--from-pr",
    ].some(has);
  return {
    options,
    positionals,
    subcommand,
    session,
    interactive: !passthrough,
  };
}
