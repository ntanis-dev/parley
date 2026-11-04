import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToString } from "ink";
import { render } from "ink-testing-library";
import { ViewApp, createView, entryLines, makeStore } from "../src/view.js";
import { Screen } from "../src/view/app.js";
import { createReplyFilter } from "../src/view/input.js";
import { keyOf } from "../src/view/keys.js";
import { reduce } from "../src/view/reducer.js";
import { initialState, lastToast } from "../src/view/state.js";
import { makeTheme } from "../src/view/theme.js";
import { width } from "../src/view/text.js";
import { glyphSets } from "../src/ui.js";

// The view without a terminal: fixture snapshots, its frames drawn by Ink
// (ink-testing-library, 100 columns, for keys and clicks; renderToString at
// any size for the layout), and its actions recorded instead of run. The
// person at the keyboard is Alex; Jo and Chris are in the room, Sam asks to
// join.
const NOW = Date.UTC(2026, 10, 4, 9, 40);
const at = (hh, mm) => Date.UTC(2026, 10, 4, hh, mm);
const FP = {
  jo: "AAAA BBBB CCCC DDDD EEEE FFFF",
  ch: "9F3A 77B2 0C1D 4E5F 6A7B 8C9D",
  sa: "1234 5678 9ABC DEF0 1234 5678",
};
const room = {
  roomId: "r",
  name: "shop",
  project: "/home/alex/code/shop",
  relay: "wss://relay.example",
  members: {
    jo: { name: "Jo", status: "approved", fingerprint: FP.jo, via: "invite" },
    ch: { name: "Chris", status: "approved", fingerprint: FP.ch },
    sa: {
      name: "Sam",
      status: "pending",
      fingerprint: FP.sa,
      via: "knocked",
      since: "2026-11-04T09:12:00Z",
    },
  },
  versions: { relay: { app: "0.4.0" }, members: { jo: { app: "0.4.0" } } },
};

const fixture = (extra = {}) => ({
  room,
  log: [
    {
      id: "1",
      at: at(9, 30),
      from: "jo",
      name: "Jo",
      kind: "message",
      text: "pushed the cart refactor",
    },
    {
      id: "2",
      at: at(9, 31),
      own: true,
      human: true,
      name: "Alex",
      kind: "message",
      text: "pulling",
      to: ["jo"],
    },
    {
      id: "3",
      at: at(9, 32),
      from: "ch",
      name: "Chris",
      kind: "note",
      topic: "release",
      text: "Thursdays",
    },
    {
      id: "4",
      at: at(9, 33),
      from: "jo",
      name: "Jo",
      human: true,
      kind: "message",
      text: "thanks, rebasing",
    },
    {
      id: "5",
      at: at(9, 34),
      own: true,
      name: "Alex",
      kind: "message",
      text: "tests pass",
    },
  ],
  activity: [
    { id: "jo", name: "Jo", state: "working", at: NOW - 20_000 },
    { id: "ch", name: "Chris", state: "offline", at: null },
  ],
  pending: [{ id: "sa", ...room.members.sa }],
  versions: [],
  memory: [
    {
      id: "3",
      at: at(9, 32),
      from: "ch",
      name: "Chris",
      topic: "release",
      text: "Thursdays",
    },
  ],
  claims: [
    {
      member: "jo",
      name: "Jo",
      own: false,
      path: "src/cart",
      note: "refactoring",
      until: at(15, 30),
    },
  ],
  notices: [],
  running: 1,
  relay: "connected",
  autonomy: "work",
  approvals: false,
  home: "/home/alex",
  you: { id: "me", name: "Alex", fingerprint: "5E6F 7A8B 9C0D 1E2F 3A4B 5C6D" },
  ...extra,
});

// Every action the view can ask for, recorded.
function recorder(answers = {}) {
  const calls = [];
  const actions = {};
  for (const name of [
    "say",
    "approve",
    "block",
    "autonomy",
    "approvals",
    "invite",
    "copy",
  ])
    actions[name] = async (...args) => {
      calls.push([name, ...args]);
      const answer = answers[name];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(...args) : answer;
    };
  return { calls, actions };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const keys = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  shiftTab: "\x1b[Z",
  backspace: "\x7f",
  ctrlT: "\x14",
};

