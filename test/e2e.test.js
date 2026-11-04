import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { startRelay } from "../src/relay/server.js";
import {
  appendLog,
  createIdentity,
  loadRoom,
  pendingMembers,
  prepare,
  receive,
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
import { readLaunch, readSession, updateLaunch } from "../src/sessions.js";
import { runWatch } from "../src/watch.js";
import { readyToLaunch } from "../src/launch.js";
import { writeConfig } from "../src/config.js";
import { notices } from "../src/compat.js";
import { memberActivity } from "../src/activity.js";
import { VERSION } from "../src/version.js";
import { sayAsPerson } from "../src/view.js";
import { cloneOf, git, repo, tempHome, until, write } from "./helpers.js";

// Two people, one relay, a whole conversation: open a room, join it, approve,
// start Parley, send, wake through the watch, share a diff.

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

// A Parley MCP server as Claude Code would drive it in a `parley` launch:
// initialize (with the elicitation capability), answer approval dialogs with
// `answer`, and, once watched, collect what the watch delivers.
function client(
  p,
  launchId,
  answer = () => ({ action: "accept", content: { send: true } }),
) {
  const sent = [];
  const frames = [];
  let nextId = 1;
  const pending = new Map();
  updateLaunch(p.paths, launchId, (l) => {
    l.cwd = p.project;
    l.watchCommand = `parley watch --launch ${launchId}`;
  });
  const server = new ParleyServer({
    paths: p.paths,
    launchId,
    env: {},
    log: (line) =>
      process.env.PARLEY_TEST_LOG &&
      process.stderr.write(`${p.name}: ${line}
`),
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
    const init = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: {} },
    });
    server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    return init.result;
  };
  // What the agent's Monitor does: run `parley watch` (here, in process).
  const watch = () => {
    runWatch({
      paths: p.paths,
      launchId,
      stdout: { write: (text) => frames.push(text) },
    });
    return until(() => server.watching);
  };
  return { server, sent, frames, call, tool, start, watch };
}

const hook = (p, launchId, event, input, now = Date.now()) =>
  handleHook(
    event,
    { cwd: p.project, permission_mode: "default", ...input },
    { paths: p.paths, launchId, now },
  );

// Alice opens a room, Bob (with a clone) joins, Alice lets him in, and each
// starts a `parley` session there.
async function pair(t) {
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
  const sessions = { Alice: "aaaaaaaa-1111", Bob: "bbbbbbbb-2222" };
  const a = client(alice, "launch-Alice");
  const b = client(bob, "launch-Bob");
  t.after(() => {
    a.server.stop();
    b.server.stop();
  });
  for (const [p, c] of [
    [alice, a],
    [bob, b],
  ]) {
    const out = hook(p, `launch-${p.name}`, "session-start", {
      session_id: sessions[p.name],
      source: "startup",
    });
    assert.match(out.hookSpecificOutput.additionalContext, /Parley is on/);
    const init = await c.start();
    assert.deepEqual(init.capabilities, { tools: {} });
    assert.match(init.instructions, /parley watch --launch/);
  }
  await until(
    () =>
      a.server.conn?.state === "connected" &&
      b.server.conn?.state === "connected",
  );
  return { relay, alice, bob, room, knock, a, b, sessions };
}

