import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  CryptoError,
  b64u,
  fingerprint,
  memberId,
  newIdentity,
  openEnvelope,
  openOuter,
  roomKeys,
  sealEnvelope,
  sealOuter,
  unb64u,
  validIdentity,
} from "./crypto.js";
import { readJson, writeJsonAtomic } from "./fsutil.js";
import { roomDir } from "./paths.js";
import { cleanLine } from "./inbound.js";
import { PATCH_MAX, TEXT_MAX, isInside } from "./egress.js";

// Identities, rooms and what was said in them, all under ~/.parley.
//
// A room is one project shared by a few people. room.json holds its secret,
// its relay and its members; each member is pending (they knocked, or wrote
// before anyone here approved them), approved (a person here said yes, or
// they sent the invite), or blocked. Only approved members are written to
// and listened to. log.jsonl is every message read or sent, in the order it
// arrived, and is also the inbox: read.json says how much of it the agent
// has seen.

export class RoomError extends Error {}

const PENDING_MAX = 20;

export function loadIdentity(paths) {
  const identity = readJson(paths.identity);
  return identity && validIdentity(identity) ? identity : null;
}

export function createIdentity(paths, name) {
  const identity = newIdentity(cleanLine(name, 64));
  writeJsonAtomic(paths.identity, identity, { private: true });
  return identity;
}

export const describeMember = (m) => ({
  id: memberId(m.sign),
  name: m.name,
  fingerprint: fingerprint(m.sign, m.box),
});

// ---- Which project is in which room -----------------------------------------

const projectKey = (root) =>
  process.platform === "win32" ? root.toLowerCase() : root;

export function roomForProject(paths, root) {
  const projects = readJson(paths.projects, {});
  return projects[projectKey(root)] ?? null;
}

// The project `dir` is in: itself or the nearest folder above it that is in
// a room, as { root, roomId }, or null.
export function projectFor(paths, dir) {
  let current;
  try {
    current = realpathSync.native(resolve(dir));
  } catch {
    return null;
  }
  const projects = readJson(paths.projects, {});
  for (;;) {
    const roomId = projects[projectKey(current)];
    if (roomId) return { root: current, roomId };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function bindProject(paths, root, roomId) {
  const projects = readJson(paths.projects, {});
  const key = projectKey(root);
  if (projects[key] && projects[key] !== roomId)
    throw new RoomError(
      "This folder is already in another Parley room; `parley leave` first.",
    );
  projects[key] = roomId;
  writeJsonAtomic(paths.projects, projects);
}

export function unbindProject(paths, root) {
  const projects = readJson(paths.projects, {});
  delete projects[projectKey(root)];
  writeJsonAtomic(paths.projects, projects);
}

// ---- Rooms -------------------------------------------------------------------

export const roomFile = (paths, roomId) =>
  join(roomDir(paths, roomId), "room.json");

export function loadRoom(paths, roomId) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(roomId ?? "")) return null;
  const room = readJson(roomFile(paths, roomId));
  if (!room || room.roomId !== roomId) return null;
  return room;
}

export function saveRoom(paths, room) {
  writeJsonAtomic(roomFile(paths, room.roomId), room, { private: true });
}

// Changes a room by reading it fresh, so two processes adding members do not
// undo each other.
export function updateRoom(paths, roomId, change) {
  const room = loadRoom(paths, roomId);
  if (!room) throw new RoomError("That room is gone.");
  const result = change(room);
  saveRoom(paths, room);
  return result;
}

export function newRoom({
  secret,
  relay,
  relayKey = "",
  name,
  root,
  now = Date.now(),
}) {
  const { roomId } = roomKeys(secret);
  return {
    v: 1,
    roomId,
    name: cleanLine(name, 64) || "project",
    relay,
    relayKey,
    secret: b64u(secret),
    project: root,
    created: new Date(now).toISOString(),
    members: {},
  };
}

export const keysOf = (room) => roomKeys(unb64u(room.secret, 32));

export const approvedMembers = (room) =>
  Object.entries(room.members)
    .filter(([, m]) => m.status === "approved")
    .map(([id, m]) => ({ id, ...m }));

