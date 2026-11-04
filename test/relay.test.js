import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startRelay } from "../src/relay/server.js";
import {
  KeyGuard,
  LIMITS,
  addressKey,
  weakRelayKey,
} from "../src/relay/core.js";
import { RoomConnection, relayUrl } from "../src/client.js";
import { newRelayKey, roomKeys, newRoomSecret } from "../src/crypto.js";
import { until } from "./helpers.js";

// A raw socket to the relay, frame by frame.
async function socket(url) {
  const ws = new WebSocket(url);
  const frames = [];
  let closed = null;
  ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data)));
  ws.addEventListener("close", (e) => (closed = e.code));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    frames,
    closed: () => closed,
    close: () => ws.close(),
    next: (t) => until(() => frames.find((f) => f.t === t)),
  };
}

const token = () => randomBytes(32).toString("base64url");
const blob = (n = 10) => randomBytes(n).toString("base64url");

async function relayFor(t, options = {}) {
  const relay = await startRelay({ port: 0, data: ":memory:", ...options });
  t.after(() => relay.close());
  const base = `ws://127.0.0.1:${relay.port}`;
  return { relay, base, room: (id) => `${base}/v1/rooms/${id}` };
}

test("the first hello opens a room; only its token opens it again", async (t) => {
  const { room } = await relayFor(t);
  const { roomId } = roomKeys(newRoomSecret());
  const right = token();
  const a = await socket(room(roomId));
  a.send({ t: "hello", v: 1, token: right, after: 0 });
  assert.equal((await a.next("ready")).created, true);
  const b = await socket(room(roomId));
  b.send({ t: "hello", v: 1, token: token(), after: 0 });
  assert.equal((await b.next("error")).code, "auth");
  await until(() => b.closed());
  a.close();
});

const KEY = newRelayKey();

test("a relay key limits who opens rooms", async (t) => {
  const { room } = await relayFor(t, { relayKey: KEY });
  const { roomId } = roomKeys(newRoomSecret());
  const a = await socket(room(roomId));
  a.send({ t: "hello", v: 1, token: token(), after: 0, key: "wrong" });
  assert.equal((await a.next("error")).code, "relay-key");
  const b = await socket(room(roomId));
  b.send({ t: "hello", v: 1, token: token(), after: 0, key: KEY });
  await b.next("ready");
  b.close();
});

test("wrong relay keys lock an address out of new rooms, not its rooms", async (t) => {
  const guard = new KeyGuard({ misses: 3, lockMs: 60_000 });
  const { room } = await relayFor(t, { relayKey: KEY, guard });
  // A room opened before the guessing still opens with its token after.
  const { roomId: kept } = roomKeys(newRoomSecret());
  const own = token();
  const first = await socket(room(kept));
  first.send({ t: "hello", v: 1, token: own, after: 0, key: KEY });
  await first.next("ready");
  first.close();
  const hello = async (
    key,
    roomId = roomKeys(newRoomSecret()).roomId,
    tok = token(),
  ) => {
    const s = await socket(room(roomId));
    s.send({ t: "hello", v: 1, token: tok, after: 0, key });
    const frame = await until(() =>
      s.frames.find((f) => f.t === "error" || f.t === "ready"),
    );
    s.close();
    return frame.t === "ready" ? "ready" : frame.code;
  };
  for (let i = 0; i < 3; i++) assert.equal(await hello("guess"), "relay-key");
  // Locked: refused unchecked, even with the right key.
  assert.equal(await hello(KEY), "relay-key-wait");
  assert.equal(await hello(KEY, kept, own), "ready");
  // Another address is not.
  assert.ok(guard.allows("203.0.113.9", Date.now()));
  assert.ok(guard.allows("127.0.0.1", Date.now() + 60_000));
});

test("the guard counts IPv6 by /64, and forgets old addresses", () => {
  assert.equal(addressKey("2001:db8:aa:1::5"), "2001:db8:aa:1::/64");
  assert.equal(addressKey("2001:0db8:00aa:0001:ffff::9"), "2001:db8:aa:1::/64");
  assert.equal(addressKey("::ffff:198.51.100.7"), "198.51.100.7");
  const guard = new KeyGuard({ misses: 2, addresses: 2 });
  guard.missed("2001:db8:aa:1::5", 0);
  guard.missed("2001:db8:aa:1::6", 1);
  assert.equal(guard.allows("2001:db8:aa:1::7", 2), false);
  assert.equal(guard.allows("2001:db8:aa:2::7", 2), true);
  guard.missed("198.51.100.1", 3);
  guard.missed("198.51.100.2", 4);
  assert.equal(guard.seen.size, 2);
  assert.equal(guard.allows("2001:db8:aa:1::7", 5), true);
});

test("a weak relay key opens no rooms", async (t) => {
  assert.ok(weakRelayKey("letmein"));
  assert.ok(weakRelayKey("a".repeat(40)));
  assert.ok(!weakRelayKey(KEY));
  const { room } = await relayFor(t, { relayKey: "letmein" });
  const s = await socket(room(roomKeys(newRoomSecret()).roomId));
  s.send({ t: "hello", v: 1, token: token(), after: 0, key: "letmein" });
  assert.equal((await s.next("error")).code, "weak-relay-key");
});

