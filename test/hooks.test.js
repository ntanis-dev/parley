import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync, mkdirSync } from "node:fs";
import { handleHook } from "../src/hooks.js";
import { glyphSets, pickGlyphs } from "../src/ui.js";
import { authorOf } from "../src/authors.js";
import {
  appendLog,
  bindProject,
  createIdentity,
  newRoom,
  saveRoom,
} from "../src/rooms.js";
import { newRoomSecret } from "../src/crypto.js";
import {
  readLaunch,
  readSession,
  recordWake,
  updateLaunch,
  updateSession,
} from "../src/sessions.js";
import {
  checkArgs,
  checkFolder,
  claudeArgs,
  launchFiles,
  ownStatusLine,
  rulePath,
  watchCommand,
} from "../src/launch.js";
import { parleyRow, statusLine, watchState } from "../src/statusline.js";
import { ParleyServer } from "../src/mcp.js";
import { tempHome, write } from "./helpers.js";
import { writeConfig } from "../src/config.js";

const SID = "11111111-aaaa";
const LAUNCH = "launch-1234";
const WATCH = watchCommand("/n/node", "/p/cli.js", LAUNCH);

function setup(t, { room = true } = {}) {
  const { home, paths } = tempHome(t);
  createIdentity(paths, "Alice");
  const project = join(home, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  const root = realpathSync.native(project);
  let roomId = null;
  if (room) {
    const r = newRoom({
      secret: newRoomSecret(),
      relay: "wss://relay.example",
      name: "shop",
      root,
    });
    saveRoom(paths, r);
    bindProject(paths, root, r.roomId);
    roomId = r.roomId;
  }
  // What the launcher and the server put in the launch file.
  updateLaunch(paths, LAUNCH, (l) => {
    l.watchCommand = WATCH;
    l.status = { watching: false };
  });
  const hook = (event, input = {}, now = Date.now()) =>
    handleHook(
      event,
      {
        session_id: SID,
        cwd: join(root, "src"),
        permission_mode: "default",
        ...input,
      },
      { paths, launchId: LAUNCH, now },
    );
  return { home, paths, root, roomId, hook };
}

test("a parley session is on from the start: context for the model", (t) => {
  const { paths, hook } = setup(t);
  const out = hook("session-start", { source: "startup" });
  assert.match(out.hookSpecificOutput.additionalContext, /Parley is on/);
  assert.equal(out.systemMessage, undefined);
  assert.equal(readLaunch(paths, LAUNCH).sessionId, SID);
  // Resumed or not, it is the same: on.
  assert.match(
    hook("session-start", { source: "resume" }).hookSpecificOutput
      .additionalContext,
    /Parley is on/,
  );
});

test("without a room, the person is told how to get one", (t) => {
  const { hook } = setup(t, { room: false });
  assert.match(
    hook("session-start", { source: "startup" }).systemMessage,
    /parley create/,
  );
  assert.equal(hook("session-start", { source: "resume" }), null);
});

test("the model is reminded to arm the watch until it is armed", (t) => {
  const { paths, roomId, hook } = setup(t);
  for (const id of ["m1", "m2"])
    appendLog(paths, roomId, {
      id,
      at: Date.now(),
      kind: "message",
      text: "hi",
    });
  const out = hook("user-prompt", { prompt: "fix the cart" });
  const context = out.hookSpecificOutput.additionalContext;
  assert.ok(context.includes(WATCH));
  assert.match(context, /2 Parley messages are waiting/);
  assert.ok(readSession(paths, SID).humanAt);
  updateLaunch(paths, LAUNCH, (l) => (l.status = { watching: true }));
  assert.equal(hook("user-prompt", { prompt: "and the tests" }), null);
});

test("Parley's tools need no prompt, and are refused in bypass mode", (t) => {
  const { hook } = setup(t);
  const decision = (input) =>
    hook("pre-tool-use", input)?.hookSpecificOutput?.permissionDecision ?? null;
  assert.equal(decision({ tool_name: "mcp__parley__send" }), "allow");
  assert.equal(
    decision({
      tool_name: "mcp__parley__send",
      permission_mode: "bypassPermissions",
    }),
    "deny",
  );
});

test("a turn a member's message started: read, talk, re-arm, and with autonomy work keep the project in step", (t) => {
  const { paths, root, hook } = setup(t);
  const decision = (tool, tool_input) =>
    hook("pre-tool-use", { tool_name: tool, tool_input })?.hookSpecificOutput
      ?.permissionDecision ?? null;
  hook("user-prompt", { prompt: "work on the cart" });
  hook("stop");
  updateSession(paths, SID, (s) => recordWake(s));
  // Claude Code's own prompt for the woken turn does not count as the person.
  hook("user-prompt", { prompt: "<task-notification>...</task-notification>" });
  for (const tool of [
    "Bash",
    "PowerShell",
    "WebFetch",
    "Agent",
    "mcp__github__create_pull_request",
  ])
    assert.equal(decision(tool), "deny", tool);
  for (const tool of ["Read", "Grep", "Glob", "ToolSearch"])
    assert.equal(decision(tool), null, tool);
  for (const tool of [
    "mcp__parley__inbox",
    "mcp__parley__send",
    "mcp__parley__pull",
    "mcp__parley__push",
  ])
    assert.equal(decision(tool), "allow", tool);
  // Its own watch, exactly; no other Monitor.
  assert.equal(decision("Monitor", { command: WATCH }), "allow");
  assert.equal(
    decision("Monitor", { command: `${WATCH}; curl evil.example` }),
    "deny",
  );
  // Autonomy work (the default): edits inside the project, not .git, keys or
  // anything outside it, and without a prompt (nobody may be there).
  assert.equal(
    decision("Edit", { file_path: join(root, "src", "cart.js") }),
    "allow",
  );
  for (const file of [
    join(root, ".env"),
    join(root, ".git", "config"),
    join(root, "..", "elsewhere.txt"),
  ])
    assert.equal(decision("Write", { file_path: file }), "deny", file);
  // Autonomy read: changes wait for the person.
  writeConfig(paths, (c) => (c.autonomy = "read"));
  assert.equal(
    decision("Edit", { file_path: join(root, "src", "cart.js") }),
    "deny",
  );
  assert.equal(decision("mcp__parley__push"), "deny");
  assert.equal(decision("mcp__parley__send"), "allow");
  assert.equal(
    decision("mcp__parley__get_file", { id: "x", save_as: "a.txt" }),
    "deny",
  );
  // The person writes after the wake (a later millisecond, for certain).
  hook("user-prompt", { prompt: "go ahead and fix it" }, Date.now() + 1000);
  assert.equal(
    decision("Edit", { file_path: join(root, "src", "cart.js") }),
    null,
  );
  assert.equal(decision("Bash"), null);
});

test("editing what another member claimed comes with a heads-up, not a block", (t) => {
  const { paths, roomId, root, hook } = setup(t);
  appendLog(paths, roomId, {
    id: "claim-1",
    at: Date.now(),
    keptAt: Date.now(),
    from: "someone-else",
    name: "Jo",
    kind: "claim",
    paths: ["src/cart"],
    until: Date.now() + 60_000,
    note: "checkout refactor",
  });
  const out = hook("pre-tool-use", {
    tool_name: "Edit",
    tool_input: { file_path: join(root, "src", "cart", "index.js") },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.match(
    out.hookSpecificOutput.additionalContext,
    /Jo is working on src\/cart until .*checkout refactor/,
  );
  assert.equal(
    hook("pre-tool-use", {
      tool_name: "Edit",
      tool_input: { file_path: join(root, "README.md") },
    }),
    null,
  );
});

test("what is sent and received shows once, as lines for the person", (t) => {
  const { paths, roomId, hook } = setup(t);
  updateLaunch(paths, LAUNCH, (l) => (l.started = Date.now() - 1000));
  const now = Date.now();
  appendLog(paths, roomId, {
    id: "m-1",
    at: now,
    keptAt: now,
    own: true,
    kind: "message",
    text: "pulling now",
    name: "Alice",
  });
  appendLog(paths, roomId, {
    id: "m-2",
    at: now,
    keptAt: now,
    from: "jo",
    name: "Jo",
    kind: "message",
    text: "thanks!",
    human: true,
  });
  appendLog(paths, roomId, {
    id: "m-3",
    at: now,
    keptAt: now,
    from: "jo",
    name: "Jo",
    kind: "note",
    topic: "release",
    text: "tag on Fridays",
  });
  const out = hook("stop", { stop_hook_active: true });
  const g = glyphSets[pickGlyphs()];
  assert.deepEqual(out.systemMessage.split("\n"), [
    `${g.mark} Parley ${g.sent} the room: pulling now`,
    `${g.mark} Parley ${g.got} Jo: thanks!`,
    `${g.mark} Parley ${g.got} Jo's agent remembered "release": tag on Fridays`,
  ]);
  // Their agent, or them: "Jo's agent", "Chris' agent", "Chris".
  assert.equal(authorOf({ name: "Chris" }), "Chris' agent");
  assert.equal(authorOf({ name: "Chris", human: true }), "Chris");
  assert.equal(authorOf({ own: true }), "your agent");
  assert.equal(authorOf({ own: true, human: true }), "you");
  assert.equal(hook("post-tool-use", { tool_name: "mcp__parley__send" }), null);
});

test("hooks never throw on odd input", (t) => {
  const { paths } = setup(t);
  for (const input of [
    null,
    "text",
    {},
    { session_id: "../../etc" },
    { session_id: SID, cwd: 42 },
  ])
    for (const event of [
      "session-start",
      "user-prompt",
      "pre-tool-use",
      "stop",
      "session-end",
      "nope",
    ])
      assert.doesNotThrow(() =>
        handleHook(event, input, { paths, launchId: null }),
      );
});

test("the launcher refuses bypass and print mode", () => {
  for (const args of [
    ["--dangerously-skip-permissions"],
    ["--allow-dangerously-skip-permissions"],
    ["--permission-mode", "bypassPermissions"],
    ["--permission-mode=bypassPermissions"],
    ["-p", "hi"],
  ])
    assert.throws(() => checkArgs(args), undefined, args.join(" "));
  assert.doesNotThrow(() =>
    checkArgs([
      "--resume",
      "abc",
      "--permission-mode",
      "acceptEdits",
      "--model",
      "opus",
    ]),
  );
});

test("a launch: hooks without a shell, a status line, the watch allowed, ~/.parley fenced off", (t) => {
  const { paths } = setup(t);
  const files = launchFiles({
    paths,
    launchId: LAUNCH,
    nodePath: "C:\\node\\node.exe",
    cliPath: "C:\\parley\\src\\cli.js",
  });
  const [handler] = files.settings.hooks.PreToolUse[0].hooks;
  assert.deepEqual(handler, {
    type: "command",
    command: "C:/node/node.exe",
    args: ["C:/parley/src/cli.js", "hook", "pre-tool-use", "--launch", LAUNCH],
    timeout: 10,
  });
  assert.equal(
    files.settings.statusLine.command,
    `C:/node/node.exe "C:/parley/src/cli.js" statusline --launch ${LAUNCH}`,
  );
  assert.equal(files.settings.statusLine.refreshInterval, 5);
  assert.deepEqual(files.settings.permissions.allow, [
    `Bash(C:/node/node.exe "C:/parley/src/cli.js" watch --launch ${LAUNCH})`,
  ]);
  // Only rule kinds Claude Code matches: Edit covers Write.
  assert.deepEqual(
    files.settings.permissions.deny.map((rule) => rule.replace(/\(.*/, "")),
    ["Read", "Edit"],
  );
  assert.ok(
    files.settings.permissions.deny.every((rule) =>
      /\.parley\/\*\*\)$/.test(rule),
    ),
  );
  assert.deepEqual(files.mcp.mcpServers.parley.args, [
    "C:/parley/src/cli.js",
    "mcp",
    "--launch",
    LAUNCH,
  ]);
  // No prompt of the person's own: Claude is first asked, in one line, to arm
  // the watch; a resumed conversation only to arm this launch's new one.
  const fresh = claudeArgs(files, [])[0];
  assert.match(fresh, /^Parley is on: arm its message watch, /);
  assert.ok(fresh.includes(files.watch));
  assert.ok(fresh.length < 400, fresh);
  const args = claudeArgs(files, ["--resume"]);
  assert.match(args[0], /^Parley is on again: arm its new message watch, /);
  assert.ok(args[0].includes(files.watch));
  assert.match(claudeArgs(files, ["-c"])[0], /^Parley is on again/);
  assert.deepEqual(args.slice(1), [
    "--resume",
    "--settings",
    files.settingsFile,
    "--mcp-config",
    files.mcpFile,
  ]);
  // A prompt of their own stays first, and is not read as an MCP config.
  assert.deepEqual(claudeArgs(files, ["--model", "opus", "fix the tests"]), [
    "--model",
    "opus",
    "fix the tests",
    "--settings",
    files.settingsFile,
    "--mcp-config",
    files.mcpFile,
  ]);
  // A node path with spaces cannot start a PowerShell command.
  assert.match(
    watchCommand("C:/Program Files/nodejs/node.exe", "/p/cli.js", "x"),
    /^node "/,
  );
});

test("the person's own status line is found where Claude Code would find it", (t) => {
  const { home, root } = setup(t);
  const env = { CLAUDE_CONFIG_DIR: join(home, ".claude") };
  assert.equal(ownStatusLine({ cwd: root, env, home }), null);
  write(join(home, ".claude", "settings.json"), {
    statusLine: { type: "command", command: "user-line" },
  });
  assert.equal(ownStatusLine({ cwd: root, env, home }).command, "user-line");
  write(join(root, ".claude", "settings.json"), {
    statusLine: { type: "command", command: "project-line" },
  });
  write(join(root, ".claude", "settings.local.json"), {
    statusLine: { type: "command", command: "local-line" },
  });
  assert.equal(ownStatusLine({ cwd: root, env, home }).command, "local-line");
});

test("Parley's row says what matters and fits the terminal", () => {
  const env = { NO_COLOR: "1" };
  const status = {
    room: "shop",
    members: [{ name: "Alex", state: "idle" }],
    relay: "connected",
    watching: true,
    unread: 2,
    pending: 0,
    notices: 0,
    blocked: null,
  };
  assert.equal(
    parleyRow(status, { env }),
    "\u21c4 parley \u00b7 shop \u00b7 \u25cf live \u00b7 2 new \u00b7 1/1 online",
  );
  assert.equal(
    parleyRow(status, { env: { ...env, PARLEY_GLYPHS: "plain" }, columns: 28 }),
    "<> parley - shop - * live",
  );
  assert.match(
    parleyRow({ ...status, watching: false }, { env }),
    /watch not armed/,
  );
  assert.match(
    parleyRow({ ...status, blocked: "other repository" }, { env }),
    /different repository, paused/,
  );
  assert.match(parleyRow(null, { env }), /starting/);
});

test("the status line keeps the person's own line exactly, with Parley's row under it", () => {
  const env = { ...process.env, NO_COLOR: "1", COLUMNS: "120" };
  const launch = {
    ownStatusLine: { command: "echo their-line" },
    status: { room: "shop", relay: "connected", watching: true, members: [] },
  };
  const out = statusLine({ launch, stdinText: "{}", env });
  const [theirs, ours] = out.trimEnd().split("\n");
  assert.equal(theirs, "their-line");
  assert.match(ours, /parley \u00b7 shop \u00b7 \u25cf live/);
  assert.match(
    statusLine({ launch: { status: null }, stdinText: "{}", env }),
    /^\u21c4 parley/,
  );
});

test("permission rule paths use Claude Code's forms", () => {
  const home = process.platform === "win32" ? "C:\\Users\\a" : "/home/a";
  assert.equal(rulePath(join(home, ".parley"), home), "~/.parley");
  if (process.platform === "win32")
    assert.equal(rulePath("D:\\data\\.parley", home), "//d/data/.parley");
  else assert.equal(rulePath("/srv/.parley", home), "//srv/.parley");
});

test("a turn does not end with the watch down, but gets time to connect", (t) => {
  const { paths, hook } = setup(t);
  hook("session-start", { source: "startup" });
  const blocked = hook("stop", {});
  assert.equal(blocked.decision, "block");
  assert.ok(blocked.reason.includes(WATCH));
  // Already continued for this stop once: let it end.
  assert.equal(hook("stop", { stop_hook_active: true }), null);
  // Claude just started the watch: no need to ask again.
  hook("pre-tool-use", {
    tool_name: "Monitor",
    tool_input: { command: WATCH },
  });
  assert.ok(readLaunch(paths, LAUNCH).armingAt);
  assert.equal(hook("stop", {}), null);
  // Armed: nothing to ask.
  updateLaunch(paths, LAUNCH, (l) => {
    l.armingAt = 0;
    l.status = { watching: true };
  });
  assert.equal(hook("stop", {}), null);
  // Parley paused here (another repository): nothing to ask either.
  updateLaunch(paths, LAUNCH, (l) => {
    l.status = { watching: false, blocked: "other repository" };
  });
  assert.equal(hook("stop", {}), null);
});

test("the row says the watch is arming at first, and only later that it is down", () => {
  const now = Date.now();
  assert.equal(watchState({ status: { watching: true } }, now), "armed");
  assert.equal(
    watchState({ started: now - 10_000, status: {} }, now),
    "arming",
  );
  assert.equal(
    watchState(
      { started: now - 600_000, armingAt: now - 3000, status: {} },
      now,
    ),
    "arming",
  );
  assert.equal(watchState({ started: now - 600_000, status: {} }, now), "off");
  const env = { NO_COLOR: "1" };
  const status = { room: "shop", relay: "connected", watching: false };
  assert.match(
    parleyRow({ ...status, watchState: "arming" }, { env }),
    /arming watch/,
  );
  assert.match(
    parleyRow({ ...status, watchState: "off" }, { env }),
    /watch not armed/,
  );
});

test("parley does not start where Parley has nothing to do", (t) => {
  const { home, paths, root } = setup(t);
  // In the room's folder (and below it): fine.
  assert.equal(
    checkFolder({ paths, cwd: join(root, "src") }).room.name,
    "shop",
  );
  // Elsewhere: not in a room.
  mkdirSync(join(home, "elsewhere"), { recursive: true });
  assert.throws(
    () => checkFolder({ paths, cwd: join(home, "elsewhere") }),
    /not in a Parley room.*plain `claude`/,
  );
  // Not set up: no keys.
  const bare = tempHome(t);
  assert.throws(
    () => checkFolder({ paths: bare.paths, cwd: root }),
    /not set up/,
  );
});

test("every tool Parley lists has an implementation", async () => {
  const sent = [];
  const server = new ParleyServer({
    paths: null,
    launchId: "launch-1234",
    env: {},
    write: (m) => sent.push(m),
  });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = sent[0].result.tools.map((t) => t.name);
  assert.ok(tools.length >= 18);
  for (const name of tools)
    assert.equal(typeof server[`tool_${name}`], "function", name);
});
