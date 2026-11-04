import { fitLine, lineWidth, s, spread, wrapLine } from "./lines.js";
import { fieldWindow, width as cells, wrap } from "./text.js";
import { glyphsOf } from "./theme.js";
import { bodyHeight, bodyTop, frameCols } from "./layout.js";
import { buttons } from "./controls.js";
import { helpRows } from "./actions.js";
import { paneLayout } from "./pane.js";

// What floats over the panes: the dialogs and the toasts, each a box of
// lines padded to its width, with where its buttons and options are.

// A box's top or bottom edge with text in it.
export function edge(
  g,
  { width, left = [], right = [], top = true, style = "muted" },
) {
  const [a, b] = top ? [g.tl, g.tr] : [g.bl, g.br];
  const leftPart = left.length
    ? [s(`${g.h} `, style), ...left, s(" ", style)]
    : [];
  const rightPart = right.length
    ? [s(" ", style), ...right, s(` ${g.h}`, style)]
    : [];
  let room = width - 2 - lineWidth(rightPart) - lineWidth(leftPart);
  let shownLeft = leftPart;
  if (room < 1) {
    shownLeft = leftPart.length
      ? fitLine(leftPart, Math.max(0, width - 3 - lineWidth(rightPart)))
      : [];
    room = width - 2 - lineWidth(rightPart) - lineWidth(shownLeft);
  }
  return fitLine(
    [
      s(a, style),
      ...shownLeft,
      s(g.h.repeat(Math.max(0, room)), style),
      ...(room >= 0 ? rightPart : []),
      s(b, style),
    ],
    width,
  );
}

function boxLines(g, { width, lines, title = [], note = [], style }) {
  const room = width - 4;
  return [
    edge(g, { width, left: title, style }),
    ...lines.map((line) => [
      s(`${g.v} `, style),
      ...fitLine(line, room),
      s(` ${g.v}`, style),
    ]),
    edge(g, { width, right: note, top: false, style }),
  ];
}

// A dialog's text: strings are wrapped, span lines wrapped as spans.
const textLines = (list, inner) =>
  (list ?? []).flatMap((line) =>
    typeof line === "string"
      ? line
        ? wrap(line, inner).map((l) => [s(l)])
        : [[]]
      : wrapLine(line, inner, 2),
  );

function content(state, inner) {
  const g = glyphsOf(state);
  const modal = state.modal;
  const title = [s(modal.title ?? "", modal.danger ? "err bold" : "bold")];
  const lines = [[], ...textLines(modal.lines, inner)];
  const targets = [];
  switch (modal.kind) {
    case "confirm": {
      const yes = modal.focus ? modal.focus === "yes" : Boolean(modal.yes);
      return {
        title,
        lines,
        buttons: [
          {
            key: "y",
            label: modal.yesLabel ?? "Yes",
            command: "y",
            selected: yes,
            style: modal.danger ? "err bold" : "bold",
          },
          {
            key: "n",
            label: modal.noLabel ?? "No",
            command: "n",
            selected: !yes,
          },
        ],
      };
    }
    case "typed": {
      const prompt = `${modal.prompt ?? `Type ${modal.word}`}: `;
      const f = fieldWindow(
        modal.value,
        modal.cursor,
        Math.max(4, inner - cells(prompt)),
      );
      lines.push(
        [],
        [
          s(prompt, modal.danger ? "err bold" : "brand bold"),
          s(f.before),
          s(f.at, "inverse"),
          s(f.after),
        ],
      );
      return {
        title,
        lines,
        buttons: [
          { key: g.enter, label: "Confirm", command: "enter" },
          { key: "Esc", label: "Cancel", command: "escape" },
        ],
      };
    }
    case "actions":
    case "choice": {
      lines.push([]);
      const labelWidth = Math.max(...modal.options.map((o) => cells(o.label)));
      modal.options.forEach((option, i) => {
        const on = i === modal.index;
        const style = on ? "selected bold" : "";
        const key = option.key ?? String(i + 1);
        const pad = " ".repeat(labelWidth - cells(option.label));
        const line = spread(
          [
            s(on ? ` ${g.arrow} ` : "   ", on ? style : "brand"),
            s(option.label, style || option.style || ""),
            ...(option.hint
              ? [s(`${pad}   ${option.hint}`, style || "muted")]
              : []),
          ],
          [s(`${key} `, on ? style : "brand bold")],
          inner,
          style,
        );
        targets.push({ x: 0, y: lines.length, width: inner, option: i });
        lines.push(line);
      });
      return {
        title,
        lines,
        targets,
        buttons: [{ key: "Esc", label: "Close", command: "escape" }],
      };
    }
    case "invite": {
      lines.length = 0;
      lines.push(
        [],
        ...textLines(
          [
            "Give it to the people who should join, over a channel you trust (Signal, in person). It lets them ask to join; you still let each one in, after comparing fingerprints.",
          ],
          inner,
        ),
        [],
      );
      // The invite is one word: it breaks anywhere, and Copy takes it whole.
      const code = String(modal.code ?? "");
      for (let i = 0; i < code.length; i += inner)
        lines.push([s(code.slice(i, i + inner), "brand bold")]);
      return {
        title,
        lines,
        buttons: [
          { key: "c", label: "Copy", command: "c" },
          { key: "Esc", label: "Close", command: "escape" },
        ],
      };
    }
    case "help": {
      lines.length = 0;
      lines.push([]);
      const rows = helpRows(g);
      const keyWidth = Math.min(
        14,
        Math.max(...rows.filter(([, t]) => t).map(([k]) => cells(k))) + 3,
      );
      for (const [key, text] of rows) {
        if (!key && !text) lines.push([]);
        else if (!text) lines.push([s(key.toUpperCase(), "muted bold")]);
        else if (!key) lines.push(...wrapLine([s(text, "muted")], inner));
        else
          lines.push(
            ...wrapLine(
              [
                s(key, "brand bold"),
                s(" ".repeat(Math.max(1, keyWidth - cells(key)))),
                s(text),
              ],
              inner,
              keyWidth,
            ),
          );
      }
      return {
        title,
        lines,
        buttons: [{ key: "Esc", label: "Close", command: "escape" }],
      };
    }
    default:
      return { title, lines, buttons: [] };
  }
}

