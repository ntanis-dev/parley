import { homedir } from "node:os";
import { createElement as h, useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { RoomConnection } from "./client.js";
import { outgoingText, Refusal } from "./egress.js";
import { cleanLine, clean } from "./inbound.js";
import {
  appendLog,
  approvedMembers,
  keysOf,
  loadCursor,
  loadRoom,
  markWelcomed,
  pendingMembers,
  prepare,
  readLog,
  receive,
  saveCursor,
} from "./rooms.js";
import {
  activityText,
  memberActivity,
  openPulse,
  recordPulse,
} from "./activity.js";
import {
  activeClaims,
  describeClaim,
  sharedMemory,
  topicOf,
} from "./memory.js";
import { memberVersions, notices } from "./compat.js";
import { readConfig } from "./config.js";
import { runningLaunches } from "./sessions.js";
import { withRoom, afterConnect } from "./ops.js";
import { glyphSets, pickGlyphs, roles, wrap } from "./ui.js";
import { VERSION } from "./version.js";

// `parley view`: the room, live, in the terminal. A sidebar of sections
// (the conversation, members, shared memory, claims, the room's state), the
// selected one on the right, and, in the conversation, a line to write to the
// room as yourself (not your agent). It holds its own connection to the room
// while open, so new messages and who is around show as they happen; it
// sends no pulses (it is not a session) and leaves your agents' inbox alone.

const SECTIONS = ["Conversation", "Members", "Memory", "Claims", "Room"];

// ---- Writing as the person --------------------------------------------------

// Sends `text` from the person themselves (to the room, or to `to` names),
// through the same checks as everything else. Over `conn` when there is
// one, otherwise over a connection opened for it.
export async function sayAsPerson({
  paths,
  identity,
  room,
  text,
  to = [],
  conn = null,
}) {
  const out = outgoingText(text, { root: room.project, home: homedir() });
  const members = approvedMembers(room);
  if (!members.length) throw new Refusal("Nobody else is in this room yet.");
  const only = to.length
    ? to.map((name) => {
        const m = members.find(
          (x) => x.name.toLowerCase() === String(name).toLowerCase(),
        );
        if (!m)
          throw new Refusal(`${cleanLine(name)} is not a member of this room.`);
        return m.id;
      })
    : null;
  const { blob, entry } = prepare(
    identity,
    room,
    "message",
    { text: out, human: true, ...(only ? { to: only } : {}) },
    Date.now(),
    only,
  );
  const post = async (c) => {
    const { c: cursor } = await c.post(blob);
    appendLog(paths, room.roomId, { ...entry, c: cursor });
  };
  if (conn?.state === "connected") await post(conn);
  else await withRoom(paths, identity, room, post);
  const names = members
    .filter((m) => !only || only.includes(m.id))
    .map((m) => m.name);
  return `Sent to ${only ? names.join(", ") : "the room"}.`;
}

// ---- What the screen shows ------------------------------------------------------

export function snapshot(paths, roomId, conn) {
  const room = loadRoom(paths, roomId);
  const config = readConfig(paths);
  return {
    room,
    log: readLog(paths, roomId).slice(-400),
    activity: memberActivity(paths, room),
    pending: pendingMembers(room),
    versions: memberVersions(room),
    memory: sharedMemory(paths, roomId),
    claims: activeClaims(paths, roomId),
    notices: notices(room),
    running: runningLaunches(paths).length,
    relay: conn?.state ?? "offline",
    autonomy: config.autonomy,
    approvals: config.approvals,
  };
}

const time = (at) => new Date(at).toISOString().slice(11, 16);

// One entry of the conversation as lines of [text, tone] spans, wrapped.
export function entryLines(entry, room, width, g) {
  const nameOf = (id) => room.members[id]?.name ?? "someone";
  // Yours are "you" (typed by you) or "your agent"; theirs, their name, with
  // "(typed)" when they wrote it themselves.
  const who = entry.own
    ? entry.human
      ? "you"
      : "your agent"
    : cleanLine(entry.name);
  const to = entry.to?.length
    ? entry.own
      ? ` ${g.sent} ${entry.to.map(nameOf).join(", ")}`
      : ` ${g.sent} you`
    : "";
  const by = entry.human && !entry.own ? " (typed)" : "";
  const head = [
    [` ${who}`, entry.own ? "me" : "brand", true],
    [`${to}${by}`, "muted"],
    [`  ${time(entry.at)}`, "muted"],
  ];
  let body;
  switch (entry.kind) {
    case "message":
      body = clean(entry.text, 4000);
      break;
    case "note":
      body = entry.forgotten
        ? `forgot "${topicOf(entry)}"`
        : `remembered "${topicOf(entry)}": ${clean(entry.text, 2000)}`;
      break;
    case "diff":
      body = `shared a diff: ${(entry.files ?? []).length} files${entry.note ? `, ${clean(entry.note, 300)}` : ""}`;
      break;
    case "file":
      body = `sent a file: ${cleanLine(entry.filename, 120)} (${Math.max(1, Math.round(entry.size / 1024))} KB)`;
      break;
    case "claim":
      body =
        entry.until > Date.now()
          ? `is working on ${entry.paths.join(", ")} until ${time(entry.until)}${entry.note ? ` (${clean(entry.note, 200)})` : ""}`
          : `is done with ${entry.paths.join(", ")}`;
      break;
    default:
      return [];
  }
  const tone = entry.kind === "message" ? "text" : "muted";
  return [
    head,
    ...wrap(body, Math.max(10, width - 4)).map((line) => [
      [`   ${line}`, tone],
    ]),
    [],
  ];
}

// ---- Drawing ------------------------------------------------------------------------

function useColor() {
  return !process.env.NO_COLOR;
}

function Line({ spans, width }) {
  const color = useColor();
  let used = 0;
  const parts = [];
  for (const [text, tone, bold] of spans) {
    if (used >= width) break;
    const cut = text.slice(0, width - used);
    used += cut.length;
    parts.push(
      h(
        Text,
        {
          key: parts.length,
          color: color && roles[tone] ? roles[tone] : undefined,
          bold: Boolean(bold),
        },
        cut,
      ),
    );
  }
  return h(Box, { width, height: 1, overflow: "hidden" }, ...parts);
}

function Lines({ lines, width, height }) {
  const shown = lines.slice(0, height);
  return h(
    Box,
    { flexDirection: "column", width, height },
    ...shown.map((spans, i) => h(Line, { key: i, spans, width })),
  );
}

function header(state, g, width) {
  const online = state.activity.filter((m) => m.state !== "offline");
  const working = online.filter((m) => m.state === "working").length;
  const relay =
    state.relay === "connected"
      ? [`${g.live} live`, "ok"]
      : state.relay === "refused"
        ? [`${g.cross} refused`, "err"]
        : [`${g.wait} ${state.relay}`, "warn"];
  return [
    [` ${g.mark} parley`, "brand", true],
    [`  ${state.room.name}`, "text", true],
    ["   ", ""],
    relay,
    [
      `  ${g.dot}  ${online.length}/${state.activity.length} online`,
      online.length ? "ok" : "muted",
    ],
    ...(working ? [[`  ${g.dot}  ${working} working`, "brand"]] : []),
    ...(state.pending.length
      ? [[`  ${g.dot}  ${state.pending.length} waiting for approval`, "warn"]]
      : []),
    ...(state.notices.length ? [[`  ${g.dot}  versions differ`, "warn"]] : []),
  ];
}

function paneLines(state, section, width, g) {
  switch (section) {
    case "Conversation":
      return state.log.flatMap((e) => entryLines(e, state.room, width, g));
    case "Members": {
      const tone = { working: "brand", idle: "ok", offline: "muted" };
      const lines = state.activity.map((m) => {
        const app = state.versions.find((v) => v.name === m.name)?.app;
        return [
          [` ${m.state === "offline" ? g.off : g.live} `, tone[m.state]],
          [m.name.padEnd(18), "text", true],
          [activityText(m).padEnd(28), tone[m.state]],
          [state.room.members[m.id]?.fingerprint ?? "", "muted"],
          [app ? `  ${app}` : "", "muted"],
        ];
      });
      for (const m of state.pending)
        lines.push([
          [` ${g.wait} `, "warn"],
          [m.name.padEnd(18), "text", true],
          ["waiting for approval".padEnd(28), "warn"],
          [m.fingerprint, "muted"],
        ]);
      return lines.length
        ? lines
        : [[[" Nobody else yet: share the invite (parley invite).", "muted"]]];
    }
    case "Memory":
      return state.memory.length
        ? state.memory.flatMap((n) => [
            [
              [` ${topicOf(n)}`, "brand", true],
              [
                `  ${n.own ? "you" : n.name}, ${new Date(n.at).toISOString().slice(0, 10)}`,
                "muted",
              ],
            ],
            ...wrap(clean(n.text, 2000), width - 4).map((l) => [
              [`   ${l}`, "text"],
            ]),
            [],
          ])
        : [
            [
              [
                " The room's shared memory is empty. Agents add to it with remember.",
                "muted",
              ],
            ],
          ];
    case "Claims":
      return state.claims.length
        ? state.claims.map((c) => [
            [` ${g.bullet} `, "brand"],
            [describeClaim(c), "text"],
          ])
        : [[[" Nobody has claimed anything.", "muted"]]];
    default:
      return [
        [
          [" Room".padEnd(14), "muted"],
          [state.room.name, "text", true],
        ],
        [
          [" Folder".padEnd(14), "muted"],
          [state.room.project, "text"],
        ],
        [
          [" Relay".padEnd(14), "muted"],
          [`${new URL(state.room.relay).host} (${state.relay})`, "text"],
        ],
        [
          [" Autonomy".padEnd(14), "muted"],
          [
            `${state.autonomy}${state.approvals ? ", approvals on" : ""}`,
            "text",
          ],
        ],
        [
          [" Sessions".padEnd(14), "muted"],
          [`${state.running} running`, state.running ? "ok" : "muted"],
        ],
        [
          [" Versions".padEnd(14), "muted"],
          [
            `you ${VERSION}, relay ${state.room.versions?.relay?.app ?? "not seen yet"}`,
            "text",
          ],
        ],
        ...state.notices.map((n) => [
          [` ${g.warn} `, "warn"],
          [n, "warn"],
        ]),
      ];
  }
}

export function ViewApp({ store, actions, glyphs = "rich", size = null }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [, tick] = useState(0);
  const [section, setSection] = useState(0);
  const [scroll, setScroll] = useState(0);
  // The draft lives in a ref as well: keys that arrive before the next
  // render (a paste, fast typing then Enter) must see what came before them.
  const typed = useRef("");
  const [draft, showDraft] = useState("");
  const setDraft = (next) => {
    typed.current = (
      typeof next === "function" ? next(typed.current) : next
    ).slice(0, 4000);
    showDraft(typed.current);
  };
  const [note, setNote] = useState(null);
  useEffect(() => store.subscribe(() => tick((n) => n + 1)), [store]);
  const cols = size?.cols ?? stdout?.columns ?? 100;
  const rows = size?.rows ?? stdout?.rows ?? 30;
  const g = glyphSets[glyphs];
  const state = store.get();
  const side = 16;
  const width = Math.max(30, cols - side - 1);
  const composing = SECTIONS[section] === "Conversation";
  const bodyHeight = Math.max(5, rows - 3 - (composing ? 2 : 0));

  useInput((input, key) => {
    if (key.ctrl && input === "c") return exit();
    if (key.tab) {
      setSection(
        (s) => (s + (key.shift ? SECTIONS.length - 1 : 1)) % SECTIONS.length,
      );
      setScroll(0);
      return;
    }
    if (key.upArrow || key.pageUp)
      return setScroll((n) => n + (key.pageUp ? bodyHeight - 2 : 1));
    if (key.downArrow || key.pageDown)
      return setScroll((n) =>
        Math.max(0, n - (key.pageDown ? bodyHeight - 2 : 1)),
      );
    if (key.escape) {
      if (typed.current) return setDraft("");
      return exit();
    }
    if (!composing) {
      if (input === "q") exit();
      return;
    }
    if (key.return) {
      const text = typed.current.trim();
      if (!text) return;
      setDraft("");
      // "@name text" writes to that member only.
      const direct = /^@(\S+)\s+([\s\S]+)$/.exec(text);
      actions
        .say(direct ? direct[2] : text, direct ? [direct[1]] : [])
        .then((done) => setNote([done, "ok"]))
        .catch((error) => setNote([error.message, "err"]));
      return;
    }
    if (key.backspace || key.delete) return setDraft((d) => d.slice(0, -1));
    if (input && !key.ctrl && !key.meta) setDraft((d) => d + input);
  });

  const all = paneLines(state, SECTIONS[section], width, g);
  // The conversation reads from the bottom; the rest from the top.
  const bottom = composing;
  const maxScroll = Math.max(0, all.length - bodyHeight);
  const offset = Math.min(scroll, maxScroll);
  const visible = bottom
    ? all.slice(
        Math.max(0, all.length - bodyHeight - offset),
        all.length - offset,
      )
    : all.slice(offset, offset + bodyHeight);

  const sidebar = SECTIONS.map((name, i) => [
    [i === section ? ` ${g.arrow} ` : "   ", "brand"],
    [name, i === section ? "brand" : "muted", i === section],
  ]);
  const footer = [
    [" tab", "brand"],
    [" section  ", "muted"],
    [g.updown, "brand"],
    [" scroll  ", "muted"],
    ...(composing
      ? [
          ["enter", "brand"],
          [" send  ", "muted"],
          ["@name", "brand"],
          [" to one  ", "muted"],
        ]
      : []),
    ["esc", "brand"],
    [" quit", "muted"],
    ...(note
      ? [
          ["   ", ""],
          [note[0], note[1]],
        ]
      : []),
  ];

  return h(
    Box,
    { flexDirection: "column", width: cols, height: rows },
    h(Line, { spans: header(state, g, cols), width: cols }),
    h(Line, { spans: [[g.h.repeat(cols), "divider"]], width: cols }),
    h(
      Box,
      { flexDirection: "row", height: bodyHeight + (composing ? 2 : 0) },
      h(Lines, { lines: sidebar, width: side, height: bodyHeight }),
      h(
        Box,
        { flexDirection: "column", width },
        h(Lines, { lines: visible, width, height: bodyHeight }),
        ...(composing
          ? [
              h(Line, {
                key: "rule",
                spans: [[g.h.repeat(width), "divider"]],
                width,
              }),
              h(Line, {
                key: "draft",
                spans: [
                  [` ${g.arrow} `, "me", true],
                  draft
                    ? [draft.slice(-(width - 6)), "text"]
                    : [
                        "write to the room as yourself (@name for one person)",
                        "muted",
                      ],
                  ["_", "me"],
                ],
                width,
              }),
            ]
          : []),
      ),
    ),
    h(Line, { spans: footer, width: cols }),
  );
}

// A store the screen redraws from: the snapshot, refreshed every second and
// whenever the connection brings something.
export function makeStore(load) {
  let state = load();
  const listeners = new Set();
  return {
    get: () => state,
    refresh() {
      try {
        state = load();
      } catch {
        // a file mid-write: next time
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export async function runView({ paths, identity, room, env = process.env }) {
  const { roomId, token } = keysOf(room);
  let conn = null;
  const store = makeStore(() => snapshot(paths, roomId, conn));
  conn = new RoomConnection({
    relay: room.relay,
    roomId,
    token,
    relayKey: room.relayKey,
    cursor: loadCursor(paths, roomId),
    onMessage: (msg) => {
      try {
        receive(paths, identity, roomId, msg);
        saveCursor(paths, roomId, msg.c);
      } catch {}
      store.refresh();
    },
    onPulse: (blob) => {
      try {
        const fresh = loadRoom(paths, roomId);
        const got = fresh && openPulse(identity, fresh, blob);
        if (got) {
          markWelcomed(paths, roomId);
          recordPulse(paths, roomId, got);
        }
      } catch {}
      store.refresh();
    },
    onState: (state) => {
      if (state === "connected")
        afterConnect(paths, identity, roomId, conn).catch(() => {});
      store.refresh();
    },
  }).start();
  const timer = setInterval(() => store.refresh(), 1000);
  const actions = {
    say: async (text, to) => {
      const done = await sayAsPerson({
        paths,
        identity,
        room: loadRoom(paths, roomId),
        text,
        to,
        conn,
      });
      store.refresh();
      return done;
    },
  };
  const app = render(h(ViewApp, { store, actions, glyphs: pickGlyphs(env) }), {
    exitOnCtrlC: false,
    patchConsole: false,
    alternateScreen: true,
  });
  try {
    await app.waitUntilExit();
  } finally {
    clearInterval(timer);
    conn.stop();
  }
  return 0;
}