// The view in ink-testing-library, with its running state (for the mouse).
function open(
  t,
  { data = fixture(), answers, size = { cols: 100, rows: 30 } } = {},
) {
  const store = makeStore(() => data);
  const { calls, actions } = recorder(answers);
  let quit = 0;
  const view = createView({
    data: store,
    actions,
    size,
    color: false,
    glyphs: "plain",
    now: () => NOW,
    onQuit: () => quit++,
  });
  const ui = render(h(ViewApp, { store, actions, view }));
  t.after(() => {
    ui.unmount();
    view.close();
  });
  // Mouse reports go through the same filter as a terminal's.
  const filter = createReplyFilter((event) =>
    view.dispatch({ type: "mouse", ...event }),
  );
  const press = async (...list) => {
    for (const key of list) {
      ui.stdin.write(key);
      await tick(key === keys.escape ? 80 : 25);
    }
  };
  const type = async (text) => {
    for (const ch of text) ui.stdin.write(ch);
    await tick();
  };
  const frame = () => ui.lastFrame();
  // Where `text` is on the screen (cells from the left, rows from the top).
  const locate = (text, { from = 0 } = {}) => {
    const rows = frame().split("\n");
    for (let y = 0; y < rows.length; y++) {
      const i = rows[y].indexOf(text);
      if (i >= 0 && width(rows[y].slice(0, i)) >= from)
        return { x: width(rows[y].slice(0, i)), y };
    }
    assert.fail(`missing ${text}:\n${frame()}`);
  };
  const click = async (text, options) => {
    const { x, y } = locate(text, options);
    assert.equal(filter.push(`\x1b[<0;${x + 1};${y + 1}M`), "");
    filter.push(`\x1b[<0;${x + 1};${y + 1}m`);
    await tick();
  };
  const wheel = async (text, down = true) => {
    const { x, y } = locate(text);
    filter.push(`\x1b[<${down ? 65 : 64};${x + 1};${y + 1}M`);
    await tick();
  };
  return {
    ui,
    view,
    calls,
    press,
    type,
    frame,
    click,
    wheel,
    quits: () => quit,
    state: () => view.getState(),
  };
}

const has = (frame, ...texts) => {
  for (const text of texts)
    assert.ok(frame.includes(text), `missing ${text}:\n${frame}`);
};

// A state after keys, drawn at any size the way a terminal would show it.
const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function drawn(size, keyList = [], { data = fixture(), glyphs = "rich" } = {}) {
  let state = initialState({ data, size, glyphs, color: false, now: NOW });
  for (const key of keyList)
    state = reduce(
      state,
      typeof key === "object"
        ? { now: NOW, ...key }
        : { type: "key", key, now: NOW },
    ).state;
  return renderToString(h(Screen, { state }), { columns: size.cols })
    .replace(ansi, "")
    .split("\n");
}

test("the view shows the room, who is around and the conversation", async (t) => {
  const v = open(t);
  has(
    v.frame(),
    "<> parley",
    "shop",
    "* live",
    "1/2 online",
    "~ 1 waiting",
    "Conversation",
    "Members",
    "Jo",
    "working",
    "Sam",
    "waiting",
    "release",
    "Claims",
    "Room",
    "Write to the room as yourself",
  );
});

test("who wrote an entry reads as the person would say it", (t) => {
  const head = (entry) =>
    entryLines(
      {
        id: "x",
        at: Date.UTC(2026, 0, 1, 8, 5),
        kind: "message",
        text: "hi",
        ...entry,
      },
      room,
      60,
      glyphSets.plain,
      "me",
    )[0]
      .map(([t]) => t)
      .join("");
  assert.equal(head({ from: "jo", name: "Jo" }), "08:05 Jo's agent");
  assert.equal(head({ from: "jo", name: "Jo", human: true }), "08:05 Jo");
  assert.equal(head({ from: "ch", name: "Chris" }), "08:05 Chris' agent");
  assert.equal(head({ own: true }), "08:05 your agent");
  assert.equal(head({ own: true, human: true, to: ["jo"] }), "08:05 you -> Jo");
  assert.equal(
    head({ from: "jo", name: "Jo", to: ["me"] }),
    "08:05 Jo's agent -> you",
  );
  assert.equal(
    head({ from: "jo", name: "Jo", to: ["me", "ch"] }),
    "08:05 Jo's agent -> you, Chris",
  );
  assert.equal(
    head({ from: "ch", name: "Chris", kind: "note", topic: "release" }),
    '08:05 Chris\' agent remembered "release"',
  );
  // Long text wraps under the time, inside the width.
  const lines = entryLines(
    {
      id: "y",
      at: 0,
      from: "jo",
      name: "Jo",
      kind: "message",
      text: "a ".repeat(60).trim(),
    },
    room,
    40,
    glyphSets.plain,
  );
  assert.ok(lines.length > 2);
  assert.ok(lines.every((l) => width(l.map(([t]) => t).join("")) <= 40));
  assert.ok(lines.slice(1).every((l) => l[0][0] === "      "));
});

