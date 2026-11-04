import {
  bodyHeight,
  bodyTop,
  footerY,
  frameCols,
  sideWidth,
  tooSmall,
} from "./layout.js";
import { headerModel, footerModel } from "./chrome.js";
import { modalLayout, toastLayouts } from "./overlays.js";
import { paneLayout } from "./pane.js";
import { sideLayout } from "./sidebar.js";
import { treeRows } from "./tree.js";

// What a click or a turn of the wheel at (x, y) is on, computed from the
// same layouts the screen is drawn from: a dialog's button or option, a
// toast, a footer hint, a part of the header, a sidebar row (or its fold
// mark), a pane's control, the writing line. null when it is on nothing.
const at = (targets, x, y) =>
  targets.find((t) => t.y === y && x >= t.x && x < t.x + t.width);

export function hitTest(state, event) {
  const { x, y, kind, button } = event;
  if (
    tooSmall(state) ||
    x < 0 ||
    y < 0 ||
    x >= frameCols(state) ||
    y > footerY(state)
  )
    return null;
  if (kind !== "press" && kind !== "wheel") return null;
  if (state.modal) {
    const layout = modalLayout(state);
    if (kind === "wheel") return { modalScroll: event.delta };
    if (button !== 0) return null;
    const hit = at(layout.targets, x, y);
    if (hit) return hit;
    const inside =
      x >= layout.left &&
      x < layout.left + layout.width &&
      y >= layout.top &&
      y < layout.top + layout.lines.length;
    // A click outside a dialog closes it, as Esc does.
    return inside ? null : { command: "escape" };
  }
  if (kind === "press") {
    if (button !== 0) return null;
    const toast = toastLayouts(state).find(
      (t) =>
        x >= t.left &&
        x < t.left + t.width &&
        y >= t.top &&
        y < t.top + t.lines.length,
    );
    if (toast) return { toast: toast.id };
    if (y === footerY(state))
      return at(footerModel(state).targets, x, y) ?? null;
    if (y === 0) return at(headerModel(state).targets, x, y) ?? null;
  }
  if (y < bodyTop || y >= bodyTop + bodyHeight(state)) return null;
  const side = sideWidth(state);
  if (x < side) {
    if (kind === "wheel") return { sideScroll: event.delta > 0 ? 1 : -1 };
    const layout = sideLayout(state);
    const index = y - layout.y;
    if (index < 0 || index >= layout.lines.length || x >= side - 1) return null;
    const id = layout.owners[index];
    if (!id) return null;
    const row = treeRows(state).find((r) => r.id === id);
    // The fold mark opens and closes a node.
    const fold = row?.node && x >= 1 + 2 && x < 1 + 4;
    return { select: id, ...(fold ? { fold: true } : {}) };
  }
  const layout = paneLayout(state);
  if (kind === "wheel") return { paneScroll: event.delta };
  const px = x - layout.x;
  const py = y - bodyTop;
  if (px < 0 || px >= layout.width) return { focusPane: true };
  if (
    layout.compose &&
    py >= layout.composeY &&
    py < layout.composeY + layout.compose.lines.length
  ) {
    const hit = at(layout.compose.targets, px, py - layout.composeY);
    return hit?.chooseTo ? { chooseTo: true } : { compose: true };
  }
  if (py === layout.legendY && layout.newest && px < 12)
    return { command: "end" };
  if (py >= layout.bodyY && py < layout.bodyY + layout.window.room) {
    const line = layout.window.top + (py - layout.bodyY) - layout.window.pad;
    const hit = (layout.model.body[line]?.targets ?? []).find(
      (t) => px >= t.x && px < t.x + t.width,
    );
    if (hit?.control !== undefined) return { control: hit.control };
  }
  return { focusPane: true };
}
