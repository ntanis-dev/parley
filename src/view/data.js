import { homedir } from "node:os";
import { outgoingText, Refusal } from "../egress.js";
import { cleanLine } from "../inbound.js";
import {
  appendLog,
  approvedMembers,
  loadRoom,
  pendingMembers,
  prepare,
  readLog,
} from "../rooms.js";
import { memberActivity } from "../activity.js";
import { activeClaims, sharedMemory } from "../memory.js";
import { memberVersions, notices } from "../compat.js";
import { readConfig } from "../config.js";
import { fingerprint, memberId } from "../crypto.js";
import { runningLaunches } from "../sessions.js";
import { withRoom } from "../ops.js";

// What the view reads and the one thing it writes itself: a message from
// the person.

// Sends `text` from the person themselves (to the room, or to `to` names),
// through the same checks as everything else. Over `conn` when there is
// one, otherwise over a connection opened for it.
export async function sayAsPerson({
  paths,
  identity,
  room,
  text,
  to = [],
  conn = null,
}) {
  const out = outgoingText(text, { root: room.project, home: homedir() });
  const members = approvedMembers(room);
  if (!members.length) throw new Refusal("Nobody else is in this room yet.");
  const only = to.length
    ? to.map((name) => {
        const m = members.find(
          (x) => x.name.toLowerCase() === String(name).toLowerCase(),
        );
        if (!m)
          throw new Refusal(`${cleanLine(name)} is not a member of this room.`);
        return m.id;
      })
    : null;
  const { blob, entry } = prepare(
    identity,
    room,
    "message",
    { text: out, human: true, ...(only ? { to: only } : {}) },
    Date.now(),
    only,
  );
  const post = async (c) => {
    const { c: cursor } = await c.post(blob);
    appendLog(paths, room.roomId, { ...entry, c: cursor });
  };
  if (conn?.state === "connected") await post(conn);
  else await withRoom(paths, identity, room, post);
  const names = members
    .filter((m) => !only || only.includes(m.id))
    .map((m) => m.name);
  return `Sent to ${only ? names.join(", ") : "the room"}.`;
}

// What the screen shows, read fresh: the room, the latest of its log, who
// is around, the shared memory, claims, versions, this person's settings,
// and the connection. With `identity`, who "you" are.
export function snapshot(paths, roomId, conn, identity = null) {
  const room = loadRoom(paths, roomId);
  const config = readConfig(paths);
  return {
    room,
    log: readLog(paths, roomId).slice(-400),
    activity: memberActivity(paths, room),
    pending: pendingMembers(room),
    versions: memberVersions(room),
    memory: sharedMemory(paths, roomId),
    claims: activeClaims(paths, roomId),
    notices: notices(room),
    running: runningLaunches(paths).length,
    relay: conn?.state ?? "offline",
    relayDetail: typeof conn?.detail === "string" ? conn.detail : null,
    autonomy: config.autonomy,
    approvals: config.approvals,
    home: paths.home ?? homedir(),
    ...(identity
      ? {
          you: {
            id: memberId(identity.sign.pub),
            name: identity.name,
            fingerprint: fingerprint(identity.sign.pub, identity.box.pub),
          },
        }
      : {}),
  };
}

// A store the screen redraws from: the snapshot, refreshed every second and
// whenever the connection brings something.
export function makeStore(load) {
  let state = load();
  const listeners = new Set();
  return {
    get: () => state,
    refresh() {
      try {
        state = load();
      } catch {
        // a file mid-write: next time
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