test("the conversation shows each entry with its author, recipient and time", async (t) => {
  const v = open(t);
  has(
    v.frame(),
    "09:30 Jo's agent",
    "pushed the cart refactor",
    "09:31 you -> Jo",
    '09:32 Chris\' agent remembered "release"',
    "09:33 Jo",
    "09:34 your agent",
  );
});

test("writing in the conversation sends as the person, @name to one", async (t) => {
  const v = open(t, {
    answers: {
      say: (text, to) =>
        to.length ? `Sent to ${to[0]}.` : "Sent to the room.",
    },
  });
  await v.type("hello room");
  has(v.frame(), "> hello room");
  await v.press(keys.enter);
  await v.type("@Jo just you");
  has(v.frame(), "To Jo");
  await v.press(keys.enter);
  await tick();
  assert.deepEqual(v.calls, [
    ["say", "hello room", []],
    ["say", "just you", ["Jo"]],
  ]);
  has(v.frame(), "Sent to Jo.");
  // Text that arrives with its Enter at once is sent too.
  v.ui.stdin.write("all at once\r");
  await tick(60);
  assert.deepEqual(v.calls.at(-1), ["say", "all at once", []]);
});

test("choosing who to write to, and a message that fails comes back", async (t) => {
  const v = open(t, {
    answers: { say: new Error("That names a file outside the project.") },
  });
  await v.press(keys.ctrlT);
  has(v.frame(), "Write to", "Everyone in the room", "Jo", "Chris");
  assert.ok(!v.frame().includes("1 Sam"), "a waiting member is not offered");
  await v.press(keys.down, keys.enter);
  has(v.frame(), "To Jo", "Write to Jo as yourself");
  await v.type("see ../secret");
  await v.press(keys.enter);
  await tick();
  assert.deepEqual(v.calls, [["say", "see ../secret", ["Jo"]]]);
  has(v.frame(), "That names a file outside the project.", "> see ../secret");
  // Backspace edits, Esc clears and then leaves the line.
  await v.press(keys.backspace);
  has(v.frame(), "> see ../secre");
  await v.press(keys.escape);
  assert.equal(v.state().draft.value, "");
  await v.press(keys.escape);
  assert.equal(v.state().focus, "side");
});

test("arrows move through the sidebar, into the pane and back; Tab goes by section", async (t) => {
  const v = open(t);
  await v.press(keys.escape);
  assert.equal(v.state().focus, "side");
  await v.press(keys.down);
  assert.equal(v.state().selected, "members");
  has(v.frame(), "Members", "1 of 2 online", FP.jo);
  await v.press(keys.down);
  assert.equal(v.state().selected, "member:jo");
  has(v.frame(), "Fingerprint".toUpperCase(), FP.jo, "Write to Jo");
  // Left goes to the parent, and closes it; Right opens it again.
  await v.press(keys.left);
  assert.equal(v.state().selected, "members");
  await v.press(keys.left);
  assert.equal(v.state().open.members, false);
  await v.press(keys.right);
  assert.equal(v.state().open.members, true);
  // Right on an open node gives the pane the keys; Up and Down choose there.
  await v.press(keys.right);
  assert.equal(v.state().focus, "pane");
  await v.press(keys.down, keys.enter);
  assert.equal(v.state().selected, "member:ch");
  await v.press(keys.left);
  assert.equal(v.state().focus, "side");
  // Tab and Shift+Tab go from section to section.
  await v.press(keys.tab);
  assert.equal(v.state().selected, "memory");
  await v.press(keys.tab, keys.tab);
  assert.equal(v.state().selected, "room");
  has(v.frame(), "Autonomy", "Approvals", "Show invite");
  await v.press(keys.tab);
  assert.equal(v.state().selected, "conv");
  assert.equal(v.state().focus, "compose");
  await v.press(keys.shiftTab);
  assert.equal(v.state().selected, "room");
  // Esc in the sidebar quits, as q does.
  await v.press(keys.escape);
  assert.equal(v.quits(), 1);
  await v.press("q");
  assert.equal(v.quits(), 2);
});

