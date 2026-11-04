import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { ViewApp, entryLines, makeStore } from "../src/view.js";
import { glyphSets } from "../src/ui.js";

const room = {
  roomId: "r",
  name: "shop",
  project: "/code/shop",
  relay: "wss://relay.example",
  members: {
    jo: { name: "Jo", status: "approved", fingerprint: "AAAA BBBB" },
    al: { name: "Alex", status: "approved", fingerprint: "CCCC DDDD" },
  },
  versions: { relay: { app: "0.4.0" } },
};

const state = (extra = {}) => ({
  room,
  log: [
    {
      id: "1",
      at: Date.UTC(2026, 10, 4, 9, 30),
      from: "jo",
      name: "Jo",
      kind: "message",
      text: "pushed the cart refactor",
    },
    {
      id: "2",
      at: Date.UTC(2026, 10, 4, 9, 31),
      own: true,
      name: "George",
      kind: "message",
      text: "pulling",
      to: ["jo"],
      human: true,
    },
    {
      id: "3",
      at: Date.UTC(2026, 10, 4, 9, 32),
      from: "al",
      name: "Alex",
      kind: "note",
      topic: "release",
      text: "Thursdays",
    },
  ],
  activity: [
    { id: "jo", name: "Jo", state: "working", at: Date.now() },
    { id: "al", name: "Alex", state: "offline", at: null },
  ],
  pending: [],
  versions: [],
  memory: [
    {
      id: "3",
      at: Date.now(),
      name: "Alex",
      topic: "release",
      text: "Thursdays",
    },
  ],
  claims: [],
  notices: [],
  running: 1,
  relay: "connected",
  autonomy: "work",
  approvals: false,
  ...extra,
});

const tick = () => new Promise((r) => setTimeout(r, 30));

test("the view shows the room, who is around and the conversation", async () => {
  const store = makeStore(() => state());
  const ui = render(
    h(ViewApp, {
      store,
      actions: { say: async () => "" },
      glyphs: "plain",
      size: { cols: 100, rows: 20 },
    }),
  );
  const frame = ui.lastFrame();
  for (const text of [
    "<> parley",
    "shop",
    "* live",
    "1/2 online",
    "1 working",
    "Conversation",
    "Jo",
    "pushed the cart refactor",
    "you -> Jo",
    'remembered "release": Thursdays',
    "write to the room as yourself",
  ])
    assert.ok(frame.includes(text), `missing ${text}:\n${frame}`);
  ui.unmount();
});

test("tab moves between sections; members, memory and the room show", async () => {
  const store = makeStore(() => state());
  const ui = render(
    h(ViewApp, {
      store,
      actions: { say: async () => "" },
      glyphs: "plain",
      size: { cols: 100, rows: 20 },
    }),
  );
  ui.stdin.write("\t");
  await tick();
  assert.match(ui.lastFrame(), /Jo\s+working\s+AAAA BBBB/);
  assert.match(ui.lastFrame(), /Alex\s+offline/);
  ui.stdin.write("\t");
  await tick();
  assert.match(ui.lastFrame(), /release[\s\S]*Thursdays/);
  ui.stdin.write("\t");
  ui.stdin.write("\t");
  await tick();
  assert.match(ui.lastFrame(), /Autonomy\s+work/);
  ui.unmount();
});

test("writing in the conversation sends as the person, @name to one", async () => {
  const said = [];
  const store = makeStore(() => state());
  const ui = render(
    h(ViewApp, {
      store,
      actions: { say: async (text, to) => (said.push([text, to]), "Sent.") },
      glyphs: "plain",
      size: { cols: 100, rows: 20 },
    }),
  );
  for (const ch of "hello room") ui.stdin.write(ch);
  await tick();
  assert.match(ui.lastFrame(), /> hello room_/);
  ui.stdin.write("\r");
  await tick();
  for (const ch of "@Jo just you") ui.stdin.write(ch);
  ui.stdin.write("\r");
  await tick();
  assert.deepEqual(said, [
    ["hello room", []],
    ["just you", ["Jo"]],
  ]);
  assert.match(ui.lastFrame(), /Sent\./);
  ui.unmount();
});

test("entries wrap to the pane, with who, to whom and when", () => {
  const lines = entryLines(
    {
      id: "x",
      at: Date.UTC(2026, 0, 1, 8, 5),
      from: "jo",
      name: "Jo",
      kind: "message",
      text: "a ".repeat(60).trim(),
      to: ["me"],
    },
    room,
    40,
    glyphSets.plain,
  );
  assert.equal(lines[0].map(([t]) => t).join(""), " Jo -> you  08:05");
  assert.ok(lines.slice(1, -1).every((l) => l[0][0].length <= 40));
  const head = (entry) =>
    entryLines(
      {
        id: "y",
        at: Date.UTC(2026, 0, 1, 8, 5),
        kind: "message",
        text: "hi",
        ...entry,
      },
      room,
      40,
      glyphSets.plain,
    )[0]
      .map(([t]) => t)
      .join("");
  assert.equal(head({ own: true }), " your agent  08:05");
  assert.equal(
    head({ own: true, human: true, to: ["al"] }),
    " you -> Alex  08:05",
  );
  assert.equal(
    head({ from: "jo", name: "Jo", human: true }),
    " Jo (typed)  08:05",
  );
});