test(
  "two people talk through a relay, end to end",
  { timeout: 60_000 },
  async (t) => {
    const { alice, bob, room, knock, a, b, sessions } = await pair(t);

    // Each learns the other's Parley version, and the relay's.
    const aliceId = Object.keys(loadRoom(bob.paths, room.roomId).members)[0];
    await until(
      () =>
        loadRoom(bob.paths, room.roomId).versions?.members?.[aliceId]?.app ===
          VERSION &&
        loadRoom(alice.paths, room.roomId).versions?.members?.[knock.id]
          ?.app === VERSION,
    );
    assert.equal(loadRoom(bob.paths, room.roomId).versions.relay.app, VERSION);
    assert.deepEqual(notices(loadRoom(bob.paths, room.roomId)), []);

    // Bob's agent arms the watch; the status line learns it.
    await b.watch();
    await until(() => readLaunch(bob.paths, "launch-Bob").status?.watching);

    // Each sees the other around, and whether their Claude is working.
    await until(() => {
      const seen = memberActivity(
        alice.paths,
        loadRoom(alice.paths, room.roomId),
      );
      return seen[0]?.state === "idle";
    });
    hook(bob, "launch-Bob", "user-prompt", {
      session_id: sessions.Bob,
      prompt: "refactor the cart",
    });
    await until(
      () =>
        memberActivity(alice.paths, loadRoom(alice.paths, room.roomId))[0]
          ?.state === "working",
      { timeoutMs: 10_000 },
    );
    await until(() =>
      readLaunch(alice.paths, "launch-Alice").status?.members?.some(
        (m) => m.name === "Bob" && m.state === "working",
      ),
    );
    hook(bob, "launch-Bob", "stop", { session_id: sessions.Bob });

    // A secret never leaves.
    const refused = await a.tool("send", {
      text: "the key is AKIAABCDEFGHIJKLMNOP",
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /AWS access key/);

    // Alice's agent writes on its own; Bob's idle session gets it as one
    // watch event.
    const sent = await a.tool("send", {
      text: "I renamed User.email to User.contact_email, heads up.",
    });
    assert.equal(sent.isError, false, sent.content[0].text);
    assert.match(sent.content[0].text, /^Sent to Bob \((idle|working)\)\.$/);
    assert.equal(
      a.sent.some((m) => m.method === "elicitation/create"),
      false,
    );
    const [event] = await until(() => b.frames.length && b.frames);
    assert.match(event, /^Parley: 1 new item in room "shop" from Alice\./);
    assert.match(event, /Message from Alice \(verified key [0-9A-F ]+\)/);
    assert.match(event, /User\.contact_email/);
    assert.match(event, /select:mcp__parley__send/);
    assert.equal(unread(bob.paths, room.roomId).length, 0);

    // That turn is the peer's: reading is fine, editing waits for Bob.
    const sid = sessions.Bob;
    hook(bob, "launch-Bob", "user-prompt", {
      session_id: sid,
      prompt: "<task-notification>Parley messages</task-notification>",
    });
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

    // Alice has no watch armed: Bob's diff waits in her inbox. The .env file
    // never leaves.
    write(join(bob.project, "README.md"), "hello\nfrom bob\n");
    write(join(bob.project, ".env"), "TOKEN=abc\n");
    const shared = await b.tool("share_diff", { note: "README tweak" });
    assert.equal(shared.isError, false, shared.content[0].text);
    assert.match(shared.content[0].text, /Left out: \.env/);
    await until(() => unread(alice.paths, room.roomId).length === 1);
    const reminder = hook(alice, "launch-Alice", "user-prompt", {
      session_id: sessions.Alice,
      prompt: "what is new?",
    });
    assert.match(
      reminder.hookSpecificOutput.additionalContext,
      /watch is not armed.*parley watch --launch launch-Alice.*1 Parley message is waiting/,
    );
    const inbox = await a.tool("inbox");
    assert.match(inbox.content[0].text, /Shared diff from Bob/);
    const id = /Diff id ([A-Za-z0-9_-]+)/.exec(inbox.content[0].text)[1];
    const diff = await a.tool("get_diff", { id });
    assert.match(diff.content[0].text, /\+from bob/);
    assert.match(diff.content[0].text, /has its base commit/);
    assert.doesNotMatch(diff.content[0].text, /TOKEN/);

    // With approvals on, a declined dialog sends nothing.
    writeConfig(alice.paths, (c) => (c.approvals = true));
    const declined = client(alice, "launch-Alice-2", () => ({
      action: "decline",
    }));
    t.after(() => declined.server.stop());
    await declined.start();
    await until(() => declined.server.conn?.state === "connected");
    const no = await declined.tool("send", { text: "never mind" });
    assert.match(no.content[0].text, /declined/);
  },
);

test("talking on its own has a ceiling", { timeout: 30_000 }, async (t) => {
  const { alice, room, a } = await pair(t);
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
});

test(
  "a watch that starts no turn leaves the session idle again",
  { timeout: 30_000 },
  async (t) => {
    const { bob, a, b, sessions } = await pair(t);
    await b.watch();
    await a.tool("send", { text: "anyone there?" });
    await until(() => b.frames.length);
    const session = readSession(bob.paths, sessions.Bob);
    assert.ok(session.busySince);
    b.server.settle(Date.now() + 61_000);
    assert.equal(readSession(bob.paths, sessions.Bob).busySince, 0);
  },
);

test(
  "only a copy of the same repository can join, and talk",
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
    // repository, Parley pauses there and says why.
    const bob = person(t, "Bob", alice);
    await joinRoom({
      paths: bob.paths,
      identity: bob.identity,
      root: bob.project,
      invite: readInvite(invite, bob.identity),
    });
    rmSync(join(bob.project, ".git"), { recursive: true, force: true });
    repo(bob.project, { "x.txt": "started over\n" });
    const b = client(bob, "launch-Bob");
    t.after(() => b.server.stop());
    hook(bob, "launch-Bob", "session-start", {
      session_id: "Bob-session",
      source: "startup",
    });
    await b.start();
    const paused = await b.tool("inbox");
    assert.equal(paused.isError, true);
    assert.match(paused.content[0].text, /paused.*different repository/);
    await until(
      () =>
        readLaunch(bob.paths, "launch-Bob").status?.blocked ===
        "other repository",
    );
    assert.equal(b.server.conn, null);
  },
);

