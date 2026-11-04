import { cleanLine } from "../inbound.js";
import { fitLine, lineWidth, s } from "./lines.js";
import { footerY, frameCols, sideWidth } from "./layout.js";
import { glyphsOf } from "./theme.js";
import { people } from "./state.js";
import { currentItem, paneLayout } from "./pane.js";
import { selectedRow } from "./tree.js";
import { itemActions } from "./actions.js";
import { relayWord } from "./room.js";

// The frame around the panes: the header (the room, the connection, who is
// around and working, who waits to be let in, versions), its rule, and the
// footer of key hints. Both are clickable: a hint does what its key does, a
// part of the header goes where it is about.

export function headerModel(state) {
  const g = glyphsOf(state);
  const cols = frameCols(state);
  const data = state.data;
  const everyone = people(data);
  const approved = everyone.filter((p) => p.status === "approved");
  const online = approved.filter((p) => p.state !== "offline");
  const working = online.filter((p) => p.state === "working").length;
  const waiting = everyone.filter((p) => p.status === "pending");
  const [word, tone] = relayWord(data);
  const left = [
    s(` ${g.mark} `, "brand bold"),
    s("parley", "brand bold"),
    s("  "),
    s(cleanLine(data.room.name, 40), "bold"),
  ];
  // The parts, the most important first; the last ones give way when the
  // window is narrow.
  const parts = [
    { spans: [s(`${g.live} ${word}`, tone)], weight: 0, go: "room" },
    ...(waiting.length
      ? [
          {
            spans: [s(`${g.wait} ${waiting.length} waiting`, "warn bold")],
            weight: 1,
            go: `member:${waiting[0].id}`,
          },
        ]
      : []),
    ...(data.notices?.length
      ? [
          {
            spans: [s(`${g.warn} versions differ`, "warn")],
            weight: 2,
            go: "room",
          },
        ]
      : []),
    {
      spans: [
        s(
          `${online.length}/${approved.length} online`,
          online.length ? "ok" : "muted",
        ),
      ],
      weight: 2,
      go: "members",
    },
    ...(working
      ? [
          {
            spans: [s(`${working} working`, "brand")],
            weight: 3,
            go: "members",
          },
        ]
      : []),
  ];
  const sep = s(`  ${g.dot}  `, "muted");
  const build = (list) =>
    list.flatMap((p, i) => [...(i ? [sep] : []), ...p.spans]);
  let shown = parts;
  while (
    shown.length > 1 &&
    lineWidth(left) + 3 + lineWidth(build(shown)) + 1 > cols
  ) {
    const weight = Math.max(...shown.map((p) => p.weight));
    const index = shown.findLastIndex((p) => p.weight === weight);
    shown = shown.filter((_, i) => i !== index);
  }
  const right = build(shown);
  const gap = Math.max(1, cols - lineWidth(left) - lineWidth(right) - 1);
  const line = fitLine([...left, s(" ".repeat(gap)), ...right, s(" ")], cols);
  const targets = [];
  let x = lineWidth(left) + gap;
  shown.forEach((p, i) => {
    if (i) x += lineWidth([sep]);
    targets.push({ x, y: 0, width: lineWidth(p.spans), go: p.go });
    x += lineWidth(p.spans);
  });
  return { line, targets };
}

// The rule under the header, joined to the sidebar's border.
export function ruleLine(state) {
  const g = glyphsOf(state);
  const cols = frameCols(state);
  const side = sideWidth(state);
  return [
    s(g.h.repeat(side - 1), "divider"),
    s(g.join, "divider"),
    s(g.h.repeat(Math.max(0, cols - side)), "divider"),
  ];
}

export const keyLabel = (key, g) =>
  ({
    updown: `${g.up}${g.down}`,
    leftright: `${g.left}${g.right}`,
    left: g.left,
    right: g.right,
    enter: g.enter,
  })[key] ?? key;

