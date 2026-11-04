import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { startRelay } from "../src/relay/server.js";
import { createIdentity, loadRoom, readLog } from "../src/rooms.js";
import { createRoom, joinRoom, readInvite } from "../src/ops.js";
import { readConfig } from "../src/config.js";
import { runView } from "../src/view.js";
import { cloneOf, repo, tempHome, until } from "./helpers.js";

// `parley view` in a terminal of its own, on a real room and relay: Jo
// opens the room, Sam joins, and Jo, in the view, lets Sam in, writes to
// the room and narrows autonomy, with keys and clicks. The terminal is a
// stand-in that keeps what was written; the screen is read from it.
class Terminal extends EventEmitter {
  constructor(columns = 100, rows = 30) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = true;
    this.written = "";
  }
  write(data, encoding, done) {
    this.written += String(data);
    (typeof encoding === "function" ? encoding : done)?.();
    return true;
  }
  // The text written so far, without escape sequences.
  text() {
    return this.written.replace(
      /\x1b\[[0-9;?<>]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g,
      "",
    );
  }
}
class Keys extends PassThrough {
  isTTY = true;
  setRawMode() {
    return this;
  }
}

function person(t, name, from = null) {
  const { home, paths } = tempHome(t, name);
  const identity = createIdentity(paths, name);
  const dir = join(home, "project");
  const project = realpathSync.native(
    from ? cloneOf(from.project, dir) : repo(dir),
  );
  return { name, paths, identity, project };
}

test(
  "the view lets someone in, writes to the room and changes a setting, by keys and by mouse",
  { timeout: 30_000 },
  async (t) => {
    const relay = await startRelay({ port: 0, data: ":memory:" });
    t.after(() => relay.close());
    const jo = person(t, "Jo");
    const sam = person(t, "Sam", jo);
    const { room, invite } = await createRoom({
      paths: jo.paths,
      identity: jo.identity,
      root: jo.project,
      relay: `ws://127.0.0.1:${relay.port}`,
      name: "shop",
    });
    await joinRoom({
      paths: sam.paths,
      identity: sam.identity,
      root: sam.project,
      invite: readInvite(invite, sam.identity),
    });
    const input = new Keys();
    const output = new Terminal();
    const done = runView({
      paths: jo.paths,
      identity: jo.identity,
      room: loadRoom(jo.paths, room.roomId),
      env: { PARLEY_GLYPHS: "plain" },
      input,
      output,
      // Whole frames, so the screen reads from what was written.
      ink: { incrementalRendering: false },
    });
    // Whatever happens below, the view ends: its timer and connection would
    // keep the test process alive.
    t.after(async () => {
      input.write("\x03");
      await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
    });
    const shows = (text) =>
      until(() => output.text().includes(text), { timeoutMs: 10_000 }).catch(
        () => {
          throw new Error(`missing ${text}:\n${output.text().slice(-3000)}`);
        },
      );
    const press = async (...keys) => {
      for (const key of keys) {
        input.write(key);
        await new Promise((r) => setTimeout(r, key === "\x1b" ? 120 : 40));
      }
    };
    // The alternate screen, the mouse on.
    await shows("Conversation");
    assert.ok(output.written.includes("\x1b[?1049h"));
    assert.ok(output.written.includes("\x1b[?1000h\x1b[?1006h"));
    // The view's own connection brings Sam's knock.
    await shows("~ 1 waiting");
    // To Sam, then approve: compare the fingerprint, type the name.
    await press("\x1b", "\x1b[B", "\x1b[B", "a");
    await shows("Is this Sam's fingerprint?");
    await press("y");
    await shows("Type Sam to confirm");
    await press(..."Sam", "\r");
    await until(
      () =>
        Object.values(loadRoom(jo.paths, room.roomId).members).find(
          (m) => m.name === "Sam",
        )?.status === "approved",
      { timeoutMs: 10_000 },
    );
    await shows("Sam is in.");
    // Back to the conversation (Tab), and a message as Jo, not Jo's agent.
    await press("\t", "\t", "\t", "\t");
    await press(..."pull before you touch the cart", "\r");
    await until(
      () =>
        readLog(jo.paths, room.roomId).some(
          (e) => e.own && e.human && /pull before/.test(e.text),
        ),
      { timeoutMs: 10_000 },
    );
    await shows("Sent to the room.");
    // The mouse: a click on the sidebar's Room row (at 100 x 30 the tree
    // starts on the fourth row), then on the Autonomy setting in the pane.
    const click = (x, y) =>
      press(`\x1b[<0;${x + 1};${y + 1}M`, `\x1b[<0;${x + 1};${y + 1}m`);
    await click(5, 12);
    await shows("Approvals");
    await click(40, 14);
    await until(() => readConfig(jo.paths).autonomy === "read", {
      timeoutMs: 5000,
    });
    await shows("Autonomy is read");
    // A bigger window: the view lays itself out again, with the wordmark.
    output.columns = 140;
    output.rows = 40;
    output.emit("resize");
    await shows("Keep each other's agents in the loop.");
    // Ctrl+C: the view ends and gives the terminal back.
    await press("\x03");
    assert.equal(await done, 0);
    assert.ok(output.written.includes("\x1b[?1000l"));
    assert.ok(output.written.includes("\x1b[?7h"));
  },
);
