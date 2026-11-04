import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync, mkdirSync } from "node:fs";
import { handleHook } from "../src/hooks.js";
import {
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
  updateSession,
} from "../src/sessions.js";
import { checkArgs, claudeArgs, launchFiles, rulePath } from "../src/launch.js";
import { ParleyServer } from "../src/mcp.js";
import { tempHome } from "./helpers.js";

const SID = "11111111-aaaa";

function setup(t, { room = true } = {}) {
  const { home, paths } = tempHome(t);
  createIdentity(paths, "Alice");
  const project = join(home, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  const root = realpathSync.native(project);
  if (room) {
    const r = newRoom({
      secret: newRoomSecret(),
      relay: "wss://relay.example",
      name: "shop",
      root,
    });
    saveRoom(paths, r);
    bindProject(paths, root, r.roomId);
  }
  const hook = (event, input = {}, now = Date.now()) =>
    handleHook(
      event,
      {
        session_id: SID,
        cwd: join(root, "src"),
        permission_mode: "default",
        ...input,
      },
      { paths, launchId: "launch-1234", now },
    );
  return { paths, root, hook };
}

test("a fresh conversation is off, with a hint when the folder has a room", (t) => {
  const { paths, hook } = setup(t);
  const out = hook("session-start", { source: "startup" });
  assert.match(out.systemMessage, /room "shop".*parley on/);
  assert.equal(readSession(paths, SID).enabled, false);
  assert.equal(readLaunch(paths, "launch-1234").sessionId, SID);
});

test("parley on and off are the person's own prompts, blocked before the model", (t) => {
  const { paths, hook } = setup(t);
  const on = hook("user-prompt", { prompt: "  Parley on " });
  assert.equal(on.decision, "block");
  assert.equal(on.hookSpecificOutput.suppressOriginalPrompt, true);
  assert.equal(readSession(paths, SID).enabled, true);
  // On survives a resume: the session id is the same.
  const resumed = hook("session-start", { source: "resume" });
  assert.match(resumed.hookSpecificOutput.additionalContext, /Parley is on/);
  hook("user-prompt", { prompt: "parley off" });
  assert.equal(readSession(paths, SID).enabled, false);
  // Mentioning Parley in a sentence is just a prompt.
  assert.equal(
    hook("user-prompt", { prompt: "should we turn parley on later?" }),
    null,
  );
});

test("Parley will not turn on while permissions are bypassed", (t) => {
  const { paths, hook } = setup(t);
  const out = hook("user-prompt", {
    prompt: "parley on",
    permission_mode: "bypassPermissions",
  });
  assert.match(out.reason, /bypassed/);
  assert.notEqual(readSession(paths, SID)?.enabled, true);
});

test("without a room, parley on explains how to get one", (t) => {
  const { hook } = setup(t, { room: false });
  assert.match(
    hook("user-prompt", { prompt: "parley on" }).reason,
    /parley create/,
  );
  assert.equal(hook("session-start", { source: "startup" }), null);
});

test("Parley's tools are refused while it is off", (t) => {
  const { hook } = setup(t);
  const out = hook("pre-tool-use", { tool_name: "mcp__parley__send" });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  hook("user-prompt", { prompt: "parley on" });
  assert.equal(hook("pre-tool-use", { tool_name: "mcp__parley__send" }), null);
  const bypass = hook("pre-tool-use", {
    tool_name: "mcp__parley__send",
    permission_mode: "bypassPermissions",
  });
  assert.equal(bypass.hookSpecificOutput.permissionDecision, "deny");
});

test("a turn a member's message started may only read", (t) => {
  const { paths, hook } = setup(t);
  hook("user-prompt", { prompt: "parley on" });
  hook("user-prompt", { prompt: "work on the cart" });
  hook("stop");
  updateSession(paths, SID, (s) => recordWake(s));
  // Claude Code's own prompt for the woken turn does not count as the person.
  hook("user-prompt", { prompt: '<channel source="parley">...</channel>' });
  for (const tool of [
    "Edit",
    "Write",
    "Bash",
    "PowerShell",
    "WebFetch",
    "Agent",
    "mcp__github__create_pull_request",
  ])
    assert.equal(
      hook("pre-tool-use", { tool_name: tool }).hookSpecificOutput
        .permissionDecision,
      "deny",
      tool,
    );
  for (const tool of [
    "Read",
    "Grep",
    "Glob",
    // Loading Parley's deferred tools is how a woken turn gets to reply.
    "ToolSearch",
    "mcp__parley__inbox",
    "mcp__parley__send",
  ])
    assert.equal(hook("pre-tool-use", { tool_name: tool }), null, tool);
  // The person writes after the wake (a later millisecond, for certain).
  hook("user-prompt", { prompt: "go ahead and fix it" }, Date.now() + 1000);
  assert.equal(hook("pre-tool-use", { tool_name: "Edit" }), null);
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

test("a launch's settings run hooks without a shell and fence off ~/.parley", (t) => {
  const { paths } = setup(t);
  const files = launchFiles({
    paths,
    launchId: "launch-1234",
    nodePath: "C:\\node\\node.exe",
    cliPath: "C:\\parley\\src\\cli.js",
  });
  const [handler] = files.settings.hooks.PreToolUse[0].hooks;
  assert.deepEqual(handler, {
    type: "command",
    command: "C:/node/node.exe",
    args: [
      "C:/parley/src/cli.js",
      "hook",
      "pre-tool-use",
      "--launch",
      "launch-1234",
    ],
    timeout: 10,
  });
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
    "launch-1234",
  ]);
});

test("permission rule paths use Claude Code's forms", () => {
  const home = process.platform === "win32" ? "C:\\Users\\a" : "/home/a";
  assert.equal(rulePath(join(home, ".parley"), home), "~/.parley");
  if (process.platform === "win32")
    assert.equal(rulePath("D:\\data\\.parley", home), "//d/data/.parley");
  else assert.equal(rulePath("/srv/.parley", home), "//srv/.parley");
});

test("the /parley command toggles like the plain prompt", (t) => {
  const { paths, hook } = setup(t);
  assert.equal(hook("user-prompt", { prompt: "/parley on" }).decision, "block");
  assert.equal(readSession(paths, SID).enabled, true);
  assert.match(
    hook("user-prompt", { prompt: "/parley:parley status" }).reason,
    /Parley is on/,
  );
  hook("user-prompt", { prompt: "/parley off" });
  assert.equal(readSession(paths, SID).enabled, false);
});

test("a launch brings the /parley plugin, and the MCP server only before install", (t) => {
  const { paths } = setup(t);
  const before = launchFiles({
    paths,
    launchId: "launch-1234",
    cliPath: "/p/cli.js",
  });
  const after = launchFiles({
    paths,
    launchId: "launch-1234",
    cliPath: "/p/cli.js",
    installed: true,
  });
  const argsBefore = claudeArgs(before, ["--resume"]);
  const argsAfter = claudeArgs(after, ["--resume"]);
  assert.ok(argsBefore.includes("--mcp-config"));
  assert.ok(!argsAfter.includes("--mcp-config"));
  for (const args of [argsBefore, argsAfter]) {
    assert.equal(args[args.indexOf("--plugin-dir") + 1], before.pluginDir);
    assert.deepEqual(
      args.slice(-3),
      [
        "--dangerously-load-development-channels",
        "server:parley",
        "--resume",
      ].slice(-3),
    );
  }
  const command = Object.entries(after.pluginFiles).find(([file]) =>
    file.endsWith("parley.md"),
  )[1];
  assert.match(command, /disable-model-invocation: true/);
});

test("the installed MCP server is dormant outside a parley launch", async () => {
  const sent = [];
  const server = new ParleyServer({
    paths: null,
    launchId: null,
    env: {},
    write: (m) => sent.push(m),
  });
  await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { capabilities: {} },
  });
  await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.deepEqual(sent[0].result.capabilities, {});
  assert.equal(sent[0].result.instructions, undefined);
  assert.deepEqual(sent[1].result.tools, []);
  assert.equal(server.timer, undefined);
});
