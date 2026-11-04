import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.js";
import { printer } from "../src/ui.js";
import { createIdentity } from "../src/rooms.js";
import { tempHome } from "./helpers.js";

// Commands that need the person (say, view, approve, join, ...) refuse to run
// for an agent: no terminal, or Claude Code's mark on the command.
const ioFor = (env, tty = true) => {
  const out = [];
  const stream = { isTTY: tty, write: (t) => out.push(t) };
  return {
    out,
    io: {
      stdin: { isTTY: tty },
      stdout: stream,
      env,
      ui: printer(stream, {}),
      errUi: printer(stream, {}),
      out: (line) => out.push(`${line}\n`),
      err: (line) => out.push(`${line}\n`),
    },
  };
};

for (const [why, env, tty] of [
  ["no terminal", {}, false],
  ["a terminal made up inside Claude Code", { CLAUDECODE: "1" }, true],
])
  test(`parley say refuses to write as the person from ${why}`, async (t) => {
    const { home, paths } = tempHome(t, "Pat");
    createIdentity(paths, "Pat");
    const { io } = ioFor({ ...env, PARLEY_HOME: home }, tty);
    await assert.rejects(
      main(["say", "hello"], {
        env: { ...env, PARLEY_HOME: home },
        cwd: home,
        io,
      }),
      /needs a person at a terminal/,
    );
  });
