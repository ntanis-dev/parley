import { cutSpans, fitLine, lineWidth, s, spread } from "./lines.js";
import {
  bodyHeight,
  bodyTop,
  composeRows,
  frameCols,
  legendRows,
  padX,
  paneHeaderRows,
  roomy,
  sideWidth,
} from "./layout.js";
import { glyphsOf } from "./theme.js";
import * as conversation from "./conversation.js";
import * as members from "./members.js";
import * as memory from "./memory.js";
import * as room from "./room.js";

// The pane shows what the sidebar has selected. currentItem() says what
// that is; paneModel() builds it: { title, right, sub, body (the lines that
// scroll), controls (what the arrows mark and Enter presses, each { line,
// size, action }), live (it follows its newest line), ids (its entries, for
// "n new"), compose (it has the writing line), viewKey }.
export function currentItem(state) {
  const id = state.selected;
  if (id.startsWith("member:"))
    return { kind: "member", id, key: id, memberId: id.slice(7) };
  if (id.startsWith("note:")) return { kind: "note", id, key: id };
  if (["members", "memory", "claims", "room"].includes(id))
    return { kind: id, id, key: id };
  return { kind: "conv", id: "conv", key: "conv" };
}

const models = {
  conv: conversation.model,
  members: members.listModel,
  member: members.memberModel,
  memory: memory.listModel,
  note: memory.noteModel,
  claims: memory.claimsModel,
  room: room.model,
};

// The pane's box beside the sidebar, and the room inside it for the body.
export function paneBox(state) {
  const width = Math.max(10, frameCols(state) - sideWidth(state));
  const height = bodyHeight(state);
  const pad = padX(state);
  return {
    x: sideWidth(state),
    y: bodyTop,
    width,
    height,
    pad,
    room: {
      width: Math.max(10, width - pad * 2),
      height: Math.max(1, height - paneHeaderRows(state) - legendRows),
    },
  };
}

export function paneModel(
  state,
  item = currentItem(state),
  box = paneBox(state),
) {
  const model = {
    title: [],
    right: [],
    sub: [],
    body: [],
    controls: [],
    live: false,
    ids: [],
    compose: false,
    ...models[item.kind](state, item, box),
  };
  model.viewKey ??= item.key;
  const width = box.room.width;
  model.body = model.body.map((line) =>
    lineWidth(line) > width
      ? Object.assign(fitLine(line, width), { targets: line.targets })
      : line,
  );
  return model;
}

// The rows the body has: the room less the writing line's box.
export const bodyRoom = (model, box) =>
  Math.max(1, box.room.height - (model.compose ? composeRows : 0));

export const scrollOf = (state, model) =>
  state.views[model.viewKey] ?? {
    top: 0,
    follow: model.live,
    seen: model.ids.at(-1) ?? null,
  };

// The lines in view, and what the edges say: whether it follows, how many
// entries came since it was scrolled up, how much is above and below.
export function paneWindow(state, model, box) {
  const room = bodyRoom(model, box);
  const view = scrollOf(state, model);
  const max = Math.max(0, model.body.length - room);
  const follow = Boolean(model.live && view.follow);
  const top = follow ? max : Math.max(0, Math.min(view.top, max));
  let fresh = 0;
  if (model.live && !follow) {
    const at = model.ids.indexOf(view.seen);
    fresh = at >= 0 ? model.ids.length - at - 1 : 0;
  }
  // A conversation shorter than the pane sits at its bottom, by the
  // writing line, as a chat does.
  const pad = model.live ? Math.max(0, room - model.body.length) : 0;
  return {
    room,
    top,
    max,
    follow,
    fresh,
    pad,
    lines: [
      ...Array.from({ length: pad }, () => []),
      ...model.body.slice(top, top + room - pad),
    ],
    total: model.body.length,
  };
}

// Up and down a line, PgUp and PgDn a page, Home the top, End the bottom
// (a live pane follows again there). Scrolled up, a live pane holds its
// place while new entries arrive below.
const steps = { up: -1, down: 1 };
export function scrollPane(state, key, model, box) {
  const w = paneWindow(state, model, box);
  let top = null;
  if (typeof key === "number") top = w.top + key;
  else if (key in steps) top = w.top + steps[key];
  else if (key === "pageup") top = w.top - Math.max(1, w.room - 1);
  else if (key === "pagedown") top = w.top + Math.max(1, w.room - 1);
  else if (key === "home") top = 0;
  else if (key === "end") top = w.max;
  if (top === null) return null;
  top = Math.max(0, Math.min(w.max, top));
  const before = scrollOf(state, model);
  const follow = Boolean(model.live && top >= w.max);
  const seen = follow
    ? (model.ids.at(-1) ?? null)
    : before.follow
      ? (model.ids.at(-1) ?? null)
      : before.seen;
  return {
    ...state,
    views: { ...state.views, [model.viewKey]: { top, follow, seen } },
  };
}

// Scrolls so the lines from `line` (and `size` of them) are in view.
export function reveal(state, model, box, line, size = 1) {
  const w = paneWindow(state, model, box);
  const top =
    line < w.top
      ? line
      : line + size > w.top + w.room
        ? line + size - w.room
        : w.top;
  if (top === w.top) return state;
  return {
    ...state,
    views: {
      ...state.views,
      [model.viewKey]: { ...scrollOf(state, model), top, follow: false },
    },
  };
}

// Everything the pane draws, and where: its header (title and state on one
// line, a line under it), the body in view, the writing line, and the
// bottom line (how far it is scrolled). Clicks are tested against the same.
export function paneLayout(state) {
  const g = glyphsOf(state);
  const box = paneBox(state);
  const item = currentItem(state);
  const model = paneModel(state, item, box);
  const w = paneWindow(state, model, box);
  const width = box.room.width;
  const status = model.live
    ? w.follow
      ? [s(`${g.live} Live`, "ok")]
      : w.fresh
        ? [s(`${g.down} ${w.fresh} new`, "warn bold")]
        : [s("Paused", "muted")]
    : [];
  const right = [
    ...model.right,
    ...(model.right.length && status.length ? [s("  ")] : []),
    ...status,
  ];
  const head = [
    ...(roomy(state) ? [[]] : []),
    spread(model.title, right, width),
    fitLine(cutSpans(model.sub, width), width),
    [],
  ];
  const marks = w.max
    ? [
        s(
          `${w.top + 1}${g.dash}${Math.min(w.total, w.top + w.room)} of ${w.total}`,
          "muted",
        ),
      ]
    : [];
  const legend = spread(
    model.live && !w.follow
      ? [s(`End ${g.down} `, "brand bold"), s("newest", "muted")]
      : [],
    marks,
    width,
  );
  const compose = model.compose
    ? conversation.composeLines(state, width)
    : null;
  // Rows from the pane's top.
  const bodyY = head.length;
  const composeY = bodyY + w.room;
  const legendY = composeY + (compose ? composeRows : 0);
  return {
    box,
    item,
    model,
    window: w,
    head,
    legend,
    compose,
    bodyY,
    composeY,
    legendY,
    x: box.x + box.pad,
    width,
    newest: model.live && !w.follow,
  };
}
