// Text for the screen, measured in terminal cells: wide characters (CJK,
// emoji) take two, combining marks none. What members send is cleaned by
// inbound.js before it gets here; tidy() takes out what could still upset
// the drawing (escape sequences, control characters, tabs).
const escapes =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const zeroWidth = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

export const ELLIPSIS = "\u2026";

// Keeps newlines; tabs become two spaces.
export function tidy(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(escapes, "")
    .replace(/\t/g, "  ")
    .replace(controls, "");
}
export const oneLine = (text) => tidy(text).replace(/\s+/g, " ").trim();

function wide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}
export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (zeroWidth.test(ch)) return 0;
  return wide(cp) ? 2 : 1;
}
export function width(text) {
  let cells = 0;
  for (const ch of String(text)) cells += charWidth(ch);
  return cells;
}

// At most `cells` wide; a cut ends with an ellipsis.
export function cut(text, cells) {
  const value = String(text ?? "");
  if (cells <= 0) return "";
  if (width(value) <= cells) return value;
  let out = "",
    used = 0;
  for (const ch of value) {
    const w = charWidth(ch);
    if (used + w > cells - 1) break;
    out += ch;
    used += w;
  }
  return out + ELLIPSIS;
}
// Exactly `cells` wide: cut, then padded with spaces.
export function fit(text, cells) {
  const value = cut(text, cells);
  return value + " ".repeat(Math.max(0, cells - width(value)));
}

// Word wrap to `cells`, keeping blank lines and each line's leading spaces;
// a word longer than a line is broken.
export function wrap(text, cells) {
  const out = [];
  const room = Math.max(1, cells);
  for (const paragraph of tidy(text).split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    const lead = paragraph.match(/^ */)[0].slice(0, Math.floor(room / 2));
    let line = "",
      used = 0;
    const limit = () => Math.max(1, room - width(lead));
    const flush = () => {
      out.push(lead + line);
      line = "";
      used = 0;
    };
    for (const word of paragraph.trim().split(/ +/)) {
      const w = width(word);
      if (used && used + 1 + w > limit()) flush();
      if (w > limit()) {
        for (const ch of word) {
          const cw = charWidth(ch);
          if (used + cw > limit()) flush();
          line += ch;
          used += cw;
        }
        continue;
      }
      line += (used ? " " : "") + word;
      used += (used ? 1 : 0) + w;
    }
    if (line) flush();
  }
  return out;
}

// Times as the room shows them: UTC, as claims are said.
export const hhmm = (at) => new Date(at).toISOString().slice(11, 16);
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
export const day = (at) => {
  const d = new Date(at);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
export const dayKey = (at) => new Date(at).toISOString().slice(0, 10);
// "Nov 4, 09:30"
export const stamp = (at) => `${day(at)}, ${hhmm(at)}`;

// "in 42 min", "in 3 h".
export function until(ms) {
  if (ms <= 0) return "now";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "in under a minute";
  if (min < 90) return `in ${min} min`;
  return `in ${Math.round(min / 60)} h`;
}

export const plural = (n, word, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;

// The window of a field's value that keeps the cursor in view: { before,
// at, after } (the character under the cursor, or a space at the end).
// Newlines show as a return mark.
export function fieldWindow(value, cursor, room) {
  const chars = [...String(value ?? "")].map((c) =>
    c === "\n" ? "\u21b5" : c,
  );
  const at = Math.min(cursor ?? chars.length, chars.length);
  const cells = (list) => list.reduce((n, c) => n + charWidth(c), 0);
  let start = 0;
  while (cells(chars.slice(start, at)) > room - 1 && start < at) start++;
  let end = at + 1;
  while (end < chars.length && cells(chars.slice(start, end + 1)) <= room)
    end++;
  return {
    before: chars.slice(start, at).join(""),
    at: chars[at] ?? " ",
    after: chars.slice(at + 1, Math.max(at + 1, end)).join(""),
  };
}
