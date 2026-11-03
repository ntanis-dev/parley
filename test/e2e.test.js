import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { startRelay } from "../src/relay/server.js";
import {
  appendLog,
  createIdentity,
  loadRoom,
  pendingMembers,
  unread,
} from "../src/rooms.js";
import {
  createRoom,
  joinRoom,
  readInvite,
  setMemberStatus,
  syncRoom,
} from "../src/ops.js";
import { handleHook } from "../src/hooks.js";
import { ParleyServer, SENDS_PER_HOUR } from "../src/mcp.js";
import { readSession } from "../src/sessions.js";
import { writeConfig } from "../src/config.js";
import { notices } from "../src/compat.js";
import { VERSION } from "../src/version.js";
import { cloneOf, git, repo, tempHome, until, write } from "./helpers.js";

// Two people, one relay, a whole conversation: open a room, join it, approve,
// turn Parley on, send, wake, share a diff.

// Each has their own copy of the project: the first person makes it, the
// others clone theirs from it.
function person(t, name, from = null) {
  const { home, paths } = tempHome(t, name);
  const identity = createIdentity(paths, name);
  const dir = join(home, "project");
  const project = realpathSync.native(
    from ? cloneOf(from.project, dir) : repo(dir),
  );
  return { name, home, paths, identity, project };
}

// A Parley MCP server as Claude Code would drive it: initialize (with the
// elicitation capability), and answer approval dialogs with `answer`.
export function client(
  p,
  launchId,
  answer = () => ({ action: "accept", content: { send: true } }),
) {
  const sent = [];
  let nextId = 1;
  const pending = new Map();
  const server = new ParleyServer({
    paths: p.paths,
    launchId,
    env: {},
    write: (message) => {
      sent.push(message);
      if (message.method === "elicitation/create")
        queueMicrotask(() =>
          server.handle({
            jsonrpc: "2.0",
            id: message.id,
            result: answer(message.params),
          }),
        );
      if (!message.method && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    },
  });
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      server.handle({ jsonrpc: "2.0", id, method, params });
    });
  const tool = async (name, args = {}) =>
    (await call("tools/call", { name, arguments: args })).result;
  const start = async () => {
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: {} },
    });
    server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  return {
    server,
    sent,
    call,
    tool,
    start,
    channel: () =>
      sent.filter((m) => m.method === "notifications/claude/channel"),
  };
}

const hook = (p, launchId, event, input, now = Date.now()) =>
  handleHook(
    event,
    { cwd: p.project, permission_mode: "default", ...input },
    { paths: p.paths, launchId, now },
  );

