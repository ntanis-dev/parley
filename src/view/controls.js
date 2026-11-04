import { fitLine, lineWidth, s, wrapFacts } from "./lines.js";

// Pieces the panes and dialogs share: section rules, facts in a column,
// and buttons ("Approve  a"), which carry what a click on them does.

export function sectionRule(title, width, g, extra = "") {
  const label = [s(title.toUpperCase(), "muted bold"), s("  ")];
  const right =
    extra && lineWidth(label) + extra.length + 4 <= width
      ? [s(` ${extra}`, "muted")]
      : [];
  return [
    ...label,
    s(
      g.h.repeat(Math.max(0, width - lineWidth(label) - lineWidth(right))),
      "divider",
    ),
    ...right,
  ];
}

// "Label     value", the value wrapping under itself.
export const LABEL = 12;
export function fact(label, value, width, tone = "") {
  const spans = typeof value === "string" ? [s(value, tone)] : value;
  return wrapFacts([spans], width, {
    indent: LABEL,
    lead: [s(label.padEnd(LABEL), "muted")],
  });
}
export const note = (text, style = "muted") => [s(text, style)];

// A row of buttons, wrapping when they do not fit: each " Label  key ",
// highlighted when selected. Returns the lines and where each button is.
export function buttons(entries, width, { indent = 0 } = {}) {
  const lines = [[...(indent ? [s(" ".repeat(indent))] : [])]],
    targets = [];
  for (const entry of entries) {
    const on = entry.selected;
    const own = [
      s(` ${entry.label} `, on ? "selected bold" : (entry.style ?? "bold")),
      ...(entry.key
        ? [s(` ${entry.key} `, on ? "selected bold" : "brand bold")]
        : []),
    ];
    const size = lineWidth(own);
    let row = lines.length - 1,
      x = lineWidth(lines[row]);
    if (x > indent && x + size > width) {
      lines.push(indent ? [s(" ".repeat(indent))] : []);
      row++;
      x = indent;
    }
    lines[row].push(...own, s("  "));
    targets.push({ x, y: row, width: Math.min(size, width - x), ...entry });
  }
  return { lines: lines.map((line) => fitLine(line, width)), targets };
}
