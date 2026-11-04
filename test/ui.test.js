import { test } from "node:test";
import assert from "node:assert/strict";
import { glyphSets, logo, printer, wrapLine, s } from "../src/ui.js";

// What the commands print: one document per command, in Parley's look.

const stream = (tty, columns = 80) => {
  const out = [];
  return {
    out,
    text: () => out.join(""),
    isTTY: tty,
    columns,
    getColorDepth: () => 24,
    write: (t) => out.push(t),
  };
};
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("in a terminal: the mark, indented lines, blank lines around", () => {
  const out = stream(true);
  const ui = printer(out, { PARLEY_GLYPHS: "rich" });
  ui.ok('Opened room "shop"');
  ui.blank();
  ui.fact("Folder", "~/code/shop");
  ui.heading("Invite");
  ui.code("parley1:abc");
  ui.end();
  const g = glyphSets.rich;
  assert.equal(
    strip(out.text()),
    [
      "",
      `  ${g.mark} PARLEY`,
      "",
      `  ${g.check} Opened room "shop"`,
      "",
      "  Folder        ~/code/shop",
      "",
      `  INVITE  ${g.h.repeat(68)}`,
      "",
      "    parley1:abc",
      "",
      "",
    ].join("\n"),
  );
  // In colour: the brand's blue for the mark, green for the check.
  assert.match(out.text(), /\x1b\[38;2;121;184;255;1m/);
  assert.match(out.text(), /\x1b\[38;2;124;196;160;1m/);
});

test("help and setup open with the wordmark and the slogan", () => {
  const out = stream(true);
  const ui = printer(out, { PARLEY_GLYPHS: "plain", NO_COLOR: "1" });
  ui.full();
  ui.heading("Welcome");
  const text = out.text();
  for (const line of logo) assert.ok(text.includes(line.trimEnd()));
  assert.match(text, /Keep each other's agents in the loop\./);
  assert.doesNotMatch(text, /\x1b\[/);
});

test("in a pipe: the same lines, no mark, no colour; errors say parley:", () => {
  const out = stream(false);
  const ui = printer(out, { PARLEY_GLYPHS: "plain" });
  ui.ok('Joined "shop"');
  ui.danger("you are about to trust Jo", ["Jo's agent will send messages."]);
  ui.failure("The relay did not answer.");
  ui.end();
  assert.equal(
    out.text(),
    [
      '  + Joined "shop"',
      "",
      "  DANGER: you are about to trust Jo",
      "    Jo's agent will send messages.",
      "",
      "parley: The relay did not answer.",
      "",
    ].join("\n"),
  );
});

test("stdout and stderr make one document: one mark, one blank line under", () => {
  const shared = {};
  const out = stream(true);
  const err = stream(true);
  const env = { PARLEY_GLYPHS: "plain", NO_COLOR: "1" };
  const ui = printer(out, env, shared);
  const errUi = printer(err, env, shared);
  ui.ok("Synced");
  errUi.failure("The relay refused this room.", "parley help");
  errUi.end();
  ui.end();
  assert.equal(out.text(), "\n  <> PARLEY\n\n  + Synced\n");
  assert.equal(
    err.text(),
    "\n  x The relay refused this room.\n\n  Help    parley help\n\n",
  );
});

test("long lines wrap under their own text", () => {
  const lines = wrapLine(
    [s("Folder      ", "muted"), s("a b c d e f g h i j k l m n o p")],
    24,
    12,
  );
  assert.deepEqual(
    lines.map((l) => l.map(([t]) => t).join("")),
    [
      "Folder      a b c d e f",
      "            g h i j k l",
      "            m n o p",
    ],
  );
});