export function modalLayout(state) {
  const g = glyphsOf(state);
  const cols = frameCols(state);
  const height = bodyHeight(state);
  const width = Math.max(
    30,
    Math.min(cols - 4, state.modal.kind === "help" ? 76 : 70),
  );
  const inner = width - 4;
  const c = content(state, inner);
  const tools = buttons(c.buttons ?? [], inner);
  const room = Math.max(1, height - 4 - tools.lines.length);
  const max = Math.max(0, c.lines.length - room);
  const chosen = (c.targets ?? []).find(
    (t) => t.option === state.modal.index,
  )?.y;
  const wanted = chosen === undefined ? 0 : chosen - Math.floor(room / 2);
  const offset = Math.max(0, Math.min(max, state.modal.scroll ?? wanted));
  const body = c.lines.slice(offset, offset + room);
  const lines = [...body, [], ...tools.lines];
  const style = state.modal.danger ? "err" : "brand";
  // A dialog longer than the window scrolls; its bottom edge says so.
  const note =
    offset < max
      ? [s(`${g.down} more below`, "muted")]
      : offset
        ? [s(`${g.up} more above`, "muted")]
        : [];
  const box = boxLines(g, {
    width,
    lines,
    title: c.title,
    note,
    style,
  });
  const top = bodyTop + Math.max(0, Math.floor((height - box.length) / 2));
  const left = Math.max(0, Math.floor((cols - width) / 2));
  const targets = [
    ...(c.targets ?? [])
      .filter((t) => t.y >= offset && t.y < offset + room)
      .map((t) => ({ ...t, y: t.y - offset })),
    ...tools.targets.map((t) => ({ ...t, y: body.length + 1 + t.y })),
  ].map((t) => ({ ...t, x: t.x + left + 2, y: t.y + top + 1 }));
  return { top, left, width, lines: box, targets, offset, max, room };
}

const toastStyle = { ok: "on-ok", error: "on-err", info: "on-brand" };
export function toastLayouts(state) {
  const g = glyphsOf(state);
  const cols = frameCols(state);
  const floats = [];
  // Above the pane's last line, and above the writing line when there is one.
  const pane = paneLayout(state);
  let bottom = bodyTop + (pane.compose ? pane.composeY : bodyHeight(state) - 1);
  for (const t of [...state.toasts.slice(-2)].reverse()) {
    const icon =
      t.tone === "ok" ? g.check : t.tone === "error" ? g.cross : g.bullet;
    // Within the pane, at its right.
    const width = Math.max(
      16,
      Math.min(pane.box.width - 3, 64, cells(t.text) + 6),
    );
    const style = toastStyle[t.tone] ?? "on-brand";
    const text = wrap(t.text, width - 5).slice(0, 3);
    const lines = text.map((l, i) =>
      fitLine(
        [s(i ? "    " : ` ${icon}  `, `${style} bold`), s(l, style)],
        width,
        style,
      ),
    );
    bottom -= lines.length;
    if (bottom < bodyTop) break;
    floats.push({
      id: t.id,
      top: bottom,
      left: Math.max(0, cols - width - 2),
      lines,
      width,
    });
    bottom -= 1;
  }
  return floats;
}
