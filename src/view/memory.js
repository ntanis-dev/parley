import { authorOf } from "../authors.js";
import { clean, cleanLine } from "../inbound.js";
import {
  cutSpans,
  fitLine,
  restyle,
  s,
  spread,
  wrapLine,
  withTargets,
} from "./lines.js";
import { hhmm, oneLine, plural, stamp, until, wrap } from "./text.js";
import { glyphsOf } from "./theme.js";
import { topics } from "./state.js";

// The room's shared memory (a note per topic, the newest first), one note
// in full, and the claims: who is working on what, until when.

const byline = (note) => `${authorOf(note)}, ${stamp(note.at)}`;

export function listModel(state, item, box) {
  const g = glyphsOf(state);
  const width = box.room.width;
  const notes = topics(state.data);
  const pick = state.picks.memory ?? 0;
  const focused = state.focus === "pane";
  const body = [],
    controls = [];
  notes.forEach((t, i) => {
    const on = focused && i === pick;
    const head = spread(
      [
        s(on ? `${g.arrow} ` : "  ", "brand bold"),
        s(cleanLine(t.topic), "bold"),
      ],
      [s(byline(t.note), "muted")],
      width,
    );
    // Two lines of the note; a longer one ends with an ellipsis.
    const room = Math.max(10, width - 4);
    const text = wrap(oneLine(clean(t.note.text, 2000)), room);
    const preview = text
      .slice(0, 2)
      .map((line, n) => [
        s("    "),
        ...(n === 1 && text.length > 2
          ? cutSpans([s(`${line} ${text[2]}`)], room)
          : [s(line)]),
      ]);
    const lines = [head, ...preview].map((line) =>
      on ? fitLine(restyle(line, "selected"), width, "selected") : line,
    );
    controls.push({
      line: body.length,
      size: lines.length,
      action: { do: "select", id: t.id },
    });
    const target = [{ x: 0, width, control: controls.length - 1 }];
    body.push(...lines.map((line) => withTargets(line, target)));
  });
  if (!notes.length)
    body.push(
      ...wrapLine(
        [
          s(
            'Nothing remembered yet. The agents add notes with remember ("we tag releases on Thursdays"), a newer one on a topic replacing the older.',
            "muted",
          ),
        ],
        width,
      ),
    );
  return {
    title: [s("Memory", "bold")],
    right: [s(plural(notes.length, "topic"), "muted")],
    sub: [s("What the room decided: the newest note per topic", "muted")],
    body,
    controls,
    viewKey: "memory",
  };
}

export function noteModel(state, item, box) {
  const width = box.room.width;
  const found = topics(state.data).find((t) => t.id === item.id);
  if (!found)
    return {
      title: [s("Memory", "bold")],
      sub: [s("That topic was forgotten.", "muted")],
      body: [],
    };
  const body = wrap(clean(found.note.text, 64 * 1024), width).map((line) => [
    s(line),
  ]);
  return {
    title: [s(cleanLine(found.topic), "bold")],
    sub: [s(`Remembered by ${byline(found.note)}`, "muted")],
    body,
    viewKey: item.key,
  };
}

export function claimsModel(state, item, box) {
  const g = glyphsOf(state);
  const width = box.room.width;
  const claims = [...(state.data.claims ?? [])].sort(
    (a, b) => a.until - b.until,
  );
  const body = [];
  for (const c of claims) {
    const who = c.own ? "you" : cleanLine(c.name);
    body.push(
      ...wrapLine(
        [
          s(`${g.bullet} `, c.own ? "me" : "brand"),
          s(who, c.own ? "me bold" : "bold"),
          s("  "),
          s(cleanLine(c.path, 200), "brand"),
        ],
        width,
        2,
      ),
      ...wrapLine(
        [
          s("  "),
          s(
            `until ${hhmm(c.until)} UTC (${until(c.until - state.now)})`,
            "muted",
          ),
          ...(c.note
            ? [s(` ${g.dot} `, "muted"), s(oneLine(clean(c.note, 300)))]
            : []),
        ],
        width,
        2,
      ),
    );
  }
  if (!claims.length)
    body.push(
      ...wrapLine(
        [
          s(
            "Nobody has claimed anything. An agent claims paths while it works on them; another member's agent about to edit one hears about it first.",
            "muted",
          ),
        ],
        width,
      ),
    );
  return {
    title: [s("Claims", "bold")],
    right: [s(`${claims.length} running`, claims.length ? "brand" : "muted")],
    sub: [s("Who is working on what, and until when", "muted")],
    body,
    viewKey: "claims",
  };
}
