import { authorOf } from "../authors.js";
import { clean, cleanLine } from "../inbound.js";
import { topicOf } from "../memory.js";
import { cutSpans, lineWidth, s, spread, wrapLine } from "./lines.js";
import { day, dayKey, fieldWindow, hhmm, wrap } from "./text.js";
import { glyphsOf } from "./theme.js";
import { people, personById } from "./state.js";
import { sectionRule } from "./controls.js";

// The conversation: everything sent and received, newest at the bottom,
// each entry with who wrote it (authors.js: "you", "your agent", "Jo",
// "Jo's agent"), who it was to and when; and under it the line that
// writes to the room as the person.
export const gutter = 6;

// Who an entry was to, as names: "you" for this person.
function recipients(entry, room, you) {
  if (!entry.to?.length) return [];
  return entry.to.map((id) =>
    id === you || (!entry.own && !room.members?.[id])
      ? "you"
      : cleanLine(room.members?.[id]?.name ?? "someone"),
  );
}

const kb = (n) => `${Math.max(1, Math.round((n ?? 0) / 1024))} KB`;

// One entry as lines of spans `width` wide: the time in a gutter, who and
// to whom, and what it said under it. Kinds the view does not show (a join,
// a presence) give no lines.
export function entryLines(
  entry,
  room,
  width,
  g,
  you = null,
  now = Date.now(),
) {
  const to = recipients(entry, room, you);
  const arrow = to.length ? [s(` ${g.sent} `, "muted"), s(to.join(", "))] : [];
  const who = s(authorOf(entry), entry.own ? "me bold" : "brand bold");
  const verb = (text) => s(` ${text}`, "muted");
  let title,
    body = "",
    tone = "";
  switch (entry.kind) {
    case "message":
      title = [who, ...arrow];
      body = clean(entry.text, 4000);
      break;
    case "note":
      title = [
        who,
        verb(entry.forgotten ? "forgot" : "remembered"),
        s(` "${cleanLine(topicOf(entry), 60)}"`, "bold"),
      ];
      body = entry.forgotten ? "" : clean(entry.text, 2000);
      break;
    case "diff": {
      const files = (entry.files ?? []).map((f) =>
        cleanLine(typeof f === "string" ? f : (f?.path ?? ""), 80),
      );
      title = [who, verb("shared a diff"), ...arrow];
      body = `${files.length} ${files.length === 1 ? "file" : "files"}${files.length ? `: ${files.slice(0, 6).join(", ")}${files.length > 6 ? ", ..." : ""}` : ""}${entry.note ? `\n${clean(entry.note, 300)}` : ""}`;
      tone = "muted";
      break;
    }
    case "file":
      title = [who, verb("sent a file"), ...arrow];
      body = `${cleanLine(entry.filename, 120)} (${kb(entry.size)})${entry.note ? `\n${clean(entry.note, 300)}` : ""}`;
      tone = "muted";
      break;
    case "claim": {
      const paths = (entry.paths ?? []).map((p) => cleanLine(p, 120));
      const running = entry.until > now;
      title = [who, verb(running ? "claimed" : "released"), ...arrow];
      body = running
        ? `${paths.join(", ")} until ${hhmm(entry.until)} UTC${entry.note ? `: ${clean(entry.note, 200)}` : ""}`
        : paths.join(", ");
      tone = "muted";
      break;
    }
    default:
      return [];
  }
  const head = wrapLine(
    [s(`${hhmm(entry.at)} `.padEnd(gutter), "muted"), ...title],
    width,
    gutter,
  );
  const room_ = Math.max(1, width - gutter);
  const pad = s(" ".repeat(gutter));
  const lines = body
    ? wrap(body, room_).map((line) => [pad, s(line, tone)])
    : [];
  return [...head, ...lines];
}

// Wrapping every entry again on each frame is the slow part of a long
// conversation: an entry's lines are kept while it, the width and the
// glyphs stay the same.
const cache = new Map();
function cachedLines(entry, room, width, g, you, now) {
  const running = entry.kind === "claim" ? entry.until > now : 0;
  const key = `${entry.id}|${width}|${g.sent}|${you}|${running}|${entry.to?.length ?? 0}`;
  let lines = cache.get(key);
  if (!lines) {
    if (cache.size > 4000) cache.clear();
    cache.set(key, (lines = entryLines(entry, room, width, g, you, now)));
  }
  return lines;
}

