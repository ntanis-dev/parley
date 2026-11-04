import { cleanLine } from "../inbound.js";
import { fitLine, lineWidth, restyle, s, wrapLine } from "./lines.js";
import { width } from "./text.js";
import { glyphsOf } from "./theme.js";
import { people, topics } from "./state.js";

// The sidebar: one tree of everything there is to look at. The
// conversation; the members, each beneath (working, idle, offline, waiting
// to be let in, blocked); the shared memory with its topics beneath; the
// claims; the room. Members and Memory open and close. A row is { id, kind,
// depth, icon, name, nameStyle, tail (the short state, dropped first when
// room is short unless keepTail), parent, node, open, selectable }.
const gap = (id) => ({
  id,
  kind: "gap",
  depth: 0,
  name: "",
  tail: [],
  selectable: false,
});

// A member's mark and word.
export function presence(p, g) {
  switch (p.state) {
    case "working":
      return {
        icon: s(g.spinner[0], "brand spin"),
        word: "working",
        tone: "brand",
      };
    case "idle":
      return { icon: s(g.live, "ok"), word: "idle", tone: "ok" };
    case "offline":
      return { icon: s(g.off, "muted"), word: "offline", tone: "muted" };
    case "pending":
      return {
        icon: s(g.wait, "warn bold"),
        word: p.via === "key change" ? "new keys" : "waiting",
        tone: "warn",
      };
    default:
      return { icon: s(g.cross, "err"), word: "blocked", tone: "muted" };
  }
}

// Others' entries in the conversation after the last one seen.
export function unseen(state) {
  const log = state.data.log ?? [];
  const at = log.findIndex((e) => e.id === state.seen);
  if (at < 0 && state.seen !== null) return 0;
  return log.slice(at + 1).filter((e) => !e.own).length;
}

export function treeRows(state) {
  const g = glyphsOf(state);
  const data = state.data;
  const fresh = state.selected === "conv" ? 0 : unseen(state);
  const rows = [
    {
      id: "conv",
      kind: "conv",
      depth: 0,
      icon: s(" "),
      name: "Conversation",
      nameStyle: "bold",
      tail: fresh ? [s(`${fresh} new`, "brand bold")] : [],
      keepTail: true,
      selectable: true,
    },
    gap("gap:members"),
  ];
  const everyone = people(data);
  const approved = everyone.filter((p) => p.status === "approved");
  const online = approved.filter((p) => p.state !== "offline").length;
  const waiting = everyone.filter((p) => p.status === "pending").length;
  rows.push({
    id: "members",
    kind: "members",
    depth: 0,
    icon: s(state.open.members ? g.open : g.closed, "muted"),
    name: "Members",
    nameStyle: "bold",
    tail: [
      s(`${online}/${approved.length}`, online ? "ok" : "muted"),
      ...(waiting ? [s(` ${g.wait}${waiting}`, "warn bold")] : []),
    ],
    keepTail: true,
    node: true,
    open: state.open.members,
    selectable: true,
  });
  if (state.open.members) {
    for (const p of everyone) {
      const look = presence(p, g);
      rows.push({
        id: `member:${p.id}`,
        kind: "member",
        depth: 1,
        icon: look.icon,
        name: cleanLine(p.name),
        nameStyle: p.status === "blocked" ? "muted" : "",
        tail: [s(look.word, look.tone)],
        parent: "members",
        selectable: true,
        person: p,
      });
    }
    if (!everyone.length)
      rows.push({
        ...gap("none:members"),
        kind: "none",
        depth: 1,
        name: "nobody yet",
        nameStyle: "muted",
      });
  }
  rows.push(gap("gap:memory"));
  const notes = topics(data);
  rows.push({
    id: "memory",
    kind: "memory",
    depth: 0,
    icon: s(state.open.memory ? g.open : g.closed, "muted"),
    name: "Memory",
    nameStyle: "bold",
    tail: [s(String(notes.length), "muted")],
    keepTail: true,
    node: true,
    open: state.open.memory,
    selectable: true,
  });
  if (state.open.memory) {
    for (const t of notes)
      rows.push({
        id: t.id,
        kind: "note",
        depth: 1,
        icon: null,
        name: cleanLine(t.topic),
        nameStyle: "",
        tail: [],
        parent: "memory",
        selectable: true,
        note: t.note,
      });
    if (!notes.length)
      rows.push({
        ...gap("none:memory"),
        kind: "none",
        depth: 1,
        name: "empty",
        nameStyle: "muted",
      });
  }
  rows.push(gap("gap:claims"));
  const claims = data.claims ?? [];
  rows.push(
    {
      id: "claims",
      kind: "claims",
      depth: 0,
      icon: s(" "),
      name: "Claims",
      nameStyle: "bold",
      tail: [s(String(claims.length), claims.length ? "brand" : "muted")],
      keepTail: true,
      selectable: true,
    },
    {
      id: "room",
      kind: "room",
      depth: 0,
      icon: s(" "),
      name: "Room",
      nameStyle: "bold",
      tail: [
        ...(data.notices?.length ? [s(`${g.warn} `, "warn bold")] : []),
        s(data.autonomy ?? "work", "muted"),
      ],
      keepTail: true,
      selectable: true,
    },
  );
  return rows;
}

