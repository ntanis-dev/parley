import { topicOf } from "../memory.js";

// The view's state and what the sidebar and the panes read from it. All of
// it is pure: the reducer changes the state, the components draw it.
//
// focus: which part has the keys: the sidebar ("side"), the pane ("pane")
// or the line that writes to the room ("compose"). selected: the sidebar's
// selection ("conv", "members", "member:<id>", "memory", "note:<topic>",
// "claims", "room"). views: each pane's scroll; picks: the control each
// pane has marked (a member's buttons, the room's settings).
export function initialState({
  data,
  size = { cols: 100, rows: 30 },
  color = true,
  glyphs = "rich",
  now = Date.now(),
} = {}) {
  return {
    data,
    size,
    color,
    glyphs,
    now,
    focus: "compose",
    selected: "conv",
    index: 0,
    open: { members: true, memory: true },
    views: {},
    picks: {},
    draft: { value: "", cursor: 0 },
    to: null,
    seen: data?.log?.at(-1)?.id ?? null,
    modal: null,
    toasts: [],
    toastSeq: 0,
  };
}

// The top of the sidebar's tree, in the order Tab goes through it.
export const SECTIONS = ["conv", "members", "memory", "claims", "room"];
export const sectionOf = (id) =>
  id.startsWith("member:")
    ? "members"
    : id.startsWith("note:")
      ? "memory"
      : SECTIONS.includes(id)
        ? id
        : "conv";

// Everyone in the room as the view shows them: approved members first (in
// the order they came), then those waiting to be let in, then the blocked.
// state is working, idle or offline for an approved member, else its
// status (pending, blocked).
const statusOrder = { approved: 0, pending: 1, blocked: 2 };
export function people(data) {
  const room = data.room;
  const seen = new Map((data.activity ?? []).map((a) => [a.id, a]));
  return Object.entries(room.members ?? {})
    .map(([id, m]) => ({
      id,
      name: m.name,
      fingerprint: m.fingerprint ?? "",
      status: m.status,
      via: m.via ?? null,
      since: m.since ?? null,
      state:
        m.status === "approved" ? (seen.get(id)?.state ?? "offline") : m.status,
      at: seen.get(id)?.at ?? null,
      app: room.versions?.members?.[id]?.app ?? null,
    }))
    .filter((p) => p.status in statusOrder)
    .map((p, i) => ({ ...p, order: i }))
    .sort(
      (a, b) =>
        statusOrder[a.status] - statusOrder[b.status] || a.order - b.order,
    );
}
export const personById = (data, id) =>
  people(data).find((p) => p.id === id) ?? null;

// The shared memory's topics, newest first, each with its sidebar id.
export const topicKey = (note) => topicOf(note).toLowerCase();
export const topics = (data) =>
  (data.memory ?? []).map((note) => ({
    id: `note:${topicKey(note)}`,
    topic: topicOf(note),
    note,
  }));

// A short notice in the corner: ok, error or info. Errors stay longer.
export const toastTtl = { error: 10_000, ok: 5000, info: 4000 };
export function toast(state, text, tone = "info") {
  const id = state.toastSeq + 1;
  return {
    ...state,
    toastSeq: id,
    toasts: [...state.toasts, { id, text, tone, at: state.now }].slice(-3),
  };
}
export const expireToasts = (state) => {
  const kept = state.toasts.filter(
    (t) => state.now - t.at < (toastTtl[t.tone] ?? 5000),
  );
  return kept.length === state.toasts.length
    ? state
    : { ...state, toasts: kept };
};
export const lastToast = (state) => state.toasts.at(-1)?.text ?? null;

// Effects the runtime carries out (store.js): calls to the view's actions,
// quitting and drawing everything again.
export const result = (state, effects = []) => ({ state, effects });
export const call = (name, args = [], extra = {}) => ({
  type: "call",
  name,
  args,
  ...extra,
});
export const quit = { type: "quit" };
