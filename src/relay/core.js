// The relay's logic, shared by the Node server (server.js, also the Docker
// image) and the Cloudflare Worker (relay/cloudflare). It is a mailbox per
// room: it keeps sealed blobs for a while and hands them to whoever proves
// they were invited. It never holds a key that opens one, so whoever hosts
// it learns sizes and times, and nothing else.
//
// Wire protocol, JSON text frames on a WebSocket at /v1/rooms/<room id>:
//   client: { t: "hello", v, vmin, app, token, after, key? }   first, in 10 s
//           { t: "post", id, blob }   { t: "sync", after }   { t: "ping" }
//           { t: "pulse", blob }
//   relay:  { t: "ready", cursor, created, wire,
//             relay: { app, wire, features } }
//           { t: "msg", c, at, blob }   { t: "ack", id, c, at }
//           { t: "pulse", blob }
//           { t: "synced", cursor, more }   { t: "pong" }
//           { t: "error", code, message }  (it closes after a bad hello)
// v and vmin are the wire versions the client speaks (version.js); the
// relay answers with the highest both speak, or an error with code
// "version" saying which side is behind. A frame the relay does not know
// gets an "unknown-frame" error and the connection stays open, so newer
// clients can try newer frames.
// A pulse (who is around, working or idle; activity.js) goes to the members
// connected at that moment and is not kept.
// A room is created by the first hello that reaches it; from then on only
// that token opens it. A host can require a relay key to create rooms.

import { VERSION, WIRE, shared } from "../version.js";

export const LIMITS = {
  // One sealed message: a 256 KiB diff or a 300 KiB file, sealed twice,
  // in base64 (about 1.8 and 2.4 times the size). Under the 1 MiB a
  // Cloudflare WebSocket message may be.
  blob: 900 * 1024,
  frame: 920 * 1024,
  // Bytes of backlog per batch; the client asks for the next one.
  batchBytes: 4 << 20,
  // What a room keeps, and for how long.
  keep: 1000,
  keepBytes: 48 << 20,
  ttlMs: 14 * 24 * 60 * 60 * 1000,
  // A room nobody opened for this long is forgotten.
  roomIdleMs: 90 * 24 * 60 * 60 * 1000,
  posts: { burst: 30, perMinute: 60 },
  pulses: { burst: 6, perMinute: 12 },
  pulseBlob: 4096,
  socketsPerRoom: 16,
  helloMs: 10_000,
};

export const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const BLOB_RE = /^[A-Za-z0-9_-]+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const ROOM_PATH_RE = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})$/;

export const CLOSE = { normal: 1000, policy: 1008, tooBig: 1009, busy: 1013 };

// Web Crypto, so the same code runs in Node and in a Worker.
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseFrame(text) {
  if (typeof text !== "string" || text.length > LIMITS.frame) return null;
  try {
    const frame = JSON.parse(text);
    return frame && typeof frame === "object" && typeof frame.t === "string"
      ? frame
      : null;
  } catch {
    return null;
  }
}

// A room's storage over a small SQL interface: all(sql, ...params) returns
// rows, run(sql, ...params) returns nothing. Node's node:sqlite and a Durable
// Object's storage.sql both fit it.
export class RoomStore {
  constructor(db) {
    this.db = db;
  }

  init() {
    this.db.run(
      "CREATE TABLE IF NOT EXISTS rooms (room TEXT PRIMARY KEY, token TEXT NOT NULL, created INTEGER NOT NULL, last INTEGER NOT NULL)",
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS messages (room TEXT NOT NULL, c INTEGER NOT NULL, at INTEGER NOT NULL, size INTEGER NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (room, c))",
    );
  }

  room(roomId) {
    return this.db.all("SELECT * FROM rooms WHERE room = ?", roomId)[0] ?? null;
  }

  roomCount() {
    return this.db.all("SELECT COUNT(*) AS n FROM rooms")[0]?.n ?? 0;
  }

  create(roomId, tokenHash, now) {
    this.db.run(
      "INSERT INTO rooms (room, token, created, last) VALUES (?, ?, ?, ?)",
      roomId,
      tokenHash,
      now,
      now,
    );
  }