export function model(state, item, box) {
  const g = glyphsOf(state);
  const data = state.data;
  const width = box.room.width;
  const now = state.now;
  const body = [],
    ids = [];
  const days = new Set((data.log ?? []).map((e) => dayKey(e.at)));
  let last = null;
  for (const entry of data.log ?? []) {
    const lines = cachedLines(entry, data.room, width, g, data.you?.id, now);
    if (!lines.length) continue;
    const today = dayKey(entry.at);
    if (days.size > 1 && today !== last) {
      if (body.length) body.push([]);
      body.push(sectionRule(day(entry.at), width, g));
    }
    last = today;
    body.push(...lines);
    ids.push(entry.id);
  }
  if (!body.length)
    body.push(
      ...wrapLine(
        [
          s(
            "Nothing yet. Write below to the room yourself; your agents talk here once `parley` sessions run.",
            "muted",
          ),
        ],
        width,
      ),
    );
  return {
    title: [s("Conversation", "bold")],
    sub: [s("Messages, notes, files and claims, newest last", "muted")],
    body,
    live: true,
    ids,
    compose: true,
  };
}

// Who the line writes to: the member chosen, or the one an "@name " in
// front of the text names.
export function recipient(state) {
  const typed = /^@(\S+)\s/.exec(state.draft.value);
  if (typed) {
    const wanted = typed[1].toLowerCase();
    const p = people(state.data).find(
      (x) => x.status === "approved" && x.name.toLowerCase() === wanted,
    );
    return p ? { person: p, typed: true } : { name: typed[1], typed: true };
  }
  const p = state.to ? personById(state.data, state.to) : null;
  return p && p.status === "approved" ? { person: p } : null;
}

// The writing line in its box: the recipient in the top edge (a click
// chooses another), the text, and a hint in the bottom edge. The box is in
// the person's own colour while it has the keys.
export function composeLines(state, width) {
  const g = glyphsOf(state);
  const focused = state.focus === "compose" && !state.modal;
  const style = focused ? "me" : "divider";
  const to = recipient(state);
  const label = to?.person
    ? `To ${cleanLine(to.person.name)}`
    : to?.name
      ? `To @${cleanLine(to.name, 30)}`
      : "To everyone";
  const chip = [
    s(label, focused ? "me bold" : "bold"),
    s(` ${g.open}`, "muted"),
  ];
  const top = [s(`${g.tl}${g.h} `, style), ...chip, s(" ", style)];
  const hint = focused
    ? [s(" @name for one person ", "muted")]
    : [s(` ${g.enter} to write `, "muted")];
  const topLine = [
    ...top,
    s(g.h.repeat(Math.max(0, width - lineWidth(top) - 1)), style),
    s(g.tr, style),
  ];
  const room = Math.max(4, width - 6);
  const value = state.draft.value;
  const field = value
    ? focused
      ? (() => {
          const f = fieldWindow(value, state.draft.cursor, room);
          return [s(f.before), s(f.at, "inverse"), s(f.after)];
        })()
      : cutSpans([s(value.replace(/\n/g, ` ${g.dot} `))], room)
    : [
        ...(focused ? [s(" ", "inverse")] : []),
        s(
          `Write to ${to?.person ? cleanLine(to.person.name) : "the room"} as yourself`,
          "muted",
        ),
      ];
  const middle = spread(
    [
      s(`${g.v} `, style),
      s(`${g.arrow} `, focused ? "me bold" : "muted"),
      ...field,
    ],
    [s(` ${g.v}`, style)],
    width,
  );
  const bottom = [
    s(`${g.bl}`, style),
    s(g.h.repeat(Math.max(0, width - 2 - lineWidth(hint) - 1)), style),
    ...hint,
    s(g.h, style),
    s(g.br, style),
  ];
  return {
    lines: [topLine, middle, bottom],
    targets: [
      { x: 0, y: 0, width: lineWidth(top), chooseTo: true },
      { x: 0, y: 1, width, compose: true },
    ],
  };
}