test("memory and claims: topics in the sidebar, the note in full", async (t) => {
  const v = open(t);
  await v.press(keys.tab, keys.tab);
  has(v.frame(), "What the room decided", "release", "Chris' agent");
  await v.press(keys.down);
  assert.equal(v.state().selected, "note:release");
  has(v.frame(), "Remembered by Chris' agent", "Thursdays");
  await v.press(keys.tab);
  has(
    v.frame(),
    "Who is working on what",
    "Jo  src/cart",
    "until 15:30 UTC",
    "refactoring",
  );
});

test("approving a member compares the fingerprint, then asks for their name", async (t) => {
  const v = open(t, { answers: { approve: { announced: true } } });
  await v.press(keys.escape, keys.down, keys.down, keys.down, keys.down);
  assert.equal(v.state().selected, "member:sa");
  has(v.frame(), "Sam asked to join", FP.sa, "Approve  a");
  await v.press("a");
  has(v.frame(), "Is this Sam's fingerprint?", FP.sa, "Same, continue");
  // Enter is No unless chosen otherwise: nothing happens.
  await v.press(keys.enter);
  assert.equal(v.state().modal, null);
  has(v.frame(), "Sam is still waiting.");
  await v.press("a", "y");
  has(
    v.frame(),
    "You are about to trust Sam",
    "Only continue if you trust Sam",
    "Type Sam to confirm",
  );
  // The wrong name approves nobody.
  await v.type("Jo");
  await v.press(keys.enter);
  assert.deepEqual(v.calls, []);
  has(v.frame(), "Not approved");
  await v.press("a", "y");
  await v.type("sam");
  await v.press(keys.enter);
  await tick();
  assert.deepEqual(v.calls, [["approve", "sa"]]);
  has(v.frame(), "Sam is in.");
});

test("blocking asks first, and No is the default", async (t) => {
  const v = open(t);
  await v.press(keys.escape, keys.down, keys.down);
  assert.equal(v.state().selected, "member:jo");
  await v.press("b");
  has(v.frame(), "Block Jo?", "Nothing more is sent to or read from Jo", FP.jo);
  await v.press(keys.enter);
  assert.deepEqual(v.calls, []);
  // From the Actions dialog (Enter on the member), with y.
  await v.press(keys.enter);
  has(v.frame(), "Write to Jo", "Block");
  await v.press(keys.down, keys.enter);
  has(v.frame(), "Block Jo?");
  await v.press("y");
  await tick();
  assert.deepEqual(v.calls, [["block", "jo"]]);
  has(v.frame(), "Blocked Jo.");
});

test("writing to one member from the members", async (t) => {
  const v = open(t);
  await v.press(keys.escape, keys.down, keys.down, "w");
  assert.equal(v.state().selected, "conv");
  assert.equal(v.state().focus, "compose");
  has(v.frame(), "To Jo");
  await v.type("ping");
  await v.press(keys.enter);
  await tick();
  assert.deepEqual(v.calls, [["say", "ping", ["Jo"]]]);
});

test("the room's settings change as the commands would, widening after a warning", async (t) => {
  const data = fixture();
  const store = makeStore(() => data);
  const { calls, actions } = recorder();
  const view = createView({
    data: store,
    actions,
    size: { cols: 100, rows: 30 },
    color: false,
    glyphs: "plain",
    now: () => NOW,
  });
  const ui = render(h(ViewApp, { store, actions, view }));
  t.after(() => {
    ui.unmount();
    view.close();
  });
  const press = async (...list) => {
    for (const key of list) {
      ui.stdin.write(key);
      await tick(key === keys.escape ? 80 : 25);
    }
  };
  await press(keys.shiftTab, keys.right);
  assert.equal(view.getState().focus, "pane");
  // Autonomy work -> read needs no confirmation.
  await press(keys.enter);
  await tick();
  assert.deepEqual(calls.at(-1), ["autonomy", "read"]);
  // read -> work asks for "work" typed.
  data.autonomy = "read";
  store.refresh();
  await press(keys.enter);
  has(
    ui.lastFrame(),
    "Members' agents will be able to change this project",
    "Type work to confirm",
  );
  for (const ch of "work") ui.stdin.write(ch);
  await press(keys.enter);
  await tick();
  assert.deepEqual(calls.at(-1), ["autonomy", "work"]);
  // Approvals off -> on at once; on -> off asks first.
  await press(keys.down, keys.enter);
  await tick();
  assert.deepEqual(calls.at(-1), ["approvals", true]);
  data.approvals = true;
  store.refresh();
  await press("p");
  has(ui.lastFrame(), "Turn approvals off?");
  await press("n");
  assert.deepEqual(calls.at(-1), ["approvals", true]);
  await press("p", "y");
  await tick();
  assert.deepEqual(calls.at(-1), ["approvals", false]);
});

