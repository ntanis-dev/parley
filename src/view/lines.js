import { charWidth, ELLIPSIS, tidy, width } from "./text.js";

// What the view draws is built as lines of spans, [text, style], measured
// in terminal cells; app.js draws them with Ink. A style is space-separated
// words (theme.js): bold, dim, italic, underline, inverse, selected, spin,
// the on-<role> fills of toasts, and the roles of ui.js (brand, me, ok,
// warn, err, info, muted, divider).
export const s = (text, style = "") => [tidy(text).replace(/\n/g, " "), style];
export const lineWidth = (line) =>
  line.reduce((sum, [text]) => sum + width(text), 0);
export const plain = (line) => line.map(([text]) => text).join("");

// Exactly `cells` wide: padded, or (the last resort, for a line that was
// not made to fit) cut. The pad takes `fill`'s style, so a selected row is
// highlighted to the edge.
export function fitLine(line, cells, fill = "") {
  const out = [];
  let used = 0;
  for (const [text, style] of line) {
    if (used >= cells) break;
    const w = width(text);
    if (used + w <= cells) {
      out.push([text, style]);
      used += w;
      continue;
    }
    let part = "";
    for (const ch of text) {
      const cw = charWidth(ch);
      if (used + cw > cells) break;
      part += ch;
      used += cw;
    }
    out.push([part, style]);
    break;
  }
  if (used < cells) out.push([" ".repeat(cells - used), fill]);
  return out;
}

// A line cut to `cells`, its styles kept, with an ellipsis where something
// was cut.
export function cutSpans(line, cells) {
  if (cells <= 0) return [];
  if (lineWidth(line) <= cells) return line;
  const out = [];
  let used = 0;
  for (const [text, style] of line) {
    let kept = "";
    for (const ch of text) {
      const w = charWidth(ch);
      if (used + w > cells - 1) {
        if (kept) out.push([kept, style]);
        out.push([ELLIPSIS, style]);
        return out;
      }
      kept += ch;
      used += w;
    }
    out.push([kept, style]);
  }
  return out;
}

// Left and right parts on one line of `cells`, the gap between them padded.
// A right part that does not fit is left out.
export function spread(left, right, cells, fill = "") {
  const room = cells - lineWidth(right);
  if (!right.length || room < lineWidth(left) + 1)
    return fitLine(left, cells, fill);
  return [...fitLine(left, room, fill), ...right];
}

// Every span of a line in one style (a selected row keeps bold, and its
// spinner spins).
const kept = ["bold", "spin"];
export const restyle = (line, style) =>
  line.map(([text, own]) => {
    const words = String(own).split(" ");
    const extra = kept.filter(
      (w) => words.includes(w) && !style.split(" ").includes(w),
    );
    return [text, [style, ...extra].join(" ")];
  });

// A line of spans wrapped to `cells`: at spaces where it can, inside a word
// that is longer than a line. Continuation lines start with `indent`
// spaces; styles stay with their text. Nothing is cut.
const breaks = new Set(["-", "/", "\\", ":", "_", "."]);
export function wrapLine(line, cells, indent = 0) {
  const room = Math.max(1, cells);
  const lead = Math.min(indent, Math.max(0, room - 1));
  const tokens = [];
  for (const [text, style] of line)
    for (const part of String(text).split(/( +)/))
      if (part) tokens.push([part, style]);
  const out = [];
  let current = [],
    used = 0;
  const atStart = () => used === (out.length ? lead : 0);
  const flush = () => {
    while (current.length && /^ +$/.test(current.at(-1)[0])) {
      used -= width(current.at(-1)[0]);
      current.pop();
    }
    out.push(current);
    current = lead ? [[" ".repeat(lead), ""]] : [];
    used = lead;
  };
  const space = (token) => /^ +$/.test(token[0]);
  for (let i = 0; i < tokens.length; i++) {
    const [text, style] = tokens[i];
    const w = width(text);
    if (space(tokens[i])) {
      if (out.length && atStart()) continue;
      if (used + w > room) {
        flush();
        continue;
      }
      current.push([text, style]);
      used += w;
      continue;
    }
    // A word that fits a line of its own goes to the next line whole, also
    // when it is several spans.
    if (i === 0 || space(tokens[i - 1])) {
      let whole = w;
      for (let j = i + 1; j < tokens.length && !space(tokens[j]); j++)
        whole += width(tokens[j][0]);
      if (used + whole > room && !atStart() && whole <= room - lead) flush();
    }
    if (used + w <= room) {
      current.push([text, style]);
      used += w;
      continue;
    }
    // A word longer than a whole line breaks after a - / : _ or . where it
    // can, else where the line ends.
    let rest = [...text];
    while (rest.length) {
      let cells = 0,
        fits = 0,
        mark = 0;
      for (const ch of rest) {
        cells += charWidth(ch);
        if (used + cells > room) break;
        fits++;
        if (breaks.has(ch)) mark = fits;
      }
      if (fits === rest.length) {
        current.push([rest.join(""), style]);
        used += cells;
        break;
      }
      if (!mark && !atStart()) {
        flush();
        continue;
      }
      const take = mark || fits || 1;
      current.push([rest.slice(0, take).join(""), style]);
      used += width(rest.slice(0, take).join(""));
      rest = rest.slice(take);
      flush();
    }
  }
  if (current.length && !(out.length && atStart())) flush();
  return out.length ? out : [[]];
}

// Facts (each a list of spans) on lines `cells` wide, a separator between
// them; a line breaks between two facts. `lead` starts the first line,
// `indent` spaces the others.
export function wrapFacts(
  facts,
  cells,
  { sep = [" \u00b7 ", "muted"], indent = 0, lead = [] } = {},
) {
  const room = Math.max(1, cells);
  const out = [];
  let line = [...lead],
    used = lineWidth(lead),
    filled = false;
  const pad = () => (indent ? [[" ".repeat(indent), ""]] : []);
  for (const fact of facts) {
    if (!fact?.length) continue;
    const w = lineWidth(fact);
    if (filled && used + width(sep[0]) + w > room) {
      out.push(line);
      line = pad();
      used = indent;
      filled = false;
    } else if (filled) {
      line.push(sep);
      used += width(sep[0]);
    }
    if (used + w > room) {
      const parts = wrapLine([...line, ...fact], room, indent);
      out.push(...parts.slice(0, -1));
      line = parts.at(-1);
      used = lineWidth(line);
    } else {
      line.push(...fact);
      used += w;
    }
    filled = true;
  }
  out.push(line);
  return out;
}

// A line that carries click targets ({ x, width, ... } on its own row).
export const withTargets = (line, targets) =>
  Object.assign(line, { targets: [...(line.targets ?? []), ...targets] });
