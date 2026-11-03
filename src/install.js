import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolveClaude } from "./claude-path.js";
import { readJson } from "./fsutil.js";
import { forward } from "./paths.js";

// `parley install`: Parley's MCP server in Claude Code's user configuration,
// added and removed with Claude Code's own `claude mcp` commands. It has to
// live there: Claude Code takes a channel server (the one that wakes a
// session) only from a project's .mcp.json or the user configuration, not
// from --mcp-config. Outside a `parley` launch the server is dormant: it
// offers no tools and no instructions and connects to nothing.

export class InstallError extends Error {}

export const SERVER = "parley";

export function serverEntry({ nodePath = process.execPath, cliPath }) {
  return {
    type: "stdio",
    command: forward(nodePath),
    args: [forward(cliPath), "mcp"],
  };
}

const claudeJson = (env, home) =>
  join(env.CLAUDE_CONFIG_DIR || home, ".claude.json");

// The entry Claude Code has for Parley's server, or null.
export function installedEntry({ env = process.env, home }) {
  return readJson(claudeJson(env, home), {})?.mcpServers?.[SERVER] ?? null;
}

export function isCurrent(entry, wanted) {
  return (
    entry?.command === wanted.command &&
    JSON.stringify(entry?.args ?? []) === JSON.stringify(wanted.args)
  );
}

function claude(args, { env, home }) {
  const found = resolveClaude({ env, home });
  const result = spawnSync(found.command, [...found.prefix, ...args], {
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

export function install({ env = process.env, home, cliPath, nodePath }) {
  const wanted = serverEntry({ nodePath, cliPath });
  const current = installedEntry({ env, home });
  if (isCurrent(current, wanted)) return { action: "same", entry: wanted };
  if (current)
    claude(["mcp", "remove", "--scope", "user", SERVER], { env, home });
  const added = claude(
    ["mcp", "add-json", "--scope", "user", SERVER, JSON.stringify(wanted)],
    { env, home },
  );
  if (!added.ok)
    throw new InstallError(`claude mcp add-json failed: ${added.out}`);
  return { action: current ? "update" : "add", entry: wanted };
}

export function uninstall({ env = process.env, home }) {
  if (!installedEntry({ env, home })) return { action: "none" };
  const removed = claude(["mcp", "remove", "--scope", "user", SERVER], {
    env,
    home,
  });
  if (!removed.ok)
    throw new InstallError(`claude mcp remove failed: ${removed.out}`);
  return { action: "remove" };
}
