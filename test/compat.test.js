import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  KINDS,
  memberId,
  newRoomSecret,
  roomKeys,
  sealEnvelope,
  sealOuter,
} from "../src/crypto.js";
import { startRelay } from "../src/relay/server.js";
import { VERSION, WIRE, compareVersions, shared } from "../src/version.js";
import { markAnnounced, notices, presenceDue } from "../src/compat.js";
import {
  addMember,
  createIdentity,
  loadRoom,
  newRoom,
  receive,
  saveRoom,
} from "../src/rooms.js";
import { tempHome, until, write } from "./helpers.js";

test("the version in code is the package's, and versions compare", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(VERSION, pkg.version);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(shared({ min: 1, max: 3 }, { min: 2, max: 5 }), 3);
  assert.equal(shared({ min: 4, max: 5 }, { min: 1, max: 3 }), null);
});

// A raw hello to a relay, and what comes back.
async function hello(port, frame) {
  const { roomId } = roomKeys(newRoomSecret());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/rooms/${roomId}`);
  const frames = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data)));
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(
    JSON.stringify({
      t: "hello",
      token: randomBytes(32).toString("base64url"),
      after: 0,
      ...frame,
    }),
  );
  await until(() => frames.some((f) => f.t === "ready" || f.t === "error"));
  return { ws, frames };
}

test("the relay settles on a shared protocol, or says who is behind", async (t) => {
  const relay = await startRelay({ port: 0, data: ":memory:" });
  t.after(() => relay.close());
  // A newer client that still speaks v1.
  const newer = await hello(relay.port, {
    v: WIRE.max + 1,
    vmin: WIRE.min,
    app: "9.0.0",
  });
  const ready = newer.frames.find((f) => f.t === "ready");
  assert.equal(ready.wire, WIRE.max);
  assert.deepEqual(ready.relay, {
    app: VERSION,
    wire: WIRE,
    features: ["pulse"],
  });
  // A frame this relay does not know: an error, and the socket stays open.
  newer.ws.send(JSON.stringify({ t: "claim", path: "src" }));
  newer.ws.send(JSON.stringify({ t: "ping" }));
  await until(() => newer.frames.some((f) => f.t === "pong"));
  assert.equal(newer.frames.find((f) => f.t === "error").code, "unknown-frame");
  newer.ws.close();
  // A client that no longer speaks anything this relay does.
  const ahead = await hello(relay.port, {
    v: WIRE.max + 5,
    vmin: WIRE.max + 5,
  });
  const refused = ahead.frames.find((f) => f.t === "error");
  assert.equal(refused.code, "version");
  assert.match(refused.message, /its host needs to update it/);
  const behind = await hello(relay.port, {
    v: WIRE.min - 1,
    vmin: WIRE.min - 1,
  });
  assert.match(
    behind.frames.find((f) => f.t === "error").message,
    /needs a newer Parley/,
  );
});

// Bob's view of a room where Alice is approved, and blobs from Alice.
function pair(t) {
  const { paths } = tempHome(t);
  const alice = createIdentity(paths, "Alice");
  const bob = createIdentity(tempHome(t).paths, "Bob");
  const secret = newRoomSecret();
  const room = newRoom({
    secret,
    relay: "wss://relay.example",
    name: "shop",
    root: "/x",
  });
  addMember(
    room,
    { name: "Alice", sign: alice.sign.pub, box: alice.box.pub },
    "approved",
    "invite",
  );
  saveRoom(paths, room);
  const { key, roomId } = roomKeys(secret);
  const toBob = [{ id: memberId(bob.sign.pub), box: bob.box.pub }];
  const from = (kind, body, tweak = (e) => e) =>
    sealOuter(
      key,
      roomId,
      tweak(
        sealEnvelope({
          identity: alice,
          roomId,
          kind,
          body,
          recipients: toBob,
        }),
      ),
    );
  const take = (blob) =>
    receive(paths, bob, roomId, { c: 1, at: Date.now(), blob });
  return { paths, roomId, from, take, aliceId: memberId(alice.sign.pub) };
}

test("a member's version arrives in a presence message, and newer means update", (t) => {
  const { paths, roomId, from, take, aliceId } = pair(t);
  assert.equal(
    take(
      from("presence", {
        app: VERSION,
        envelope: { min: 1, max: 1 },
        wire: WIRE,
      }),
    ).kind,
    "presence",
  );
  assert.equal(loadRoom(paths, roomId).versions.members[aliceId].app, VERSION);
  assert.deepEqual(notices(loadRoom(paths, roomId)), []);
  take(
    from("presence", {
      app: "9.1.0",
      envelope: { min: 1, max: 2 },
      wire: WIRE,
    }),
  );
  assert.match(
    notices(loadRoom(paths, roomId))[0],
    /^Alice uses Parley 9\.1\.0, newer than yours .*parley update/,
  );
  take(
    from("presence", {
      app: "0.1.5",
      envelope: { min: 1, max: 1 },
      wire: WIRE,
    }),
  );
  assert.match(
    notices(loadRoom(paths, roomId))[0],
    /^Alice uses Parley 0\.1\.5, older than yours/,
  );
});

test("what a newer member sends that this version cannot read becomes a notice", (t) => {
  const { paths, roomId, from, take } = pair(t);
  KINDS.add("claim");
  const claim = from("claim", { path: "src/cart" });
  KINDS.delete("claim");
  assert.equal(take(claim).why, "unknown kind");
  assert.match(
    notices(loadRoom(paths, roomId))[0],
    /sent things yours cannot read \(claim\)/,
  );
  const future = from("message", { text: "hi" }, (e) => ({ ...e, v: 2 }));
  assert.equal(take(future).why, "newer format");
  // Once this version reads that kind (after an update), the notice goes.
  KINDS.add("claim");
  try {
    assert.match(
      notices(loadRoom(paths, roomId))[0],
      /writes messages yours cannot read/,
    );
  } finally {
    KINDS.delete("claim");
  }
});

test("presence is said again when the version or the members change", () => {
  const room = { members: { a: { status: "approved" } } };
  assert.equal(presenceDue(room), true);
  markAnnounced(room);
  assert.equal(presenceDue(room), false);
  room.members.b = { status: "approved" };
  assert.equal(presenceDue(room), true);
  assert.equal(presenceDue({ members: {} }), false);
});

test("old rooms load with defaults; rooms from a newer Parley are refused", (t) => {
  const { paths } = tempHome(t);
  const room = newRoom({
    secret: newRoomSecret(),
    relay: "wss://r.example",
    name: "old",
    root: "/x",
  });
  delete room.tags;
  saveRoom(paths, room);
  const loaded = loadRoom(paths, room.roomId);
  assert.deepEqual(loaded.tags, []);
  assert.deepEqual(loaded.versions, {});
  write(`${paths.rooms}/${room.roomId}/room.json`, { ...room, v: 2 });
  assert.throws(() => loadRoom(paths, room.roomId), /saved by a newer Parley/);
});
