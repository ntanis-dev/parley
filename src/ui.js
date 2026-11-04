// Parley's look: one palette of roles, two glyph
// sets ("rich" for terminals with modern fonts: Windows Terminal, VS Code,
// mintty, macOS and Linux terminals; "plain" for the classic Windows
// console; PARLEY_GLYPHS=rich|plain overrides the guess), and what every
// command prints built as one document: lines of [text, style] spans,
// measured in terminal cells, wrapped to the terminal and indented, under
// Parley's mark. In a terminal they are drawn in colour; in a pipe they are
// the same lines, plain, without the mark. NO_COLOR keeps the layout and
// drops the colour. Text takes the terminal's own foreground, so a light
// scheme reads as well as a dark one. (Glyphs are built from code points so
// the source stays ASCII.)

const cp = (...points) => String.fromCodePoint(...points);

export const roles = {
  brand: "#79b8ff",
  accent: "#79b8ff",
  me: "#c3a6ff",
  ok: "#7cc4a0",
  warn: "#e3b15a",
  err: "#e07a72",
  info: "#8fb3d9",
  muted: "#8b949e",
  divider: "#4d5866",
  text: null,
};

export const glyphSets = {
  rich: {
    mark: cp(0x21c4),
    live: cp(0x25cf),
    wait: cp(0x25cc),
    off: cp(0x25cb),
    ring: cp(0x25cb),
    check: cp(0x2713),
    cross: cp(0x2717),
    warn: "!",
    arrow: cp(0x203a),
    sent: cp(0x2192),
    updown: cp(0x2191, 0x2193),
    got: cp(0x2190),
    dot: cp(0xb7),
    bullet: cp(0x2022),
    h: cp(0x2500),
    v: cp(0x2502),
    tl: cp(0x256d),
    tr: cp(0x256e),
    bl: cp(0x2570),
    br: cp(0x256f),
  },
  plain: {
    mark: "<>",
    live: "*",
    wait: "~",
    off: "o",
    ring: "o",
    check: "+",
    cross: "x",
    warn: "!",
    arrow: ">",
    sent: "->",
    updown: "up/down",
    got: "<-",
    dot: "-",
    bullet: "*",
    h: "-",
    v: "|",
    tl: "+",
    tr: "+",
    bl: "+",
    br: "+",
  },
};

// Modern terminals get the rich set; the classic Windows console the plain.
export function pickGlyphs(env = process.env, platform = process.platform) {
  const forced = String(env.PARLEY_GLYPHS ?? "").toLowerCase();
  if (forced === "plain" || forced === "rich") return forced;
  if (platform !== "win32") return "rich";
  return env.WT_SESSION ||
    env.TERM_PROGRAM ||
    env.ConEmuANSI === "ON" ||
    /xterm|mintty|alacritty|wezterm|kitty/i.test(env.TERM ?? "")
    ? "rich"
    : "plain";
}

// The wordmark (figlet's slant), and the words
// under it.
export const logo = [
  "    ____  ___    ____  __    ________  __",
  "   / __ \\/   |  / __ \\/ /   / ____/\\ \\/ /",
  "  / /_/ / /| | / /_/ / /   / __/    \\  /",
  " / ____/ ___ |/ _, _/ /___/ /___    / /",
  "/_/   /_/  |_/_/ |_/_____/_____/   /_/",
];
export const slogan = "Keep each other's agents in the loop.";
export const motto = [
  "The Claude Code agents on one project, talking as they work.",
  "Sealed end to end, and nothing from outside the project.",
];

// ---- Spans and lines -------------------------------------------------------

export const s = (text, style = "") => [String(text ?? ""), style];
export const plainText = (line) => line.map(([t]) => t).join("");
export const lineWidth = (line) => [...plainText(line)].length;