test(
  "two people talk through a relay, end to end",
  { timeout: 60_000 },
  async (t) => {
    const relay = await startRelay({ port: 0, data: ":memory:" });
    t.after(() => relay.close());
    const url = `ws://127.0.0.1:${relay.port}`;
    const alice = person(t, "Alice");
    const bob = person(t, "Bob", alice);

    const { room, invite } = await createRoom({
      paths: alice.paths,
      identity: alice.identity,
      root: alice.project,
      relay: url,
      name: "shop",
    });
    const joined = await joinRoom({
      paths: bob.paths,
      identity: bob.identity,
      root: bob.project,
      invite: readInvite(invite, bob.identity),
    });
    assert.equal(joined.roomId, room.roomId);

    const synced = await syncRoom(alice.paths, alice.identity, room);
    const [knock] = pendingMembers(synced);
    assert.equal(knock.name, "Bob");
    await setMemberStatus({
      paths: alice.paths,
      identity: alice.identity,
      room: synced,
      id: knock.id,
      status: "approved",
    });

    // Each turns Parley on in a conversation.
    const sessions = { Alice: "aaaaaaaa-1111", Bob: "bbbbbbbb-2222" };
    for (const p of [alice, bob]) {
      const sid = sessions[p.name];
      hook(p, `launch-${p.name}`, "session-start", {
        session_id: sid,
        source: "startup",
      });
      const out = hook(p, `launch-${p.name}`, "user-prompt", {
        session_id: sid,
        prompt: "parley on",
      });
      assert.equal(out.decision, "block");
      assert.match(out.reason, /Parley is on/);
      assert.equal(readSession(p.paths, sid).enabled, true);
    }

    const a = client(alice, "launch-Alice");
    const b = client(bob, "launch-Bob");
    t.after(() => {
      a.server.stop();
      b.server.stop();
    });
    await a.start();
    await b.start();
    await until(
      () =>
        a.server.conn?.state === "connected" &&
        b.server.conn?.state === "connected",
    );

    // Each learns the other's Parley version, and the relay's.
    const bobId = knock.id;
    const aliceId = Object.keys(loadRoom(bob.paths, room.roomId).members)[0];
    await until(
      () =>
        loadRoom(bob.paths, room.roomId).versions?.members?.[aliceId]?.app ===
          VERSION &&
        loadRoom(alice.paths, room.roomId).versions?.members?.[bobId]?.app ===
          VERSION,
    );
    assert.equal(loadRoom(bob.paths, room.roomId).versions.relay.app, VERSION);
    assert.deepEqual(notices(loadRoom(bob.paths, room.roomId)), []);

    // A secret never leaves.
    const refused = await a.tool("send", {
      text: "the key is AKIAABCDEFGHIJKLMNOP",
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /AWS access key/);

    // Alice's agent writes; Alice approves; Bob's idle session is woken.
    const sent = await a.tool("send", {
      text: "I renamed User.email to User.contact_email, heads up.",
    });
    assert.equal(sent.isError, false, sent.content[0].text);
    assert.equal(sent.content[0].text, "Sent to Bob.");
    // Agents talk on their own: no dialog unless approvals are on.
    assert.equal(
      a.sent.some((m) => m.method === "elicitation/create"),
      false,
    );
    const [wake] = await until(() => b.channel().length && b.channel());
    assert.match(
      wake.params.content,
      /Message from Alice \(verified key [0-9A-F ]+\)/,
    );
    assert.match(wake.params.content, /User\.contact_email/);
    assert.equal(wake.params.meta.from, "Alice");

    // The message counts as read only once the woken turn shows up.
    const sid = sessions.Bob;
    assert.equal(unread(bob.paths, room.roomId).length, 1);
    hook(bob, "launch-Bob", "user-prompt", {
      session_id: sid,
      prompt: '<channel source="parley" from="Alice">...</channel>',
    });
    b.server.tick();
    assert.equal(unread(bob.paths, room.roomId).length, 0);

    // That turn is the peer's: reading is fine, editing waits for Bob.
    assert.equal(
      hook(bob, "launch-Bob", "pre-tool-use", {
        session_id: sid,
        tool_name: "Read",
      }),
      null,
    );
    const denied = hook(bob, "launch-Bob", "pre-tool-use", {
      session_id: sid,
      tool_name: "Edit",
    });
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    hook(
      bob,
      "launch-Bob",
      "user-prompt",
      { session_id: sid, prompt: "ok, update our side" },
      Date.now() + 1000,
    );
    assert.equal(
      hook(bob, "launch-Bob", "pre-tool-use", {
        session_id: sid,
        tool_name: "Edit",
      }),
      null,
    );

    // Bob shares a diff while Alice is busy with her own turn, so it waits in
    // her inbox. The .env file never leaves.
    hook(alice, "launch-Alice", "user-prompt", {
      session_id: sessions.Alice,
      prompt: "what is new?",
    });
    write(join(bob.project, "README.md"), "hello\nfrom bob\n");
    write(join(bob.project, ".env"), "TOKEN=abc\n");
    const shared = await b.tool("share_diff", { note: "README tweak" });
    assert.equal(shared.isError, false, shared.content[0].text);
    assert.match(shared.content[0].text, /Left out: \.env/);
    const inbox = await until(async () => {
      const r = await a.tool("inbox");
      return /Shared diff from Bob/.test(r.content[0].text) && r;
    });
    const id = /Diff id ([A-Za-z0-9_-]+)/.exec(inbox.content[0].text)[1];
    const diff = await a.tool("get_diff", { id });
    assert.match(diff.content[0].text, /\+from bob/);
    assert.match(diff.content[0].text, /has its base commit/);
    assert.doesNotMatch(diff.content[0].text, /TOKEN/);

    // With approvals on, a declined dialog sends nothing.
    writeConfig(alice.paths, (c) => (c.approvals = true));
    const declined = client(alice, "launch-Alice", () => ({
      action: "decline",
    }));
    t.after(() => declined.server.stop());
    await declined.start();
    await until(() => declined.server.conn?.state === "connected");
    const no = await declined.tool("send", { text: "never mind" });
    assert.match(no.content[0].text, /declined/);

    // Off means off.
    hook(bob, "launch-Bob", "user-prompt", {
      session_id: sid,
      prompt: "parley off",
    });
    const off = await b.tool("inbox");
    assert.equal(off.isError, true);
    assert.equal(
      loadRoom(alice.paths, room.roomId).members[knock.id].status,
      "approved",
    );
  },
);

test(
  "a wake that starts no turn leaves the messages in the inbox",
  { timeout: 30_000 },
  async (t) => {
    const relay = await startRelay({ port: 0, data: ":memory:" });
    t.after(() => relay.close());
    const alice = person(t, "Alice");
    const bob = person(t, "Bob", alice);
    const { room, invite } = await createRoom({
      paths: alice.paths,
      identity: alice.identity,
      root: alice.project,
      relay: `ws://127.0.0.1:${relay.port}`,
      name: "shop",
    });
    await joinRoom({
      paths: bob.paths,
      identity: bob.identity,
      root: bob.project,
      invite: readInvite(invite, bob.identity),
    });
    const synced = await syncRoom(alice.paths, alice.identity, room);
    await setMemberStatus({
      paths: alice.paths,
      identity: alice.identity,
      room: synced,
      id: pendingMembers(synced)[0].id,
      status: "approved",
    });
    for (const p of [alice, bob]) {
      hook(p, `launch-${p.name}`, "session-start", {
        session_id: `${p.name}-session`,
        source: "startup",
      });
      hook(p, `launch-${p.name}`, "user-prompt", {
        session_id: `${p.name}-session`,
        prompt: "parley on",
      });
    }
    const a = client(alice, "launch-Alice");
    const b = client(bob, "launch-Bob");
    t.after(() => {
      a.server.stop();
      b.server.stop();
    });
    await a.start();
    await b.start();
    await until(
      () =>
        a.server.conn?.state === "connected" &&
        b.server.conn?.state === "connected",
    );
    await a.tool("send", { text: "anyone there?" });
    await until(() => b.channel().length);
    // No turn follows (as when channels are off for the account).
    b.server.settle(Date.now() + 61_000);
    assert.equal(b.server.channelQuiet, true);
    assert.equal(readSession(bob.paths, "Bob-session").peerAt, 0);
    const inbox = await b.tool("inbox");
    assert.match(inbox.content[0].text, /anyone there\?/);
    const status = await b.tool("status");
    assert.match(status.content[0].text, /cannot wake this session/);

    // Talking on its own has a ceiling: so many sends an hour, then refusals.
    for (let i = 0; i < SENDS_PER_HOUR; i++)
      appendLog(alice.paths, room.roomId, {
        id: `old-${i}`,
        at: Date.now() - 1000,
        own: true,
        kind: "message",
        text: "x",
      });
    const limited = await a.tool("send", { text: "one more" });
    assert.equal(limited.isError, true);
    assert.match(limited.content[0].text, /limit/);
  },
);

test(
  "only a copy of the same repository can join, and stay on",
  { timeout: 30_000 },
  async (t) => {
    const relay = await startRelay({ port: 0, data: ":memory:" });
    t.after(() => relay.close());
    const alice = person(t, "Alice");
    const { room, invite } = await createRoom({
      paths: alice.paths,
      identity: alice.identity,
      root: alice.project,
      relay: `ws://127.0.0.1:${relay.port}`,
      name: "shop",
    });
    assert.equal(room.tags.length, 1);

    // An unrelated repository is refused.
    const { home, paths } = tempHome(t, "Mallory");
    const mallory = createIdentity(paths, "Mallory");
    const other = realpathSync.native(
      repo(join(home, "other"), { "README.md": "a different project\n" }),
    );
    await assert.rejects(
      joinRoom({
        paths,
        identity: mallory,
        root: other,
        invite: readInvite(invite, mallory),
      }),
      /different repository from Alice's/,
    );
    // So is a shallow clone that does not reach the first commit, with a way
    // out.
    git(alice.project, "commit", "-q", "--allow-empty", "-m", "second");
    const deeper = realpathSync.native(
      cloneOf(
        `file://${alice.project.split("\\").join("/")}`,
        join(home, "deeper"),
        "--depth",
        "1",
      ),
    );
    await assert.rejects(
      joinRoom({
        paths,
        identity: mallory,
        root: deeper,
        invite: readInvite(invite, mallory),
      }),
      /shallow clone.*--unshallow/,
    );

    // A real clone joins; if its folder is later swapped for another
    // repository, `parley on` refuses.
    const bob = person(t, "Bob", alice);
    await joinRoom({
      paths: bob.paths,
      identity: bob.identity,
      root: bob.project,
      invite: readInvite(invite, bob.identity),
    });
    const on = hook(bob, "launch-Bob", "user-prompt", {
      session_id: "Bob-session",
      prompt: "parley on",
    });
    assert.match(on.reason, /Parley is on/);
    hook(bob, "launch-Bob", "user-prompt", {
      session_id: "Bob-session",
      prompt: "parley off",
    });
    const { rmSync } = await import("node:fs");
    rmSync(join(bob.project, ".git"), { recursive: true, force: true });
    repo(bob.project, { "x.txt": "started over\n" });
    const refused = hook(bob, "launch-Bob", "user-prompt", {
      session_id: "Bob-session",
      prompt: "parley on",
    });
    assert.match(refused.reason, /Parley stays off.*different repository/);
    assert.notEqual(readSession(bob.paths, "Bob-session").enabled, true);
  },
);
