import { readJson, writeJsonAtomic } from "./fsutil.js";

// This person's settings (not a room's), in ~/.parley/config.json.
//   approvals  false (the default): agents talk on their own; what they send
//              still passes every check in egress.js. true: each message,
//              note and diff also waits for the person to say yes in a
//              dialog.

export const DEFAULTS = { approvals: false };

export const readConfig = (paths) => ({
  ...DEFAULTS,
  ...readJson(paths.config, {}),
});

export function writeConfig(paths, change) {
  const config = readConfig(paths);
  change(config);
  writeJsonAtomic(paths.config, config);
  return config;
}