test("the invite shows whole and copies", async (t) => {
  const code = `parley1:${"x".repeat(150)}`;
  const v = open(t, { answers: { invite: code, copy: "Copied the invite." } });
  await v.press(keys.escape, "i");
  await tick();
  has(v.frame(), "Invite to shop", code.slice(0, 40), "Copy  c");
  const shown = v
    .frame()
    .split("\n")
    .map((row) => /\| (\S+) +\|/.exec(row)?.[1] ?? "")
    .join("");
  assert.ok(shown.includes(code), "the whole invite is in the dialog");
  await v.press("c");
  await tick();
  assert.deepEqual(v.calls, [["invite"], ["copy", code]]);
  has(v.frame(), "Copied the invite.");
});

test("the mouse: rows, buttons, footer keys, the header, the wheel", async (t) => {
  const v = open(t, { answers: { approve: { announced: true } } });
  // A member's row in the sidebar.
  await v.click("Chris");
  assert.equal(v.state().selected, "member:ch");
  has(v.frame(), FP.ch);
  // A button in the pane.
  await v.click("Block  b");
  has(v.frame(), "Block Chris?");
  await v.click("Cancel  n");
  assert.equal(v.state().modal, null);
  assert.deepEqual(v.calls, []);
  // A click outside a dialog closes it.
  await v.press("b");
  await v.click("<> parley");
  assert.equal(v.state().modal, null);
  // The header's waiting count goes to who is waiting.
  await v.click("~ 1 waiting");
  assert.equal(v.state().selected, "member:sa");
  await v.click("Approve  a");
  await v.click("Same, continue");
  has(v.frame(), "Type Sam to confirm");
  await v.type("Sam");
  await v.click("Confirm");
  await tick();
  assert.deepEqual(v.calls, [["approve", "sa"]]);
  // A key in the footer does what the key does.
  await v.click("Tab Section");
  assert.equal(v.state().selected, "memory");
  // A fold mark closes its node.
  await v.click("v Memory");
  assert.equal(v.state().open.memory, false);
  has(v.frame(), "> Memory");
  // Clicking the conversation's writing line gives it the keys.
  await v.click("Conversation");
  await v.press(keys.escape);
  assert.equal(v.state().focus, "side");
  await v.click("Write to the room as yourself");
  assert.equal(v.state().focus, "compose");
  // The wheel over the sidebar moves the selection.
  await v.wheel("Claims");
  assert.equal(v.state().selected, "members");
});

