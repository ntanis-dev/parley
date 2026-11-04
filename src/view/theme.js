import { createContext, useContext } from "react";
import { glyphSets as base, roles } from "../ui.js";

// The view's look: Parley's roles and glyphs (ui.js), the few glyphs only
// the view needs, and the mapping from span styles (lines.js) to Ink
// <Text> props. Text takes the terminal's own foreground and nothing paints
// a background except the selection and the toasts, so a light scheme reads
// as well as a dark one. Without colours (NO_COLOR) the selection is
// inverse and the layout stays the same.
const cp = (...points) => String.fromCodePoint(...points);

export const glyphSets = {
  rich: {
    ...base.rich,
    up: cp(0x2191),
    down: cp(0x2193),
    left: cp(0x2190),
    right: cp(0x2192),
    enter: cp(0x23ce),
    open: cp(0x25be),
    closed: cp(0x25b8),
    dash: cp(0x2013),
    join: cp(0x252c),
    tee: cp(0x2524),
    spinner: [
      0x280b, 0x2819, 0x2839, 0x2838, 0x283c, 0x2834, 0x2826, 0x2827, 0x2807,
      0x280f,
    ].map((c) => cp(c)),
    border: "round",
  },
  plain: {
    ...base.plain,
    up: cp(0x2191),
    down: cp(0x2193),
    left: cp(0x2190),
    right: cp(0x2192),
    enter: "Enter",
    open: "v",
    closed: ">",
    dash: "-",
    join: "+",
    tee: "|",
    spinner: ["|", "/", "-", "\\"],
    border: "classic",
  },
};
export const glyphsOf = (state) => glyphSets[state.glyphs] ?? glyphSets.rich;

// The selection: white on a blue that reads on light and dark schemes.
const SELECTED = { color: "#ffffff", backgroundColor: "#2f5d8a" };

function textProps(style, color) {
  const props = {};
  let tone = null,
    dim = false,
    filled = false;
  for (const word of String(style ?? "").split(" ")) {
    if (!word) continue;
    if (word === "bold") props.bold = true;
    else if (word === "italic") props.italic = true;
    else if (word === "underline") props.underline = true;
    else if (word === "inverse") props.inverse = true;
    else if (word === "strike") props.strikethrough = true;
    else if (word === "dim") dim = true;
    else if (word === "selected") {
      if (color) Object.assign(props, SELECTED);
      else props.inverse = true;
      props.bold = true;
      filled = true;
    } else if (word.startsWith("on-") && roles[word.slice(3)]) {
      // A toast: dark text on the role's colour; inverse without colours.
      if (color) {
        props.backgroundColor = roles[word.slice(3)];
        props.color = "#000000";
      } else props.inverse = true;
      filled = true;
    } else if (word in roles && roles[word] && !filled) tone = roles[word];
  }
  if (color && tone && !filled) props.color = tone;
  if (dim && !filled) {
    if (color && !props.color) props.color = roles.muted;
    else if (!color) props.dimColor = true;
  }
  return props;
}

export function makeTheme({ color = true, glyphs = "rich" } = {}) {
  const g = glyphSets[glyphs] ?? glyphSets.rich;
  const cache = new Map();
  return {
    color,
    glyphs,
    g,
    props(style = "") {
      let p = cache.get(style);
      if (!p) cache.set(style, (p = textProps(style, color)));
      return p;
    },
    // A border's colour, or none without colours.
    tone: (role) => (color ? (roles[role] ?? undefined) : undefined),
  };
}

export const ThemeContext = createContext(makeTheme());
export const useTheme = () => useContext(ThemeContext);