test(
  "parley starts only when someone in the room can hear it",
  { timeout: 60_000 },
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
    const ready = (p) => readyToLaunch({ paths: p.paths, cwd: p.project });

    // Alone in the room: nobody to talk to.
    await assert.rejects(ready(alice), /Nobody else is in room "shop" yet/);

    // Bob joined, nobody let him in yet: neither side starts.
    await joinRoom({
      paths: bob.paths,
      identity: bob.identity,
      root: bob.project,
      invite: readInvite(invite, bob.identity),
    });
    await assert.rejects(
      ready(alice),
      /Bob \(.*\) asked to join "shop".*parley approve/,
    );
    await assert.rejects(ready(bob), /Alice has not let you into "shop" yet/);

    // Alice lets him in: both start.
    const synced = await syncRoom(alice.paths, alice.identity, room);
    await setMemberStatus({
      paths: alice.paths,
      identity: alice.identity,
      room: synced,
      id: pendingMembers(synced)[0].id,
      status: "approved",
    });
    assert.equal((await ready(alice)).room.name, "shop");
    assert.equal((await ready(bob)).room.name, "shop");

    // A relay that does not answer: no session.
    await relay.close();
    await assert.rejects(
      readyToLaunch({ paths: bob.paths, cwd: bob.project, timeoutMs: 1500 }),
      /Parley does not start: .*relay/,
    );
  },
);