test("the wheel and the page keys scroll a long conversation; End follows again", async (t) => {
  const log = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`,
    at: at(9, 0) + i * 60_000,
    from: "jo",
    name: "Jo",
    kind: "message",
    text: `message number ${i}`,
  }));
  const data = fixture({ log });
  const v = open(t, { data });
  has(v.frame(), "message number 39", "* Live");
  assert.ok(!v.frame().includes("message number 5\n"));
  await v.wheel("message number 39", false);
  has(v.frame(), "Paused");
  assert.ok(!v.frame().includes("message number 39"), v.frame());
  // New entries while scrolled up are counted, not shown.
  data.log = [
    ...log,
    {
      id: "new",
      at: NOW,
      from: "ch",
      name: "Chris",
      kind: "message",
      text: "fresh",
    },
  ];
  v.view.dispatch({ type: "data", data: { ...data } });
  await tick();
  has(v.frame(), "1 new");
  await v.press("\x1b[5~");
  await v.press("\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[6~");
  has(v.frame(), "fresh", "* Live");
});

test("help, and the conversation's new entries counted while away", async (t) => {
  const v = open(t);
  await v.press(keys.escape, "?");
  has(v.frame(), "Parley view", "KEYS", "@name text", "to one member only");
  await v.press(keys.escape);
  assert.equal(v.state().modal, null);
  await v.press(keys.down);
  const data = fixture();
  data.log = [
    ...data.log,
    {
      id: "6",
      at: NOW,
      from: "jo",
      name: "Jo",
      kind: "message",
      text: "one more",
    },
  ];
  v.view.dispatch({ type: "data", data });
  await tick();
  has(v.frame(), "1 new");
  await v.press(keys.up);
  assert.ok(!v.frame().includes("1 new"));
});

test("keys come from Ink's input events; terminal replies and mouse reports never become keys", (t) => {
  assert.equal(keyOf("", { upArrow: true }), "up");
  assert.equal(keyOf("", { tab: true, shift: true }), "shift+tab");
  assert.equal(keyOf("t", { ctrl: true }), "ctrl+t");
  assert.equal(keyOf("q"), "q");
  assert.deepEqual(keyOf("abc"), { text: "abc" });
  const events = [];
  const filter = createReplyFilter((e) => events.push(e));
  assert.equal(filter.push("\x1b[<0;"), "");
  assert.equal(filter.push("12;9M"), "");
  assert.deepEqual(events[0], {
    x: 11,
    y: 8,
    button: 0,
    kind: "press",
    delta: 0,
  });
  assert.equal(filter.push("a\x1b[<65;3;4Mb\x1b[I"), "ab");
  assert.deepEqual(events[1], {
    x: 2,
    y: 3,
    button: 1,
    kind: "wheel",
    delta: 3,
  });
  // A report inside a paste is pasted text, not a click.
  filter.push("\x1b[200~\x1b[<0;1;1M\x1b[201~");
  assert.equal(events.length, 2);
});

test("frames fit at 80x24 and 140x40, the sidebar's border in one column", (t) => {
  const screens = {
    conversation: [],
    members: ["escape", "tab"],
    member: ["escape", "down", "down"],
    pending: ["escape", "tab", "down", "down", "down"],
    approve: ["escape", "tab", "down", "down", "down", "a"],
    trust: ["escape", "tab", "down", "down", "down", "a", "y"],
    memory: ["escape", "tab", "tab"],
    claims: ["escape", "tab", "tab", "tab"],
    room: ["escape", "shift+tab", "right"],
    help: ["escape", "?"],
  };
  for (const size of [
    { cols: 80, rows: 24 },
    { cols: 140, rows: 40 },
  ])
    for (const glyphs of ["rich", "plain"])
      for (const [name, list] of Object.entries(screens)) {
        const rows = drawn(size, list, { glyphs });
        const label = `${size.cols}x${size.rows} ${glyphs} ${name}`;
        assert.ok(
          rows.length <= size.rows - 1,
          `${label}: ${rows.length} rows`,
        );
        for (const row of rows)
          assert.ok(width(row) <= size.cols, `${label}: too wide:\n${row}`);
        // The rule's join and the sidebar's border are in one column (a
        // dialog covers them in the middle).
        const side = size.cols >= 130 ? 46 : 26;
        const [bar, join] =
          glyphs === "rich" ? ["\u2502", "\u252c"] : ["|", "+"];
        assert.equal([...rows[1]][side - 1], join, `${label}: the rule`);
        const dialog = ["approve", "trust", "help"].includes(name);
        const body = rows.slice(2, -1);
        const missing = body.filter((row) => [...row][side - 1] !== bar);
        if (!dialog)
          assert.deepEqual(missing, [], `${label}: border\n${rows.join("\n")}`);
      }
  // Wide: Parley's wordmark heads the sidebar.
  const wide = drawn({ cols: 140, rows: 40 }).join("\n");
  assert.ok(wide.includes("/_/   /_/  |_/_/ |_/_____/_____/   /_/"), wide);
  assert.ok(wide.includes("Keep each other's agents in the loop."));
  // Too small says so.
  const small = drawn({ cols: 50, rows: 14 }).join("\n");
  assert.ok(small.includes("A little more room."), small);
});

test("a resize lays the view out again", async (t) => {
  const v = open(t);
  v.view.dispatch({ type: "resize", cols: 140, rows: 40 });
  assert.deepEqual(v.state().size, { cols: 140, rows: 40 });
  v.view.dispatch({ type: "resize", cols: 100, rows: 30 });
  await tick();
  has(v.frame(), "Conversation");
});

test("without colours the view keeps its layout and selection, and paints nothing", (t) => {
  const plain = makeTheme({ color: false });
  assert.deepEqual(plain.props("brand bold"), { bold: true });
  assert.deepEqual(plain.props("selected bold"), { inverse: true, bold: true });
  assert.equal(plain.tone("divider"), undefined);
  const color = makeTheme({ color: true });
  assert.equal(color.props("brand").color, "#79b8ff");
  assert.equal(color.props("text").color, undefined);
  const state = reduce(
    initialState({
      data: fixture(),
      size: { cols: 80, rows: 24 },
      color: false,
      now: NOW,
    }),
    { type: "key", key: "x" },
  ).state;
  assert.equal(lastToast(state), null);
});
