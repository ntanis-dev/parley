import { rmSync } from "node:fs";
import { RelayError, RoomConnection, relayUrl } from "./client.js";
import {
  decodeInvite,
  encodeInvite,
  memberId,
  newRoomSecret,
  roomKeys,
} from "./crypto.js";
import { roomDir } from "./paths.js";
import {
  RoomError,
  addMember,
  bindProject,
  keysOf,
  loadCursor,
  loadRoom,
  newRoom,
  prepare,
  projectFor,
  receive,
  saveCursor,
  saveRoom,
  unbindProject,
  updateRoom,
} from "./rooms.js";

// What the person does from a terminal: open a room, join one, let someone
// in. These run in the CLI, never in the agent's tools.

// Opens the room's connection, reads everything the relay holds since the
// last cursor (keeping what is for this person), runs `fn(conn)`, and closes.
export async function withRoom(
  paths,
  identity,
  room,
  fn = async () => {},
  { timeoutMs = 15_000 } = {},
) {
  const { roomId, token } = keysOf(room);
  let conn;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new RelayError(
            "timeout",
            `No answer from the relay at ${room.relay}.`,
          ),
        ),
      timeoutMs,
    );
    conn = new RoomConnection({
      relay: room.relay,
      roomId,
      token,
      relayKey: room.relayKey,
      cursor: loadCursor(paths, roomId),
      onMessage: (msg) => {
        try {
          receive(paths, identity, roomId, msg);
          saveCursor(paths, roomId, msg.c);
        } catch {}
      },
      onState: (state, detail) => {
        if (state === "refused") {
          clearTimeout(timer);
          reject(new RelayError("refused", `The relay refused: ${detail}`));
        }
      },
      onSynced: () => {
        clearTimeout(timer);
        resolve();
      },
    });
    conn.start();
  });
  try {
    await ready;
    return await fn(conn);
  } finally {
    conn.stop();
  }
}

async function announce(paths, identity, room) {
  await withRoom(paths, identity, room, async (conn) => {
    const { blob } = prepare(identity, room, "join");
    await conn.post(blob);
  });
}

export const inviteFor = (room, identity) =>
  encodeInvite({
    relay: room.relay,
    secret: Buffer.from(room.secret, "base64url"),
    room: room.name,
    by: { name: identity.name, sign: identity.sign.pub, box: identity.box.pub },
  });

function freeFolder(paths, root) {
  const current = projectFor(paths, root);
  if (current && loadRoom(paths, current.roomId))
    throw new RoomError(
      current.root === root
        ? "This folder is already in a Parley room (`parley status` shows it; `parley leave` takes it out)."
        : `This folder is inside ${current.root}, which is already in a Parley room.`,
    );
}

export async function createRoom({
  paths,
  identity,
  root,
  relay,
  relayKey = "",
  name,
}) {
  freeFolder(paths, root);
  const room = newRoom({
    secret: newRoomSecret(),
    relay: relayUrl(relay),
    relayKey,
    name,
    root,
  });
  // The first hello opens the room on the relay (and checks the relay key).
  await withRoom(paths, identity, room);
  saveRoom(paths, room);
  bindProject(paths, root, room.roomId);
  return { room, invite: inviteFor(room, identity) };
}

export function readInvite(code, identity) {
  const invite = decodeInvite(code);
  relayUrl(invite.relay);
  if (invite.by.sign === identity.sign.pub)
    throw new RoomError(
      "That is your own invite; give it to the person who should join.",
    );
  return invite;
}

// The invite's sender is approved by the invite itself: it came from them,
// over whatever channel the two people trust. The person still compares
// fingerprints with them (the CLI asks before calling this).
export async function joinRoom({
  paths,
  identity,
  root,
  invite,
  relayKey = "",
}) {
  freeFolder(paths, root);
  const { roomId } = roomKeys(invite.secret);
  const existing = loadRoom(paths, roomId);
  if (existing)
    throw new RoomError(
      `You are already in this room, from ${existing.project}.`,
    );
  const room = newRoom({
    secret: invite.secret,
    relay: relayUrl(invite.relay),
    relayKey,
    name: invite.room,
    root,
  });
  addMember(room, invite.by, "approved", "invite");
  await announce(paths, identity, room);
  saveRoom(paths, room);
  bindProject(paths, root, room.roomId);
  return room;
}

// Reads what the relay holds, so knocks that came in while no session was
// on show up. Returns the fresh room.
export async function syncRoom(paths, identity, room) {
  await withRoom(paths, identity, room);
  return loadRoom(paths, room.roomId);
}

// Lets a member in (or back in), then announces this person to the room so
// a newcomer learns their keys.
export async function setMemberStatus({ paths, identity, room, id, status }) {
  updateRoom(paths, room.roomId, (fresh) => {
    if (!fresh.members[id]) throw new RoomError("No such member.");
    fresh.members[id].status = status;
    fresh.members[id].via =
      status === "approved" ? "approved" : fresh.members[id].via;
  });
  if (status !== "approved") return { announced: false };
  try {
    await announce(paths, identity, loadRoom(paths, room.roomId));
    return { announced: true };
  } catch (error) {
    return { announced: false, error: error.message };
  }
}

export function leaveRoom(paths, room) {
  unbindProject(paths, room.project);
  rmSync(roomDir(paths, room.roomId), { recursive: true, force: true });
}

export const ownId = (identity) => memberId(identity.sign.pub);
