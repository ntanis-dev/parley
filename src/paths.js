import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Where everything lives. "home" is the user's home directory (PARLEY_HOME
// overrides it, which the tests use). Parley's own state is in ~/.parley and
// nowhere else: it writes nothing into a project folder and nothing into
// ~/.claude. A `parley` launch hands Claude Code its hooks and its MCP
// server through ~/.parley/claude/, so plain `claude` never sees Parley.
export const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function resolveHome(env = process.env) {
  return resolve(env.PARLEY_HOME || homedir());
}

export function parleyPaths(home) {
  const root = join(home, ".parley");
  return {
    home,
    root,
    // This person's keys: who they are to the other members.
    identity: join(root, "identity.json"),
    // This person's settings (config.js).
    config: join(root, "config.json"),
    // Which project folder is in which room.
    projects: join(root, "projects.json"),
    // One folder per room: its keys, members and messages.
    rooms: join(root, "rooms"),
    // One file per conversation: on or off, and whose turn it is.
    sessions: join(root, "sessions"),
    // One file per `parley` launch: which conversation it is on right now.
    launches: join(root, "launches"),
    // The settings and MCP configuration a `parley` launch passes to claude.
    claude: join(root, "claude"),
    log: join(root, "parley.log"),
  };
}

export const pathsFor = (env = process.env) => parleyPaths(resolveHome(env));

export const roomDir = (paths, roomId) => join(paths.rooms, roomId);

export const forward = (path) => String(path).replace(/\\/g, "/");
