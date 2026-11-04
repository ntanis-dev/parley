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

test("parley relay key prints a new, strong key alone on its line", async (t) => {
  const { home } = tempHome(t, "Pat");
  const keys = [];
  for (let i = 0; i < 2; i++) {
    const { out, io } = ioFor({ PARLEY_HOME: home }, false);
    const code = await main(["relay", "key"], {
      env: { PARLEY_HOME: home },
      cwd: home,
      io,
    });
    assert.equal(code, 0);
    assert.equal(out.length, 1);
    keys.push(out[0].trim());
  }
  for (const key of keys) assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(keys[0], keys[1]);
});

test("parley relay will not start with a weak relay key", async (t) => {
  const { home } = tempHome(t, "Pat");
  for (const key of ["letmein", "x".repeat(30)]) {
    const env = { PARLEY_HOME: home, PARLEY_RELAY_KEY: key };
    const { io } = ioFor(env, false);
    await assert.rejects(
      main(["relay", "--port", "0", "--data", ":memory:"], {
        env,
        cwd: home,
        io,
      }),
      /too weak/,
    );
  }
});
