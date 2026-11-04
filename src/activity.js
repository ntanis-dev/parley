import { join } from "node:path";
import {
  CryptoError,
  memberId,
  openEnvelope,
  openOuter,
  sealEnvelope,
  sealOuter,
} from "./crypto.js";
import { readJson, writeJsonAtomic } from "./fsutil.js";
import { roomDir } from "./paths.js";
import { approvedMembers, keysOf } from "./rooms.js";

// Who in the room is around right now, and whether their Claude is working
// or idle. Each running `parley` session sends a pulse (a sealed, signed
// envelope of kind "pulse", for the approved members only) when its state
// changes and once a minute otherwise; the relay hands pulses to whoever is
// connected at that moment and keeps none. A member with no pulse for a
// while is offline. What was last heard is kept in the room's activity.json,
// so the status line and `parley status` can show it.

export const STATES = new Set(["working", "idle", "offline"]);
export const PULSE_MS = 60_000;
// No pulse for this long: offline.
export const STALE_MS = 150_000;
// Pulses from one session are at least this far apart.
export const PULSE_GAP_MS = 5_000;

const activityFile = (paths, roomId) =>
  join(roomDir(paths, roomId), "activity.json");

export const readActivity = (paths, roomId) =>
  readJson(activityFile(paths, roomId), {});

// The pulse blob for `state`, sealed for every approved member, or null when
// there is nobody to tell.
export function pulseBlob(identity, room, state, now = Date.now()) {
  const recipients = approvedMembers(room).map((m) => ({
    id: m.id,
    box: m.box,
  }));
  if (!recipients.length) return null;
  const { key, roomId } = keysOf(room);
  return sealOuter(
    key,
    roomId,
    sealEnvelope({
      identity,
      roomId,
      kind: "pulse",
      body: { state },
      recipients,
      now,
    }),
  );
}

// A pulse from an approved member, as { id, state, at }, or null.
export function openPulse(identity, room, blob, now = Date.now()) {
  try {
    const { key, roomId } = keysOf(room);
    const envelope = openOuter(key, roomId, blob);
    if (envelope?.from === memberId(identity.sign.pub)) return null;
    const { head, body } = openEnvelope(envelope, { identity, roomId, now });
    const member = room.members[head.from];
    if (
      head.kind !== "pulse" ||
      member?.status !== "approved" ||
      member.box !== head.box ||
      !STATES.has(body?.state) ||
      now - head.at > STALE_MS
    )
      return null;
    return { id: head.from, state: body.state, at: head.at };
  } catch (error) {
    if (error instanceof CryptoError || error instanceof SyntaxError)
      return null;
    throw error;
  }
}

export function recordPulse(paths, roomId, { id, state, at }) {
  const activity = readActivity(paths, roomId);
  if ((activity[id]?.at ?? 0) > at) return activity;
  activity[id] = { state, at };
  writeJsonAtomic(activityFile(paths, roomId), activity);
  return activity;
}

// Each approved member's state as of `now`: working, idle or offline (no
// pulse for STALE_MS, or never), with when they were last heard.
export function memberActivity(paths, room, now = Date.now()) {
  const activity = readActivity(paths, room.roomId);
  return approvedMembers(room).map((m) => {
    const seen = activity[m.id];
    const fresh = seen && now - seen.at < STALE_MS;
    return {
      id: m.id,
      name: m.name,
      state: fresh ? seen.state : "offline",
      at: seen?.at ?? null,
    };
  });
}

const ago = (ms) =>
  ms < 90_000
    ? "just now"
    : ms < 90 * 60_000
      ? `${Math.round(ms / 60_000)} min ago`
      : ms < 36 * 3_600_000
        ? `${Math.round(ms / 3_600_000)} h ago`
        : `${Math.round(ms / 86_400_000)} days ago`;

// "working", "offline, seen 5 min ago".
export const activityText = (m, now = Date.now()) =>
  m.state === "offline" && m.at ? `offline, seen ${ago(now - m.at)}` : m.state;

// "Jo (working)", "Alex (offline, seen 5 min ago)".
export const describeActivity = (m, now = Date.now()) =>
  `${m.name} (${activityText(m, now)})`;