  touch(roomId, now) {
    this.db.run("UPDATE rooms SET last = ? WHERE room = ?", now, roomId);
  }

  cursor(roomId) {
    return (
      this.db.all("SELECT MAX(c) AS c FROM messages WHERE room = ?", roomId)[0]
        ?.c ?? 0
    );
  }

  append(roomId, blob, now) {
    const c = this.cursor(roomId) + 1;
    this.db.run(
      "INSERT INTO messages (room, c, at, size, blob) VALUES (?, ?, ?, ?, ?)",
      roomId,
      c,
      now,
      blob.length,
      blob,
    );
    this.touch(roomId, now);
    return c;
  }

  // Messages after `cursor`, up to about `bytes` (always at least one).
  after(roomId, cursor, bytes = LIMITS.batchBytes) {
    const out = [];
    let total = 0;
    for (const row of this.db.all(
      "SELECT c, at, size, blob FROM messages WHERE room = ? AND c > ? ORDER BY c LIMIT ?",
      roomId,
      cursor,
      LIMITS.keep,
    )) {
      if (out.length && total + row.size > bytes)
        return { rows: out, more: true };
      out.push(row);
      total += row.size;
    }
    return { rows: out, more: false };
  }

  prune(roomId, now) {
    this.db.run(
      "DELETE FROM messages WHERE room = ? AND at < ?",
      roomId,
      now - LIMITS.ttlMs,
    );
    // The newest messages that fit both limits stay.
    let count = 0;
    let bytes = 0;
    let cutoff = 0;
    for (const row of this.db.all(
      "SELECT c, size FROM messages WHERE room = ? ORDER BY c DESC",
      roomId,
    )) {
      count++;
      bytes += row.size;
      if (count > LIMITS.keep || bytes > LIMITS.keepBytes) {
        cutoff = row.c;
        break;
      }
    }
    if (cutoff)
      this.db.run(
        "DELETE FROM messages WHERE room = ? AND c <= ?",
        roomId,
        cutoff,
      );
  }

  forgetIdle(now) {
    const stale = now - LIMITS.roomIdleMs;
    this.db.run(
      "DELETE FROM messages WHERE room IN (SELECT room FROM rooms WHERE last < ?)",
      stale,
    );
    this.db.run("DELETE FROM rooms WHERE last < ?", stale);
  }
}

// Posts (or pulses) a connection may make: a burst, then a steady rate.
export function takeToken(state, now, kind = "posts") {
  const { burst, perMinute } = LIMITS[kind];
  const at = `${kind}At`;
  const elapsed = Math.max(0, now - (state[at] ?? now));
  state[kind] = Math.min(
    burst,
    (state[kind] ?? burst) + (elapsed * perMinute) / 60_000,
  );
  state[at] = now;
  if (state[kind] < 1) return false;
  state[kind] -= 1;
  return true;
}

// What this relay offers beyond the wire protocol.
export const FEATURES = ["pulse"];

function sendBatch(conn, store, after) {
  const { rows, more } = store.after(conn.state.roomId, after);
  for (const row of rows)
    conn.send({ t: "msg", c: row.c, at: row.at, blob: row.blob });
  conn.send({
    t: "synced",
    cursor: rows.length ? rows[rows.length - 1].c : after,
    more,
  });
}

function refuse(conn, code, message, close = CLOSE.policy) {
  conn.send({ t: "error", code, message });
  conn.close(close, code);
}