// Words of `text` in lines of at most `width` cells.
export function wrap(text, width) {
  const out = [];
  for (const paragraph of String(text).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      if (line && [...`${line} ${word}`].length > width) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

// A line of spans in lines of at most `width` cells, at spaces; the lines
// after the first start `lead` cells in, under the first one's text. A word
// longer than a line is cut.
export function wrapLine(line, width, lead = 0) {
  const tokens = [];
  for (const [text, style] of line)
    for (const part of String(text).split(/( +)/))
      if (part) tokens.push([part, style]);
  const out = [];
  let current = [];
  let used = 0;
  const trimmed = (spans) => {
    const copy = [...spans];
    while (copy.length && /^ *$/.test(copy.at(-1)[0])) copy.pop();
    return copy;
  };
  const breakLine = () => {
    out.push(trimmed(current));
    current = lead ? [s(" ".repeat(lead))] : [];
    used = lead;
  };
  for (let [text, style] of tokens) {
    const blank = /^ +$/.test(text);
    if (blank) {
      // No spaces at the start of a continued line.
      if (out.length && used === lead) continue;
      current.push([text, style]);
      used += text.length;
      continue;
    }
    let chars = [...text];
    if (used + chars.length > width && used > (out.length ? lead : 0))
      breakLine();
    while (used + chars.length > width && width - used > 0) {
      current.push([chars.slice(0, width - used).join(""), style]);
      chars = chars.slice(width - used);
      breakLine();
    }
    current.push([chars.join(""), style]);
    used += chars.length;
  }
  out.push(trimmed(current));
  return out;
}

// ---- Drawing -----------------------------------------------------------------

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const BASIC = {
  brand: 94,
  accent: 94,
  me: 95,
  ok: 32,
  warn: 33,
  err: 31,
  info: 36,
  muted: 90,
  divider: 90,
};

function sgr(style, depth) {
  const codes = [];
  for (const word of String(style).split(" ").filter(Boolean)) {
    if (word === "bold") codes.push(1);
    else if (word === "dim") codes.push(2);
    else if (word === "italic") codes.push(3);
    else if (word === "underline") codes.push(4);
    else if (roles[word] && depth > 1) {
      const [r, g, b] = rgb(roles[word]);
      if (depth >= 24) codes.push(38, 2, r, g, b);
      else if (depth >= 8) {
        const level = (v) => Math.round((v / 255) * 5);
        codes.push(38, 5, 16 + 36 * level(r) + 6 * level(g) + level(b));
      } else codes.push(BASIC[word] ?? 39);
    }
  }
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

// The terminal a command writes to.
export function terminalFor(stream, env = process.env) {
  const tty = Boolean(stream?.isTTY);
  let depth = 1;
  if (!env.NO_COLOR) {
    if (tty && typeof stream.getColorDepth === "function")
      depth = stream.getColorDepth(env);
    else if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") depth = 8;
  }
  return {
    tty,
    depth,
    styled: depth > 1,
    g: glyphSets[pickGlyphs(env)],
    cols: Math.max(50, Math.min(stream?.columns || 100, 110)),
  };
}

// Lines of spans to text, one line per row; trailing blanks trimmed.
export function render(lines, term) {
  return lines
    .map((line) => {
      let out = "";
      // Neighbouring spans of one style go out under one escape.
      const runs = [];
      for (const [text, style] of line)
        if (runs.at(-1)?.[1] === style) runs.at(-1)[0] += text;
        else runs.push([text, style]);
      for (const [text, style] of runs) {
        const open = term.styled ? sgr(style, term.depth) : "";
        out += open ? `${open}${text}\x1b[0m` : text;
      }
      return out.replace(/ +$/, "");
    })
    .join("\n");
}

// ---- Pieces the commands share -----------------------------------------------

export const INDENT = 2;

// The width a document's lines may use.
export const room = (term) => term.cols - INDENT * 2;

// The Parley mark: the wordmark and its words, or the mark and name on one
// line. Only in a terminal: piped output starts with what it says.
export function banner(term, { full = false } = {}) {
  if (!term.tty) return [];
  if (full)
    return [
      ...logo.map((line) => [s(line, "brand bold")]),
      [],
      [s(slogan, "accent bold")],
      ...motto.map((line) => [s(line, "muted")]),
      [],
    ];
  return [[s(`${term.g.mark} PARLEY`, "brand bold")], []];
}

// "TITLE -------- note": a section heading with its rule.
export function heading(title, width, term, note = "") {
  const tail = note ? [s(note, "muted")] : [];
  const rule = Math.max(
    3,
    width - lineWidth([s(title)]) - 2 - (note ? lineWidth(tail) + 2 : 0),
  );
  return [
    s(title, "muted bold"),
    s(`  ${term.g.h.repeat(rule)}`, "divider"),
    ...(note ? [s("  "), ...tail] : []),
  ];
}

// "label   value" with the labels in a column and a long value wrapped under
// itself; `value` is text or spans.
export const LABEL = 14;

export function fact(label, value, width, labelWidth = LABEL, tone = "") {
  const spans = typeof value === "string" ? [s(value, tone)] : value;
  return wrapLine(
    [s(label.padEnd(labelWidth), "muted"), ...spans],
    width,
    labelWidth,
  );
}

// Outcome marks, in the terminal's glyphs.
export const marks = (g) => ({
  done: [s(g.check, "ok bold")],
  same: [s(g.check, "muted")],
  fail: [s(g.cross, "err bold")],
  warn: [s(g.warn, "warn bold")],
  skip: [s(g.ring, "muted")],
  next: [s(g.arrow, "accent bold")],
});

// The one-line answer to a command: "+ Opened room "shop"".
export const outcome = (term, text, kind = "done", note = "") => [
  ...marks(term.g)[kind],
  s(" "),
  s(text, kind === "fail" ? "err bold" : "bold"),
  ...(note ? [s(`  ${note}`, "muted")] : []),
];

// ---- A command's document, as it goes ------------------------------------------

// What a command prints, written as it goes (a command may ask in between):
// the mark first, every line indented, a blank line above and below in a
// terminal. `shared` is one per run, so stdout and stderr (the same terminal)
// make one document between them.
export function printer(stream, env = process.env, shared = {}) {
  const term = terminalFor(stream, env);
  const { g } = term;
  const width = room(term);
  const pad = s(" ".repeat(INDENT));
  const indent = (line) => (line.length ? [pad, ...line] : line);
  const start = () => {
    if (shared.started) return;
    shared.started = true;
    const head = [
      ...(term.tty ? [[]] : []),
      ...banner(term, { full: shared.full }).map(indent),
    ];
    if (head.length) stream.write(`${render(head, term)}\n`);
    shared.blank = true;
  };
  const write = (lines) => {
    start();
    if (!lines.length) return;
    stream.write(`${render(lines.map(indent), term)}\n`);
    shared.blank = !lines.at(-1).length;
  };
  const blank = () => {
    start();
    if (shared.blank) return;
    stream.write("\n");
    shared.blank = true;
  };
  const say = (kind, text, tone, note = "") =>
    write(
      wrapLine(
        [
          ...marks(g)[kind],
          s(" "),
          s(text, tone),
          ...(note ? [s(`  ${note}`, "muted")] : []),
        ],
        width,
        2,
      ),
    );
  const ui = {
    term,
    width,
    // The wordmark instead of the one-line mark (before anything is written).
    full: () => (shared.full = true),
    lines: write,
    blank,
    ok: (text, note) => say("done", text, "bold", note),
    warn: (text) => say("warn", text, "warn"),
    err: (text) => say("fail", text, ""),
    skip: (text) => say("skip", text, "muted"),
    info: (text) => say("next", text, ""),
    paragraph: (text, tone = "muted") =>
      write(wrapLine([s(text, tone)], width)),
    fact: (label, value, tone = "", labelWidth = LABEL) =>
      write(fact(label, value, width, labelWidth, tone)),
    // "Next          parley approve  once they have joined"
    next: (text, note = "") =>
      write(
        fact(
          "Next",
          [s(text, "accent bold"), ...(note ? [s(`  ${note}`, "muted")] : [])],
          width,
        ),
      ),
    heading: (title, note = "") => {
      blank();
      write([heading(title.toUpperCase(), width, term, note)]);
      blank();
    },
    // A list entry: a mark, a name column and what follows.
    entry: (mark, name, value, nameWidth) => {
      const head = [...mark, s(" "), s(name.padEnd(nameWidth), "bold")];
      write(wrapLine([...head, s(" "), ...value], width, lineWidth(head) + 1));
    },
    // Something to copy whole (an invite): never wrapped.
    code: (text) => write([[s(`  ${text}`, "accent bold")]]),
    // A warning that has to be read: a red box.
    danger: (title, paragraphs) => {
      const inner = width - 4;
      const body = paragraphs.flatMap((p, i) => [
        ...(i ? [""] : []),
        ...wrap(p, inner),
      ]);
      blank();
      if (!term.tty) {
        write([[s(`DANGER: ${title}`)], ...body.map((l) => [s(`  ${l}`)])]);
        blank();
        return;
      }
      const edge = (l, r) => [s(`${l}${g.h.repeat(inner + 2)}${r}`, "err")];
      write([
        edge(g.tl, g.tr),
        [
          s(`${g.v} `, "err"),
          s(`DANGER: ${title}`.padEnd(inner), "err bold"),
          s(` ${g.v}`, "err"),
        ],
        [s(`${g.v} ${" ".repeat(inner)} ${g.v}`, "err")],
        ...body.map((l) => [
          s(`${g.v} `, "err"),
          s(l.padEnd(inner), ""),
          s(` ${g.v}`, "err"),
        ]),
        edge(g.bl, g.br),
      ]);
      blank();
    },
    // A question, in the document: "> question hint ". Returned for
    // readline to write; what the person types ends the line.
    prompt: (question, hint = "") => {
      start();
      shared.blank = false;
      return render(
        [
          indent([
            s(`${g.arrow} `, "accent bold"),
            s(question, "bold"),
            ...(hint ? [s(` ${hint}`, "muted")] : []),
            s(" "),
          ]),
        ],
        term,
      ).replace(/\n$/, "");
    },
    // An error that ends the command: "x message" in the document, or
    // "parley: message" in a pipe.
    failure: (message, help = null) => {
      if (!term.tty) {
        stream.write(`parley: ${message}\n`);
        return;
      }
      if (shared.started) blank();
      say("fail", message, "");
      if (help) {
        blank();
        write(fact("Help", [s(help, "accent")], width, 8));
      }
    },
    // The blank line under the document, once.
    end: () => {
      if (!shared.started || shared.ended || !term.tty) return;
      shared.ended = true;
      if (!shared.blank) stream.write("\n");
    },
  };
  return ui;
}