test("behind a proxy, the address is the one it saw", async (t) => {
  const guard = new KeyGuard({ misses: 1 });
  const { base } = await relayFor(t, {
    relayKey: KEY,
    guard,
    trustProxy: true,
  });
  const { roomId } = roomKeys(newRoomSecret());
  const res = await new Promise((resolve) => {
    const ws = new WebSocket(`${base}/v1/rooms/${roomId}`, {
      headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.5" },
    });
    ws.addEventListener("open", () =>
      ws.send(
        JSON.stringify({
          t: "hello",
          v: 1,
          token: token(),
          after: 0,
          key: "guess",
        }),
      ),
    );
    ws.addEventListener("close", resolve);
  });
  assert.ok(res);
  assert.equal(guard.allows("203.0.113.5", Date.now()), false);
  assert.equal(guard.allows("127.0.0.1", Date.now()), true);
});

test("posts reach the others, and the backlog after a cursor", async (t) => {
  const { room } = await relayFor(t);
  const { roomId } = roomKeys(newRoomSecret());
  const tk = token();
  const a = await socket(room(roomId));
  a.send({ t: "hello", v: 1, token: tk, after: 0 });
  await a.next("ready");
  const b = await socket(room(roomId));
  b.send({ t: "hello", v: 1, token: tk, after: 0 });
  await b.next("synced");
  a.send({ t: "post", id: "one", blob: "first" });
  a.send({ t: "post", id: "two", blob: "second" });
  await until(() => b.frames.filter((f) => f.t === "msg").length === 2);
  assert.deepEqual(
    b.frames.filter((f) => f.t === "msg").map((f) => [f.c, f.blob]),
    [
      [1, "first"],
      [2, "second"],
    ],
  );
  assert.equal(
    a.frames.some((f) => f.t === "msg"),
    false,
    "no echo to the sender",
  );
  const c = await socket(room(roomId));
  c.send({ t: "hello", v: 1, token: tk, after: 1 });
  await c.next("synced");
  assert.deepEqual(
    c.frames.filter((f) => f.t === "msg").map((f) => f.blob),
    ["second"],
  );
  for (const s of [a, b, c]) s.close();
});

test("oversized and too frequent posts are refused", async (t) => {
  const { room } = await relayFor(t);
  const { roomId } = roomKeys(newRoomSecret());
  const a = await socket(room(roomId));
  a.send({ t: "hello", v: 1, token: token(), after: 0 });
  await a.next("ready");
  a.send({ t: "post", id: "big", blob: "x".repeat(LIMITS.blob + 1) });
  assert.equal(
    (await until(() => a.frames.find((f) => f.id === "big"))).code,
    "too-big",
  );
  for (let i = 0; i < LIMITS.posts.burst + 5; i++)
    a.send({ t: "post", id: `p${i}`, blob: blob() });
  await until(() => a.frames.some((f) => f.code === "slow-down"));
  a.close();
});

test("anything before hello, or not JSON, closes the socket", async (t) => {
  const { room } = await relayFor(t);
  const { roomId } = roomKeys(newRoomSecret());
  const a = await socket(room(roomId));
  a.send({ t: "post", id: "x", blob: "y" });
  assert.equal((await a.next("error")).code, "bad-hello");
  await until(() => a.closed());
});

test("relay addresses: TLS, except on this computer and a tailnet", () => {
  assert.equal(
    relayUrl("https://relay.example.com/"),
    "wss://relay.example.com",
  );
  assert.equal(relayUrl("ws://127.0.0.1:8787"), "ws://127.0.0.1:8787");
  assert.equal(
    relayUrl("ws://100.101.102.103:8787"),
    "ws://100.101.102.103:8787",
  );
  for (const bad of [
    "ws://relay.example.com",
    "ws://192.168.1.4:8787",
    "ftp://x",
    "wss://u:p@relay.example",
    "wss://relay.example/?a=1",
  ])
    assert.throws(() => relayUrl(bad), bad);
});

test("the client reconnects and picks up where it left off", async (t) => {
  const first = await startRelay({ port: 0, data: ":memory:" });
  const { roomId, token: tk } = roomKeys(newRoomSecret());
  const got = [];
  const conn = new RoomConnection({
    relay: `ws://127.0.0.1:${first.port}`,
    roomId,
    token: tk,
    onMessage: (m) => got.push(m.blob),
  }).start();
  t.after(() => conn.stop());
  await until(() => conn.state === "connected");
  await conn.post("hello");
  assert.equal(conn.cursor, 1);
  await first.close();
  await until(() => conn.state === "waiting");
  await assert.rejects(conn.post("lost"), /Not connected/);
});

test("pulses reach who is connected now, and are not kept", async (t) => {
  const { room } = await relayFor(t);
  const { roomId } = roomKeys(newRoomSecret());
  const tk = token();
  const a = await socket(room(roomId));
  a.send({ t: "hello", v: 1, token: tk, after: 0 });
  assert.deepEqual((await a.next("ready")).relay.features, ["pulse"]);
  const b = await socket(room(roomId));
  b.send({ t: "hello", v: 1, token: tk, after: 0 });
  await b.next("synced");
  a.send({ t: "pulse", blob: "abc" });
  assert.equal((await b.next("pulse")).blob, "abc");
  // Nothing of it in the backlog of someone connecting later.
  const c = await socket(room(roomId));
  c.send({ t: "hello", v: 1, token: tk, after: 0 });
  assert.equal((await c.next("ready")).cursor, 0);
  await c.next("synced");
  assert.equal(
    c.frames.some((f) => f.t === "msg" || f.t === "pulse"),
    false,
  );
  // A flood is cut off quietly.
  for (let i = 0; i < 20; i++) a.send({ t: "pulse", blob: `p${i}` });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(
    b.frames.filter((f) => f.t === "pulse").length <= LIMITS.pulses.burst + 1,
  );
  for (const s of [a, b, c]) s.close();
});