// One frame from one connection. `conn` is { state, send(obj),
// close(code, reason) }; state holds { roomId, authed, bucket, bucketAt }.
// `peers()` lists the other authenticated connections of the same room.
// `limits.maxRooms` caps how many rooms this relay holds (0: no cap).
export async function onFrame(
  conn,
  text,
  { store, relayKey = "", peers, now = Date.now(), maxRooms = 0 },
) {
  const frame = parseFrame(text);
  if (!frame)
    return refuse(conn, "bad-frame", "Unreadable frame.", CLOSE.tooBig);
  const { state } = conn;

  if (!state.authed) {
    if (
      frame.t !== "hello" ||
      !Number.isSafeInteger(frame.v) ||
      !TOKEN_RE.test(frame.token ?? "")
    )
      return refuse(conn, "bad-hello", "Say hello first.");
    // The client speaks frame.v at most and frame.vmin (or frame.v) at
    // least. Refuse only when nothing is shared, saying who is behind.
    const client = {
      min: Number.isSafeInteger(frame.vmin) ? frame.vmin : frame.v,
      max: frame.v,
    };
    const wire = shared(client, WIRE);
    if (wire === null) {
      conn.send({
        t: "error",
        code: "version",
        relay: { app: VERSION, wire: WIRE },
        message:
          client.max < WIRE.min
            ? `This relay runs Parley ${VERSION} and needs a newer Parley than yours.`
            : `This relay runs Parley ${VERSION}, older than your Parley; its host needs to update it.`,
      });
      return conn.close(CLOSE.policy, "version");
    }
    state.wire = wire;
    // Every hash first: from here to the end of the hello nothing awaits, so
    // two hellos for a new room cannot both create it.
    const tokenHash = await sha256Hex(`parley-relay-token|${frame.token}`);
    const keyOk =
      !relayKey ||
      sameText(
        await sha256Hex(
          `parley-relay-key|${typeof frame.key === "string" ? frame.key : ""}`,
        ),
        await sha256Hex(`parley-relay-key|${relayKey}`),
      );
    store.forgetIdle(now);
    const room = store.room(state.roomId);
    let created = false;
    if (!room) {
      if (!keyOk)
        return refuse(
          conn,
          "relay-key",
          "This relay needs its relay key to open a new room.",
        );
      if (maxRooms && store.roomCount() >= maxRooms)
        return refuse(
          conn,
          "full",
          "This relay holds as many rooms as it can.",
          CLOSE.busy,
        );
      store.create(state.roomId, tokenHash, now);
      created = true;
    } else if (!sameText(room.token, tokenHash)) {
      return refuse(conn, "auth", "Wrong room token.");
    }
    state.authed = true;
    store.prune(state.roomId, now);
    store.touch(state.roomId, now);
    conn.send({
      t: "ready",
      cursor: store.cursor(state.roomId),
      created,
      wire,
      relay: { app: VERSION, wire: WIRE, features: FEATURES },
    });
    const after =
      Number.isSafeInteger(frame.after) && frame.after > 0 ? frame.after : 0;
    return sendBatch(conn, store, after);
  }

  switch (frame.t) {
    case "ping":
      return conn.send({ t: "pong" });
    case "sync": {
      const after =
        Number.isSafeInteger(frame.after) && frame.after > 0 ? frame.after : 0;
      return sendBatch(conn, store, after);
    }
    case "post": {
      if (
        !ID_RE.test(frame.id ?? "") ||
        typeof frame.blob !== "string" ||
        !BLOB_RE.test(frame.blob)
      )
        return refuse(conn, "bad-post", "Malformed post.");
      if (frame.blob.length > LIMITS.blob)
        return conn.send({
          t: "error",
          code: "too-big",
          id: frame.id,
          message: "Message too large.",
        });
      if (!takeToken(state, now))
        return conn.send({
          t: "error",
          code: "slow-down",
          id: frame.id,
          message: "Too many messages; wait a moment.",
        });
      const c = store.append(state.roomId, frame.blob, now);
      if (c % 50 === 0) store.prune(state.roomId, now);
      conn.send({ t: "ack", id: frame.id, c, at: now });
      for (const peer of peers())
        if (peer !== conn)
          peer.send({ t: "msg", c, at: now, blob: frame.blob });
      return;
    }
    case "pulse": {
      if (
        typeof frame.blob !== "string" ||
        !BLOB_RE.test(frame.blob) ||
        frame.blob.length > LIMITS.pulseBlob ||
        !takeToken(state, now, "pulses")
      )
        return;
      for (const peer of peers())
        if (peer !== conn) peer.send({ t: "pulse", blob: frame.blob });
      return;
    }
    default:
      // A newer client's frame: say so, and stay connected.
      return conn.send({
        t: "error",
        code: "unknown-frame",
        frame: String(frame.t).slice(0, 20),
        message: `This relay (Parley ${VERSION}) does not know that frame.`,
      });
  }
}