export const pendingMembers = (room) =>
  Object.entries(room.members)
    .filter(([, m]) => m.status === "pending")
    .map(([id, m]) => ({ id, ...m }));

export function addMember(
  room,
  { sign, box, name },
  status,
  via,
  now = Date.now(),
) {
  const id = memberId(sign);
  const existing = room.members[id];
  if (existing) {
    // The signing key is the identity; a new encryption key under it is a
    // change nobody here agreed to, so the member goes back to pending.
    if (existing.box !== box) {
      room.members[id] = {
        ...existing,
        box,
        status: "pending",
        via: "key change",
        since: new Date(now).toISOString(),
      };
      return { id, changed: true };
    }
    return { id, changed: false };
  }
  room.members[id] = {
    name: cleanLine(name, 64) || "someone",
    sign,
    box,
    fingerprint: fingerprint(sign, box),
    status,
    via,
    since: new Date(now).toISOString(),
  };
  return { id, changed: true };
}

// The member that `who` names: an id, a name (when only one has it), or the
// start of a fingerprint.
export function findMember(room, who, status = null) {
  const wanted = String(who ?? "")
    .trim()
    .toLowerCase();
  const candidates = Object.entries(room.members)
    .filter(([, m]) => !status || m.status === status)
    .filter(
      ([id, m]) =>
        id.toLowerCase() === wanted ||
        m.name.toLowerCase() === wanted ||
        (wanted.replace(/\s/g, "").length >= 4 &&
          m.fingerprint
            .replace(/\s/g, "")
            .toLowerCase()
            .startsWith(wanted.replace(/\s/g, ""))),
    );
  if (candidates.length > 1)
    throw new RoomError(
      `More than one member matches "${who}"; use the fingerprint.`,
    );
  return candidates[0] ? { id: candidates[0][0], ...candidates[0][1] } : null;
}

// ---- The log -----------------------------------------------------------------

const logFile = (paths, roomId) => join(roomDir(paths, roomId), "log.jsonl");
const readFile = (paths, roomId) => join(roomDir(paths, roomId), "read.json");
const cursorFile = (paths, roomId) =>
  join(roomDir(paths, roomId), "cursor.json");

export function readLog(paths, roomId) {
  let text = "";
  try {
    text = readFileSync(logFile(paths, roomId), "utf8");
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry?.id || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    } catch {}
  }
  return out;
}

export function appendLog(paths, roomId, entry) {
  mkdirSync(roomDir(paths, roomId), { recursive: true });
  appendFileSync(logFile(paths, roomId), JSON.stringify(entry) + "\n", {
    mode: 0o600,
  });
}

export const readPointer = (paths, roomId) =>
  readJson(readFile(paths, roomId), { read: [] });

// Entries from others the agent has not seen yet.
export function unread(paths, roomId) {
  const read = new Set(readPointer(paths, roomId).read);
  return readLog(paths, roomId).filter((e) => !e.own && !read.has(e.id));
}

export function markRead(paths, roomId, ids) {
  const pointer = readPointer(paths, roomId);
  const all = new Set([...pointer.read, ...ids]);
  // Only ids still in the log are worth remembering.
  const live = new Set(readLog(paths, roomId).map((e) => e.id));
  writeJsonAtomic(readFile(paths, roomId), {
    read: [...all].filter((id) => live.has(id)),
  });
}

export const loadCursor = (paths, roomId) =>
  readJson(cursorFile(paths, roomId), { cursor: 0 }).cursor || 0;

export function saveCursor(paths, roomId, cursor) {
  if (cursor > loadCursor(paths, roomId))
    writeJsonAtomic(cursorFile(paths, roomId), { cursor });
}

// ---- Bodies ------------------------------------------------------------------

