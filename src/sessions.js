import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./fsutil.js";
import { ID_RE } from "./paths.js";

// Conversations and launches.
//
// A launch is one `parley` run of claude, and Parley is on in it. Its hooks
// say which conversation (Claude Code's session id) it is on right now (that
// changes with /resume and /clear), and its MCP server reads that to know
// which conversation it serves. The launch file also holds the message watch
// and what the status line shows.
//
// A conversation records whose turn it is. A turn the person started may do
// anything the person allows. A turn a member's message started (Parley woke
// the session) may read and talk through Parley, nothing more, until the
// person writes again.

export const sessionFile = (paths, id) => join(paths.sessions, `${id}.json`);
export const launchFile = (paths, id) => join(paths.launches, `${id}.json`);

export const readSession = (paths, id) =>
  ID_RE.test(id ?? "") ? readJson(sessionFile(paths, id)) : null;

export function updateSession(paths, id, change) {
  if (!ID_RE.test(id ?? "")) return null;
  const session = readJson(sessionFile(paths, id)) ?? { sessionId: id };
  change(session);
  session.updatedAt = Date.now();
  writeJsonAtomic(sessionFile(paths, id), session);
  return session;
}

export const readLaunch = (paths, id) =>
  ID_RE.test(id ?? "") ? readJson(launchFile(paths, id)) : null;

export function updateLaunch(paths, id, change) {
  if (!ID_RE.test(id ?? "")) return null;
  const launch = readJson(launchFile(paths, id)) ?? { launchId: id };
  change(launch);
  launch.updatedAt = Date.now();
  writeJsonAtomic(launchFile(paths, id), launch);
  return launch;
}

// A turn counts as running for at most this long without a Stop: an
// interrupted turn (Esc) never sends one.
const TURN_STALE_MS = 15 * 60 * 1000;

export const isBusy = (session, now = Date.now()) =>
  Boolean(session?.busySince) && now - session.busySince < TURN_STALE_MS;

// The turn running now was started by Parley waking the session, and the
// person has not written since. A wake in the same millisecond as the
// person's prompt counts as the peer's: when unsure, the turn may only read.
export const isPeerTurn = (session) =>
  Boolean(session?.peerAt) && session.peerAt >= (session.humanAt ?? 0);

// Waking a session costs a turn, so it is spaced out and capped: at most
// WAKES_PER_HOUR wakes since the person last wrote, at least WAKE_GAP_MS
// apart. Past the cap, messages wait in the inbox for the person.
export const WAKE_GAP_MS = 20_000;
export const WAKES_PER_HOUR = 12;

export function canWake(session, now = Date.now()) {
  if (!session || isBusy(session, now)) return { ok: false, why: "busy" };
  if (session.permissionMode === "bypassPermissions")
    return { ok: false, why: "bypass" };
  const since = Math.max(session.humanAt ?? 0, now - 60 * 60 * 1000);
  const wakes = (session.wakes ?? []).filter((t) => t > since);
  if (wakes.length >= WAKES_PER_HOUR) return { ok: false, why: "cap" };
  if (wakes.length && now - wakes[wakes.length - 1] < WAKE_GAP_MS)
    return {
      ok: false,
      why: "gap",
      retryAt: wakes[wakes.length - 1] + WAKE_GAP_MS,
    };
  return { ok: true };
}

export function recordWake(session, now = Date.now()) {
  session.peerAt = now;
  session.busySince = now;
  session.wakes = [
    ...(session.wakes ?? []).filter((t) => t > now - 60 * 60 * 1000),
    now,
  ];
}

// The `parley` launches still running (their process is alive).
export function runningLaunches(paths) {
  let files = [];
  try {
    files = readdirSync(paths.launches);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(join(paths.launches, f)))
    .filter((l) => {
      if (!l?.pid || l.endedAt || typeof l.cwd !== "string") return false;
      try {
        process.kill(l.pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    });
}
