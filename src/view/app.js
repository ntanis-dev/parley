import {
  createElement as h,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Box,
  Text,
  useAnimation,
  useApp,
  useInput,
  usePaste,
  useStdout,
} from "ink";
import { logo, slogan } from "../ui.js";
import { fitLine, s } from "./lines.js";
import { makeTheme, ThemeContext, useTheme } from "./theme.js";
import {
  bodyHeight,
  frameCols,
  frameRows,
  minSize,
  tooSmall,
} from "./layout.js";
import { keyOf } from "./keys.js";
import { footerModel, headerModel, ruleLine } from "./chrome.js";
import { sideLayout } from "./sidebar.js";
import { paneLayout } from "./pane.js";
import { modalLayout, toastLayouts } from "./overlays.js";
import { createView } from "./store.js";

// The view drawn with Ink, from the state alone (no JSX: createElement as
// h). Every part is lines of spans laid out by the modules beside this one,
// which the mouse is tested against too.

// A spinner frame: Ink's shared animation timer drives every spinner at
// once. Outside a terminal (tests) it stays on its first frame.
function Spinner({ style }) {
  const theme = useTheme();
  const { frame } = useAnimation({ interval: 100 });
  const frames = theme.g.spinner;
  return h(Text, theme.props(style), frames[frame % frames.length]);
}

// One line of spans. A span styled "spin" is a spinner.
const Line = memo(function Line({ line }) {
  const theme = useTheme();
  return h(
    Text,
    { wrap: "truncate-end" },
    ...line.map(([text, style], i) =>
      /\bspin\b/.test(style) && /\S/.test(text)
        ? h(Spinner, { key: i, style: style.replace(/\bspin\b/, "").trim() })
        : h(Text, { key: i, ...theme.props(style) }, text),
    ),
  );
});

// Lines in a column of fixed height (empty rows below them).
function Lines({ lines, width, height }) {
  const shown = height === undefined ? lines : lines.slice(0, height);
  return h(
    Box,
    {
      flexDirection: "column",
      width,
      height,
      overflow: "hidden",
      flexShrink: 0,
    },
    ...shown.map((line, i) =>
      h(Line, { key: i, line: width ? fitLine(line, width) : line }),
    ),
  );
}

function Float({ top, left, lines, width }) {
  return h(
    Box,
    {
      position: "absolute",
      marginTop: top,
      marginLeft: left,
      width,
      flexDirection: "column",
    },
    h(Lines, { lines, width }),
  );
}

function Sidebar({ state }) {
  const theme = useTheme();
  const layout = sideLayout(state);
  return h(
    Box,
    {
      width: layout.width,
      height: layout.height,
      flexShrink: 0,
      flexDirection: "column",
      paddingX: 1,
      borderStyle: theme.g.border,
      borderLeft: false,
      borderTop: false,
      borderBottom: false,
      borderColor: theme.tone("divider"),
    },
    ...(layout.brand.length
      ? [
          h(Lines, {
            key: "brand",
            lines: layout.brand,
            width: layout.cells,
            height: layout.brand.length,
          }),
        ]
      : []),
    h(Lines, {
      key: "tree",
      lines: layout.lines,
      width: layout.cells,
      height: layout.room,
    }),
    ...(layout.more.length
      ? [
          h(Lines, {
            key: "more",
            lines: layout.more,
            width: layout.cells,
            height: 1,
          }),
        ]
      : []),
  );
}

function Pane({ state }) {
  const p = paneLayout(state);
  return h(
    Box,
    {
      width: p.box.width,
      height: p.box.height,
      flexDirection: "column",
      paddingX: p.box.pad,
      flexShrink: 0,
    },
    h(Lines, { lines: p.head, width: p.width, height: p.head.length }),
    h(Lines, { lines: p.window.lines, width: p.width, height: p.window.room }),
    ...(p.compose
      ? [
          h(Lines, {
            key: "compose",
            lines: p.compose.lines,
            width: p.width,
            height: 3,
          }),
        ]
      : []),
    h(Lines, { lines: [p.legend], width: p.width, height: 1 }),
  );
}

function TooSmall({ state }) {
  const cols = frameCols(state);
  const lines = [
    ...(state.size.cols >= 44 && state.size.rows >= 12
      ? [...logo.map((line) => [s(line, "brand bold")]), []]
      : [[s("PARLEY", "brand bold")], []]),
    [s(slogan, "muted")],
    [],
    [s("A little more room.", "brand")],
    [
      s(
        `parley view needs ${minSize.cols} x ${minSize.rows} cells; this is ${state.size.cols} x ${state.size.rows}.`,
        "muted",
      ),
    ],
    [],
    [s("q  Quit", "muted")],
  ];
  return h(
    Box,
    {
      width: cols,
      height: frameRows(state),
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
    },
    ...lines.map((line, i) => h(Box, { key: i, height: 1 }, h(Line, { line }))),
  );
}

function Frame({ state }) {
  const cols = frameCols(state);
  const rows = frameRows(state);
  if (tooSmall(state)) return h(TooSmall, { state });
  const header = headerModel(state);
  return h(
    Box,
    { width: cols, height: rows, flexDirection: "column" },
    h(Lines, { lines: [header.line, ruleLine(state)], width: cols, height: 2 }),
    h(
      Box,
      {
        width: cols,
        height: bodyHeight(state),
        flexDirection: "row",
        overflow: "hidden",
      },
      h(Sidebar, { state }),
      h(Pane, { state }),
    ),
    h(Lines, { lines: [footerModel(state).line], width: cols, height: 1 }),
    ...toastLayouts(state).map((layout) =>
      h(Float, { key: `toast${layout.id}`, ...layout }),
    ),
    ...(state.modal ? [h(Float, { key: "modal", ...modalLayout(state) })] : []),
  );
}

export function Screen({ state }) {
  const theme = useMemo(
    () => makeTheme({ color: state.color, glyphs: state.glyphs }),
    [state.color, state.glyphs],
  );
  return h(ThemeContext.Provider, { value: theme }, h(Frame, { state }));
}

// The view on a snapshot store and its actions. `view` is a running view
// (store.js) when the caller holds one (runView, for the mouse and the
// window's size); otherwise the component makes its own.
export function ViewApp({
  store,
  actions,
  glyphs = "rich",
  size = null,
  color = !process.env.NO_COLOR,
  view = null,
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const leave = useRef(exit);
  leave.current = exit;
  const [own] = useState(
    () =>
      view ??
      createView({
        data: store,
        actions,
        size: size ?? {
          cols: stdout?.columns || 100,
          rows: stdout?.rows || 30,
        },
        color,
        glyphs,
        onQuit: () => leave.current(),
      }),
  );
  useEffect(() => {
    if (view || size || !stdout?.on) return undefined;
    const resized = () =>
      own.dispatch({
        type: "resize",
        cols: stdout.columns || 100,
        rows: stdout.rows || 30,
      });
    stdout.on("resize", resized);
    return () => stdout.off("resize", resized);
  }, [own, view, size, stdout]);
  useEffect(() => () => (view ? undefined : own.close()), [own, view]);
  const state = useSyncExternalStore(own.subscribe, own.getState, own.getState);
  useInput((input, key) => {
    const name = keyOf(input, key);
    if (name && typeof name === "object")
      own.dispatch({ type: "text", text: name.text });
    else if (name) own.dispatch({ type: "key", key: name });
  });
  usePaste((text) => own.dispatch({ type: "paste", text }));
  return h(Screen, { state });
}