// The hints for what has the keys: [key, label, weight]; the heaviest give
// way first when the window is narrow.
export function footerHints(state) {
  const kind = state.modal?.kind;
  if (kind === "confirm")
    return [
      ["y", state.modal.yesLabel ?? "Yes", 1],
      ["n", state.modal.noLabel ?? "No", 1],
      ["leftright", "Choose", 2],
      ["enter", "Select", 2],
      ["Esc", "Cancel", 1],
    ];
  if (kind === "typed")
    return [
      ["enter", "Confirm", 1],
      ["Ctrl+U", "Clear", 2],
      ["Esc", "Cancel", 1],
    ];
  if (kind === "actions" || kind === "choice")
    return [
      ["updown", "Choose", 1],
      ["enter", "Select", 1],
      ["Esc", "Close", 1],
    ];
  if (kind === "invite")
    return [
      ["c", "Copy", 1],
      ["Esc", "Close", 1],
    ];
  if (kind === "help")
    return [
      ["updown", "Scroll", 1],
      ["Esc", "Close", 1],
    ];
  const item = currentItem(state);
  if (state.focus === "compose")
    return [
      ["enter", "Send", 1],
      ["updown", "Scroll", 2],
      ["Ctrl+T", "To", 2],
      ["Tab", "Section", 3],
      ["Esc", state.draft.value ? "Clear" : "Back", 1],
    ];
  const layout = paneLayout(state);
  const controls = layout.model.controls.length > 0;
  if (state.focus === "pane")
    return [
      ["updown", controls ? "Choose" : "Scroll", 1],
      ...(controls
        ? [
            [
              "enter",
              item.kind === "members" || item.kind === "memory"
                ? "Open"
                : "Select",
              1,
            ],
          ]
        : []),
      ...(layout.window.max ? [["PgUp/Dn", "Scroll", 2]] : []),
      ...(item.kind === "member"
        ? itemActions(state, item).map((a) => [a.key, a.label.split(" ")[0], 2])
        : []),
      ["left", "Sidebar", 1],
      ["Tab", "Section", 3],
      ["?", "Help", 3],
      ["q", "Quit", 2],
    ];
  const row = selectedRow(state);
  const enter =
    item.kind === "conv"
      ? "Write"
      : item.kind === "member" || item.kind === "room"
        ? "Actions"
        : "Open";
  return [
    ["updown", "Navigate", 1],
    ["enter", enter, 1],
    ...(row?.node
      ? [["leftright", "Fold", 2]]
      : row?.parent
        ? [["left", "Parent", 3]]
        : []),
    ...(layout.window.max ? [["PgUp/Dn", "Scroll", 2]] : []),
    ["Tab", "Section", 2],
    ["?", "Help", 2],
    ["q", "Quit", 1],
  ];
}

// Each hint's command when clicked.
const commands = {
  updown: "down",
  leftright: "right",
  left: "left",
  right: "right",
  enter: "enter",
  Esc: "escape",
  "PgUp/Dn": "pagedown",
  "Ctrl+U": "ctrl+u",
  "Ctrl+T": "ctrl+t",
  Tab: "tab",
};

export function footerModel(state) {
  const g = glyphsOf(state);
  const cols = frameCols(state);
  const spans = (list) =>
    list.flatMap(([key, label], i) => [
      s(i ? "    " : "  "),
      s(keyLabel(key, g), "brand bold"),
      s(` ${label}`, "muted"),
    ]);
  let shown = footerHints(state);
  while (shown.length > 1 && lineWidth(spans(shown)) > cols) {
    const weight = Math.max(...shown.map((hint) => hint[2]));
    const index = shown.findLastIndex((hint) => hint[2] === weight);
    shown = shown.filter((_, i) => i !== index);
  }
  let x = 0;
  const targets = shown.map(([key, label], i) => {
    x += i ? 4 : 2;
    const start = x,
      size = lineWidth([s(`${keyLabel(key, g)} ${label}`)]);
    x += size;
    return {
      x: start,
      y: footerY(state),
      width: size,
      command: commands[key] ?? key,
    };
  });
  return { line: fitLine(spans(shown), cols), targets };
}
