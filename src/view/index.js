import { spawnSync } from "node:child_process";
import { createElement as h } from "react";
import { render } from "ink";
import { RoomConnection } from "../client.js";
import {
  keysOf,
  loadCursor,
  loadRoom,
  markWelcomed,
  receive,
  saveCursor,
} from "../rooms.js";
import { openPulse, recordPulse } from "../activity.js";
import { writeConfig } from "../config.js";
import { afterConnect, inviteFor, setMemberStatus } from "../ops.js";
import { pickGlyphs } from "../ui.js";
import { makeStore, sayAsPerson, snapshot } from "./data.js";
import { createView } from "./store.js";
import { TerminalInput } from "./input.js";
import { ViewApp } from "./app.js";

// `parley view`: the room, live, in the terminal. A sidebar of what there
// is to look at (the conversation, the members, the shared memory, claims,
// the room), the selection in the pane beside it, and in the conversation a
// line to write to the room as yourself (not your agent). Keys and the
// mouse both work; letting someone in, blocking, autonomy, approvals and
// the invite are the same functions the CLI's commands use. It holds its
// own connection to the room while open, so new messages and who is around
// show as they happen; it sends no pulses (it is not a session) and leaves
// your agents' inbox alone.

// The terminal's clipboard (OSC 52, which also works over SSH) and the
// system's own clipboard tool where there is one.
function copyText(text, output) {
  try {
    output.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  } catch {}
  const tools =
    process.platform === "win32"
      ? [["clip"]]
      : process.platform === "darwin"
        ? [["pbcopy"]]
        : [
            ["wl-copy"],
            ["xclip", "-selection", "clipboard"],
            ["xsel", "--clipboard", "--input"],
          ];
  for (const [command, ...args] of tools) {
    try {
      const run = spawnSync(command, args, {
        input: text,
        windowsHide: true,
        timeout: 3000,
      });
      if (run.status === 0) return "Copied the invite.";
    } catch {}
  }
  return "Asked the terminal to copy the invite; Show invite (i) has it too.";
}

const sizeOf = (output) => ({
  cols: output.columns || 100,
  rows: output.rows || 30,
});
// Line wrap off while the view runs (a cell in the last column never pushes
// the cursor on), and the mouse on: clicks and the wheel, as SGR reports.
const wrapOff = "\x1b[?7l";
const wrapOn = "\x1b[?7h";
const mouseOn = "\x1b[?1000h\x1b[?1006h";
const mouseOff = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
const signals = { SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 };

export async function runView({
  paths,
  identity,
  room,
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  ink = {},
}) {
  const { roomId, token } = keysOf(room);
  let conn = null;
  const store = makeStore(() => snapshot(paths, roomId, conn, identity));
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
      store.refresh();
    },
    onPulse: (blob) => {
      try {
        const fresh = loadRoom(paths, roomId);
        const got = fresh && openPulse(identity, fresh, blob);
        if (got) {
          markWelcomed(paths, roomId);
          recordPulse(paths, roomId, got);
        }
      } catch {}
      store.refresh();
    },
    onState: (state) => {
      if (state === "connected")
        afterConnect(paths, identity, roomId, conn).catch(() => {});
      store.refresh();
    },
  }).start();
  const current = () => loadRoom(paths, roomId);
  const after = (value) => {
    store.refresh();
    return value;
  };
  const actions = {
    say: async (text, to) =>
      after(
        await sayAsPerson({ paths, identity, room: current(), text, to, conn }),
      ),
    approve: async (id) =>
      after(
        await setMemberStatus({
          paths,
          identity,
          room: current(),
          id,
          status: "approved",
        }),
      ),
    block: async (id) =>
      after(
        await setMemberStatus({
          paths,
          identity,
          room: current(),
          id,
          status: "blocked",
        }),
      ),
    autonomy: async (value) =>
      after(writeConfig(paths, (c) => (c.autonomy = value))),
    approvals: async (on) =>
      after(writeConfig(paths, (c) => (c.approvals = on))),
    invite: async () => inviteFor(current(), identity),
    copy: async (text) =>
      copyText(text ?? inviteFor(current(), identity), output),
  };
  const tty = Boolean(output.isTTY);
  const mouse = env.PARLEY_MOUSE !== "off";
  let instance = null;
  const view = createView({
    data: store,
    actions,
    size: sizeOf(output),
    color: !env.NO_COLOR,
    glyphs: pickGlyphs(env),
    onQuit: () => instance?.unmount(),
    // Ctrl+L and a new size: forget what is on the screen, draw it all.
    onRedraw: () => {
      instance?.clear();
      instance?.rerender(h(ViewApp, { store, actions, view }));
    },
  });
  const keys = new TerminalInput(input, {
    onMouse: (event) => {
      if (mouse && tty) view.dispatch({ type: "mouse", ...event });
    },
  });
  const restore = () => {
    if (!tty) return;
    try {
      output.write(mouseOff + wrapOn);
    } catch {}
  };
  const resized = () => {
    const size = sizeOf(output);
    const { cols, rows } = view.getState().size;
    if (size.cols !== cols || size.rows !== rows)
      view.dispatch({ type: "resize", ...size });
  };
  const stops = Object.entries(signals).map(([signal, code]) => {
    const stop = () => {
      instance?.unmount();
      restore();
      process.exit(code);
    };
    process.on(signal, stop);
    return () => process.off(signal, stop);
  });
  process.on("exit", restore);
  if (tty) output.write(wrapOff);
  instance = render(h(ViewApp, { store, actions, view }), {
    stdout: output,
    stdin: keys,
    // The view runs for a person at a terminal (the CLI makes sure), so it
    // draws every frame even where CI is set, which Ink would read as "only
    // the last frame".
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
    alternateScreen: true,
    incrementalRendering: true,
    maxFps: 30,
    ...ink,
  });
  if (tty && mouse) output.write(mouseOn);
  output.on?.("resize", resized);
  // The data every second; the tick also notices a new size the resize
  // event missed, and lets old toasts go.
  const timer = setInterval(() => {
    resized();
    store.refresh();
    view.dispatch({ type: "tick" });
  }, 1000);
  try {
    await instance.waitUntilExit();
  } finally {
    clearInterval(timer);
    output.off?.("resize", resized);
    for (const off of stops) off();
    process.off("exit", restore);
    view.close();
    keys.close();
    restore();
    conn.stop();
  }
  return 0;
}

export { makeStore, sayAsPerson, snapshot } from "./data.js";
export { entryLines } from "./conversation.js";
export { ViewApp, Screen } from "./app.js";
export { createView } from "./store.js";
export { createReplyFilter } from "./input.js";
