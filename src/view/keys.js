// Ink's useInput (input, key) as the view's key names: "up", "enter",
// "escape", "ctrl+c", "shift+tab", ... or the character typed ("q", "?",
// an accented letter). Keys the view does not use come back as null; text
// that arrives at once (a paste without bracketed paste mode, or fast
// typing) comes back as { text }.
const arrows = [
  ["upArrow", "up"],
  ["downArrow", "down"],
  ["leftArrow", "left"],
  ["rightArrow", "right"],
  ["pageUp", "pageup"],
  ["pageDown", "pagedown"],
  ["home", "home"],
  ["end", "end"],
];
const control = /[\x00-\x1f\x7f-\x9f]/;

export function keyOf(input = "", key = {}) {
  if (key.escape) return "escape";
  for (const [flag, name] of arrows) if (key[flag]) return name;
  if (key.return) return "enter";
  if (key.tab) return key.shift ? "shift+tab" : "tab";
  if (key.backspace) return "backspace";
  if (key.delete) return "delete";
  if (key.ctrl)
    return input
      ? `ctrl+${input === " " ? "space" : input.toLowerCase()}`
      : null;
  if (key.meta) return null;
  if (typeof input !== "string" || !input) return null;
  const chars = [...input];
  if (chars.length === 1) return control.test(input) ? null : input;
  return { text: input };
}

// A key that types text (a character), rather than a command.
export const printable = (key) =>
  typeof key === "string" && [...key].length === 1 && !control.test(key);