test(
  "a room of three: direct messages, replies, files, memory and claims",
  { timeout: 90_000 },
  async (t) => {
    const relay = await startRelay({ port: 0, data: ":memory:" });
    t.after(() => relay.close());
    const alice = person(t, "Alice");
    const bob = person(t, "Bob", alice);
    const carol = person(t, "Carol", alice);
    const { room, invite } = await createRoom({
      paths: alice.paths,
      identity: alice.identity,
      root: alice.project,
      relay: `ws://127.0.0.1:${relay.port}`,
      name: "shop",
    });
    for (const p of [bob, carol])
      await joinRoom({
        paths: p.paths,
        identity: p.identity,
        root: p.project,
        invite: readInvite(invite, p.identity),
      });
    // Everyone lets everyone in.
    const approveAll = async (p) => {
      const synced = await syncRoom(
        p.paths,
        p.identity,
        loadRoom(p.paths, room.roomId),
      );
      for (const m of pendingMembers(synced))
        await setMemberStatus({
          paths: p.paths,
          identity: p.identity,
          room: loadRoom(p.paths, room.roomId),
          id: m.id,
          status: "approved",
        });
    };
    for (let round = 0; round < 2; round++)
      for (const p of [alice, bob, carol]) await approveAll(p);
    for (const p of [alice, bob, carol])
      assert.equal(
        Object.values(loadRoom(p.paths, room.roomId).members).filter(
          (m) => m.status === "approved",
        ).length,
        2,
        p.name,
      );

    const [a, b, c] = [alice, bob, carol].map((p) =>
      client(p, `launch-${p.name}`),
    );
    t.after(() => [a, b, c].forEach((x) => x.server.stop()));
    for (const [p, x] of [
      [alice, a],
      [bob, b],
      [carol, c],
    ]) {
      hook(p, `launch-${p.name}`, "session-start", {
        session_id: `${p.name}-s`,
        source: "startup",
      });
      await x.start();
    }
    await until(() =>
      [a, b, c].every((x) => x.server.conn?.state === "connected"),
    );
    // Waits for the inbox to show `pattern` (each look marks what it shows
    // read, so everything seen is kept for the failure message).
    const inbox = async (x, pattern) => {
      const seen = [];
      try {
        return await until(async () => {
          const r = (await x.tool("inbox")).content[0].text;
          seen.push(r);
          return pattern.test(r) && r;
        });
      } catch {
        const shown = seen.filter((r) => r !== "Nothing new.");
        throw new Error(
          `inbox never showed ${pattern}; it showed:\n${shown.join("\n---\n")}`,
        );
      }
    };

    // A direct message reaches Bob, and only Bob.
    const direct = await a.tool("send", {
      text: "Bob, can you pull?",
      to: ["bob"],
    });
    assert.match(direct.content[0].text, /^Sent to Bob \(/);
    const got = await inbox(b, /Message to you from Alice/);
    const id = /message id ([A-Za-z0-9_-]+)/.exec(got)[1];
    await b.tool("send", { text: "pulled", reply_to: id });
    await inbox(a, new RegExp(`a reply to ${id}`));
    await inbox(c, /pulled/);
    assert.doesNotMatch(readLogText(carol, room), /can you pull/);
    const unknown = await a.tool("send", { text: "hi", to: ["Dave"] });
    assert.match(unknown.content[0].text, /Dave is not an approved member/);

    // A file, to Carol only: read it, save it, never over a file unasked.
    write(join(alice.project, "docs", "plan.md"), "# Plan\nship it\n");
    const sentFile = await a.tool("send_file", {
      path: "docs/plan.md",
      to: ["Carol"],
    });
    assert.match(sentFile.content[0].text, /Sent docs\/plan\.md/);
    const fileNote = await inbox(c, /File to you from Alice/);
    const fileId = /File id ([A-Za-z0-9_-]+)/.exec(fileNote)[1];
    assert.match(
      (await c.tool("get_file", { id: fileId })).content[0].text,
      /ship it/,
    );
    assert.match(
      (await c.tool("get_file", { id: fileId, save_as: "docs/from-alice.md" }))
        .content[0].text,
      /Saved plan\.md/,
    );
    assert.equal(
      readFileSync(join(carol.project, "docs", "from-alice.md"), "utf8"),
      "# Plan\nship it\n",
    );
    assert.match(
      (await c.tool("get_file", { id: fileId, save_as: "README.md" }))
        .content[0].text,
      /exists; pass overwrite/,
    );
    assert.match(
      (await c.tool("get_file", { id: fileId, save_as: ".env" })).content[0]
        .text,
      /does not write/,
    );
    write(join(alice.project, ".env"), "TOKEN=1\n");
    assert.match(
      (await a.tool("send_file", { path: ".env" })).content[0].text,
      /never leaves/,
    );

    // Shared memory: the newest note per topic, forgettable, in new sessions.
    await a.tool("remember", {
      topic: "release",
      text: "We tag releases on Fridays.",
    });
    await a.tool("remember", {
      topic: "release",
      text: "We tag releases on Thursdays.",
    });
    await inbox(b, /Thursdays/);
    const notes = (await b.tool("notes", {})).content[0].text;
    assert.match(notes, /Thursdays/);
    assert.doesNotMatch(notes, /Fridays/);
    const fresh = hook(bob, "launch-Bob", "session-start", {
      session_id: "Bob-2",
      source: "startup",
    });
    assert.match(
      fresh.hookSpecificOutput.additionalContext,
      /shared memory[\s\S]*release: We tag releases on Thursdays/,
    );
    await a.tool("forget", { topic: "release" });
    await until(async () =>
      /empty/.test((await b.tool("notes", {})).content[0].text),
    );

    // A claim: a heads-up for the others when they edit there.
    await b.tool("claim", {
      paths: ["src"],
      note: "refactoring the cart",
      minutes: 30,
    });
    await until(async () =>
      /Bob is working on src/.test((await a.tool("status")).content[0].text),
    );
    const heads = hook(alice, "launch-Alice", "pre-tool-use", {
      session_id: "Alice-s",
      tool_name: "Edit",
      tool_input: { file_path: join(alice.project, "src", "cart.js") },
    });
    assert.match(
      heads.hookSpecificOutput.additionalContext,
      /Bob is working on src until .*refactoring the cart/,
    );
    assert.match((await b.tool("release", {})).content[0].text, /Released src/);
    await until(
      async () => !/Claims:/.test((await a.tool("status")).content[0].text),
    );
  },
);

test(
  "what a person writes in parley view reaches the other agent as theirs",
  { timeout: 30_000 },
  async (t) => {
    const { alice, room, knock, b } = await pair(t);
    const done = await sayAsPerson({
      paths: alice.paths,
      identity: alice.identity,
      room: loadRoom(alice.paths, room.roomId),
      text: "Bob, pull before you touch the cart",
      to: ["bob"],
    });
    assert.equal(done, "Sent to Bob.");
    let inbox = "";
    await until(async () =>
      /pull before you touch/.test(
        (inbox = (await b.tool("inbox")).content[0].text),
      ),
    );
    assert.match(inbox, /Alice typed this themselves, not their agent/);
    const mine = readLogText(alice, room)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((e) => e.own && e.kind === "message");
    assert.equal(mine.human, true);
    assert.deepEqual(mine.to, [knock.id]);
    await assert.rejects(
      sayAsPerson({
        paths: alice.paths,
        identity: alice.identity,
        room: loadRoom(alice.paths, room.roomId),
        text: "hi",
        to: ["Carol"],
      }),
      /Carol is not a member/,
    );
  },
);

test(
  "a message parley view kept first still wakes the session",
  { timeout: 30_000 },
  async (t) => {
    const { alice, bob, room, b } = await pair(t);
    await b.watch();
    const { blob } = prepare(
      alice.identity,
      loadRoom(alice.paths, room.roomId),
      "message",
      { text: "seen by the view first" },
      Date.now(),
    );
    const msg = { c: 10_000, at: Date.now(), blob };
    // Bob's `parley view` got it first and kept it.
    assert.equal(
      receive(bob.paths, bob.identity, room.roomId, msg).kind,
      "entry",
    );
    b.server.arrived(room.roomId, bob.identity, msg);
    const [event] = await until(() => b.frames.length && b.frames, {
      timeoutMs: 10_000,
    });
    assert.match(event, /seen by the view first/);
  },
);

const readLogText = (p, room) => {
  try {
    return readFileSync(join(p.paths.rooms, room.roomId, "log.jsonl"), "utf8");
  } catch {
    return "";
  }
};
