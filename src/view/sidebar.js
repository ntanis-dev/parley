import { logo, slogan } from "../ui.js";
import { s } from "./lines.js";
import {
  bodyHeight,
  bodyTop,
  roomy,
  showWordmark,
  sideWidth,
} from "./layout.js";
import { glyphsOf } from "./theme.js";
import { sideLines, sideTop, treeRows } from "./tree.js";

// The sidebar as it is drawn: Parley's wordmark on top in a big window,
// then the tree in a window that keeps the selection in view, and a line
// that says there is more above or below. Clicks are tested against the
// same lines.
export function sideLayout(state) {
  const g = glyphsOf(state);
  const width = sideWidth(state);
  const cells = width - 3;
  const height = bodyHeight(state);
  const brand = showWordmark(state)
    ? [
        [],
        ...logo.map((line) => [s(` ${line}`, "brand bold")]),
        [],
        [s(` ${slogan}`, "muted")],
        [],
      ]
    : roomy(state)
      ? [[]]
      : [];
  const rows = treeRows(state);
  const view = sideLines(state, cells, {
    focused: state.focus === "side" && !state.modal,
    g,
    rows,
  });
  let room = Math.max(1, height - brand.length);
  const overflow = view.lines.length > room;
  if (overflow) room = Math.max(1, room - 1);
  const top = sideTop(view.lines.length, view.from, view.to, room);
  const more = overflow
    ? [
        [
          ...(top ? [s(` ${g.up} more above`, "muted")] : []),
          ...(top + room < view.lines.length
            ? [s(`${top ? "  " : " "}${g.down} more below`, "muted")]
            : []),
        ],
      ]
    : [];
  return {
    width,
    cells,
    height,
    brand,
    lines: view.lines.slice(top, top + room),
    owners: view.owners.slice(top, top + room),
    rows,
    room,
    more,
    // Where the tree's first line is on the screen, and its first cell.
    y: bodyTop + brand.length,
    x: 1,
  };
}