// The cells a row needs: the selection marker, the indent, the icon, the
// name and, after two spaces, the short state; one more to the right edge.
const marker = 2;
const prefixWidth = (row) => marker + row.depth * 2 + (row.icon ? 2 : 0);
const rowWidth = (row) =>
  prefixWidth(row) +
  width(row.name) +
  (row.tail.length ? 2 + lineWidth(row.tail) : 0) +
  1;

// A row as lines `cells` wide. The name is never cut: the short state goes
// first, then the name wraps under itself; a count stays on the first line
// and the name wraps around it. The selected row is highlighted when the
// sidebar has the keys, else marked with the arrow.
export function rowLines(row, cells, { selected = false, focused = false, g }) {
  if (row.kind === "gap") return [[]];
  const indent = " ".repeat(row.depth * 2);
  const mark = selected
    ? [s(`${g.arrow} `, focused ? "" : "brand bold")]
    : [s("  ")];
  const icon = row.icon ? [row.icon, s(" ")] : [];
  const nameStyle =
    selected && !focused ? `${row.nameStyle ?? ""} bold`.trim() : row.nameStyle;
  const name = [s(row.name, nameStyle)];
  const head = [...mark, s(indent), ...icon];
  let lines;
  if (rowWidth(row) <= cells)
    lines = [
      [
        ...head,
        ...name,
        s(" ".repeat(cells - rowWidth(row) + (row.tail.length ? 2 : 0))),
        ...row.tail,
        s(" "),
      ],
    ];
  else if (row.keepTail && row.tail.length) {
    const lead = prefixWidth(row);
    const tail = lineWidth(row.tail);
    lines = wrapLine(name, Math.max(1, cells - 1 - lead - 2 - tail)).map(
      (line, i) =>
        i
          ? [s(" ".repeat(lead)), ...line]
          : [
              ...head,
              ...line,
              s(
                " ".repeat(
                  Math.max(2, cells - 1 - lead - lineWidth(line) - tail),
                ),
              ),
              ...row.tail,
              s(" "),
            ],
    );
  } else {
    const lead = prefixWidth(row);
    lines = wrapLine(name, Math.max(1, cells - 1 - lead)).map((line, i) =>
      i ? [s(" ".repeat(lead)), ...line] : [...head, ...line],
    );
  }
  if (selected && focused)
    return lines.map((line) =>
      fitLine(restyle(line, "selected bold"), cells, "selected bold"),
    );
  return lines.map((line) => fitLine(line, cells));
}

export const selectable = (rows) => rows.filter((r) => r.selectable);
export function selectedRow(state, rows = treeRows(state)) {
  return rows.find((r) => r.id === state.selected && r.selectable) ?? null;
}

// After the data changes: the selection stays on its item while it is
// there; when it went away (a member who left, a topic forgotten), the row
// now at its place takes it, or its parent.
export function reselect(state) {
  const rows = selectable(treeRows(state));
  const at = rows.findIndex((r) => r.id === state.selected);
  if (at >= 0) return at === state.index ? state : { ...state, index: at };
  const parent = state.selected.startsWith("member:")
    ? "members"
    : state.selected.startsWith("note:")
      ? "memory"
      : "conv";
  const near = rows[Math.min(state.index, rows.length - 1)];
  const id = near && near.parent === parent ? near.id : (parent ?? rows[0]?.id);
  return select(state, id);
}

// Moves the selection: n rows, or to the first or last.
export function moveSelection(state, step) {
  const rows = selectable(treeRows(state));
  if (!rows.length) return state;
  const at = Math.max(
    0,
    rows.findIndex((r) => r.id === state.selected),
  );
  const index =
    step === "first"
      ? 0
      : step === "last"
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, at + step));
  if (rows[index].id === state.selected && index === state.index) return state;
  return { ...state, selected: rows[index].id, index };
}
export function select(state, id) {
  const index = selectable(treeRows({ ...state, selected: id })).findIndex(
    (r) => r.id === id,
  );
  return { ...state, selected: id, index: Math.max(0, index) };
}

// The sidebar's lines and which row each belongs to, and where the
// selection is among them (for the window that keeps it in view).
export function sideLines(
  state,
  cells,
  { focused, g, rows = treeRows(state) },
) {
  const lines = [],
    owners = [];
  let from = 0,
    to = 0;
  for (const row of rows) {
    const selected = row.selectable && row.id === state.selected;
    const own = rowLines(row, cells, { selected, focused, g });
    if (selected) {
      from = lines.length;
      to = from + own.length;
    }
    lines.push(...own);
    owners.push(...own.map(() => (row.selectable ? row.id : null)));
  }
  return { lines, owners, from, to };
}
// The first line of the window: the selection in view, with a little of
// what is around it.
export function sideTop(count, from, to, height) {
  if (count <= height) return 0;
  const room = Math.max(0, height - (to - from));
  const top = from - Math.floor(room / 2);
  return Math.max(0, Math.min(top, count - height));
}
