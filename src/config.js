import { readJson, writeJsonAtomic } from "./fsutil.js";

// This person's settings (not a room's), in ~/.parley/config.json.
//   approvals  false (the default): agents talk on their own; what they send
//              still passes every check in egress.js. true: each message,
//              note and diff also waits for the person to say yes in a
//              dialog.
//   autonomy   what a turn a member's message started may do. "work" (the
//              default): read, talk, and keep the project in step (pull,
//              resolve, commit, push, edit and save project files). "read":
//              read and talk only.

export const DEFAULTS = { approvals: false, autonomy: "work" };
export const AUTONOMY = new Set(["read", "work"]);

export function readConfig(paths) {
  const config = { ...DEFAULTS, ...readJson(paths.config, {}) };
  if (!AUTONOMY.has(config.autonomy)) config.autonomy = "read";
  return config;
}

export function writeConfig(paths, change) {
  const config = readConfig(paths);
  change(config);
  writeJsonAtomic(paths.config, config);
  return config;
}