const isText = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const HEX_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// A body as it may be kept, or null. Nothing a peer sends is trusted to have
// the shape it should.
export function validBody(kind, body) {
  if (!body || typeof body !== "object") return null;
  if (kind === "message" || kind === "note")
    return isText(body.text, TEXT_MAX) ? { text: body.text } : null;
  if (kind === "diff") {
    if (
      !isText(body.patch, PATCH_MAX + 1024) ||
      !HEX_RE.test(body.base ?? "") ||
      !Array.isArray(body.files)
    )
      return null;
    const files = body.files
      .slice(0, 500)
      .flatMap((f) =>
        f &&
        isText(f.path, 1024) &&
        Number.isSafeInteger(f.added) &&
        Number.isSafeInteger(f.removed)
          ? [{ path: f.path, added: f.added, removed: f.removed }]
          : [],
      );
    return {
      base: body.base,
      files,
      patch: body.patch,
      note: isText(body.note, TEXT_MAX) ? body.note : "",
    };
  }
  return null;
}

// ---- In and out --------------------------------------------------------------

// One blob from the relay: opened, checked against the members, and logged
// when it is for this person from someone approved. Returns what happened:
// { kind: "entry", entry } | { kind: "knock", member } | { kind: "skip", why }.
export function receive(
  paths,
  identity,
  roomId,
  { c, at, blob },
  now = Date.now(),
) {
  const room = loadRoom(paths, roomId);
  if (!room) return { kind: "skip", why: "no room" };
  const { key } = keysOf(room);
  let opened;
  try {
    const envelope = openOuter(key, roomId, blob);
    if (envelope?.from === memberId(identity.sign.pub))
      return { kind: "skip", why: "own" };
    opened = openEnvelope(envelope, { identity, roomId, now });
  } catch (error) {
    if (error instanceof CryptoError || error instanceof SyntaxError)
      return { kind: "skip", why: "unreadable" };
    throw error;
  }
  const { head, body } = opened;
  const member = room.members[head.from];
  if (!member || member.box !== head.box) {
    // Someone holding the invite can knock as often as they like; past a
    // few unanswered knocks, more are dropped.
    if (!member && pendingMembers(room).length >= PENDING_MAX)
      return { kind: "skip", why: "too many knocks" };
    const added = updateRoom(paths, roomId, (fresh) =>
      addMember(fresh, head, "pending", "knocked", now),
    );
    return added.changed
      ? {
          kind: "knock",
          member: {
            id: head.from,
            name: cleanLine(head.name),
            fingerprint: fingerprint(head.sign, head.box),
          },
        }
      : { kind: "skip", why: "pending" };
  }
  if (member.status !== "approved") return { kind: "skip", why: member.status };
  if (head.kind === "join") return { kind: "skip", why: "announce" };
  const kept = body === null ? null : validBody(head.kind, body);
  if (!kept) return { kind: "skip", why: "not for me" };
  if (readLog(paths, roomId).some((e) => e.id === head.id))
    return { kind: "skip", why: "seen" };
  const entry = {
    id: head.id,
    c,
    relayAt: at,
    at: head.at,
    from: head.from,
    name: member.name,
    fingerprint: member.fingerprint,
    kind: head.kind,
    ...kept,
  };
  appendLog(paths, roomId, entry);
  return { kind: "entry", entry };
}

// The blob for `body`, sealed for every approved member, and the log entry to
// keep once the relay has it.
export function prepare(identity, room, kind, body = null, now = Date.now()) {
  const recipients =
    kind === "join"
      ? []
      : approvedMembers(room).map((m) => ({ id: m.id, box: m.box }));
  if (kind !== "join" && !recipients.length)
    throw new RoomError(
      "Nobody in this room is approved yet, so there is no one to send to.",
    );
  const { key, roomId } = keysOf(room);
  const envelope = sealEnvelope({
    identity,
    roomId,
    kind,
    body,
    recipients,
    now,
  });
  return {
    blob: sealOuter(key, roomId, envelope),
    entry: {
      id: envelope.id,
      at: now,
      own: true,
      from: envelope.from,
      name: identity.name,
      kind,
      to: recipients.map((r) => r.id),
      ...(body ?? {}),
    },
  };
}

export function projectOf(room, root) {
  return room.project && isInside(room.project, root) ? room.project : null;
}
