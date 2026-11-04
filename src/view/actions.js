import { cleanLine } from "../inbound.js";
import { trustLines } from "../trust.js";
import { call, people, personById, result, toast } from "./state.js";
import { select } from "./tree.js";
import { memberActions } from "./members.js";
import { currentItem } from "./pane.js";

// What a person can do from the view, each as an action ({ do, ... }) that
// opens a dialog or leads to an effect: a call to the view's actions
// (index.js), which are the same functions the CLI's commands use. Letting
// someone in goes as `parley approve` does: compare the fingerprint, then
// type their name after the warning; widening autonomy asks for "work"
// typed, turning approvals off asks first.

const nameOf = (p) => cleanLine(p?.name ?? "someone");
const still = (p) =>
  p.status === "blocked"
    ? `${nameOf(p)} stays blocked.`
    : `${nameOf(p)} is still waiting.`;

function approve(state, id) {
  const p = personById(state.data, id);
  if (!p) return result(toast(state, "That member is gone.", "error"));
  if (p.status === "approved")
    return result(toast(state, `${nameOf(p)} is already in.`));
  const name = nameOf(p);
  return result({
    ...state,
    modal: {
      kind: "confirm",
      title:
        p.status === "blocked"
          ? `Let ${name} back in?`
          : `Is this ${name}'s fingerprint?`,
      lines: [
        p.via === "key change"
          ? `${name}'s keys changed since you last let them in. Their fingerprint now:`
          : `The fingerprint ${name} joined with:`,
        "",
        [["  " + p.fingerprint, "warn bold"]],
        "",
        `Ask ${name} to read you theirs (on a call, in person) and compare every group. Say yes only if it is the same.`,
      ],
      yesLabel: "Same, continue",
      noLabel: "Not now",
      next: { do: "trust", id },
      declined: still(p),
    },
  });
}

function trust(state, id) {
  const p = personById(state.data, id);
  if (!p) return result(toast(state, "That member is gone.", "error"));
  const name = nameOf(p);
  return result({
    ...state,
    modal: {
      kind: "typed",
      danger: true,
      title: `You are about to trust ${name}`,
      lines: trustLines(name, state.data.autonomy, `autonomy "work"`).flatMap(
        (line, i) => (i ? ["", line] : [line]),
      ),
      word: name,
      prompt: `Type ${name} to confirm`,
      value: "",
      cursor: 0,
      effect: call("approve", [id], { person: name }),
      refused: `Not approved: ${still(p).replace(/\.$/, "")}`,
      declined: still(p),
    },
  });
}

function block(state, id) {
  const p = personById(state.data, id);
  if (!p) return result(toast(state, "That member is gone.", "error"));
  const name = nameOf(p);
  return result({
    ...state,
    modal: {
      kind: "confirm",
      danger: true,
      title: `Block ${name}?`,
      lines: [
        `Nothing more is sent to or read from ${name}. Their agent can no longer reach yours.`,
        "",
        [["  " + p.fingerprint, "muted"]],
      ],
      yesLabel: "Block",
      noLabel: "Cancel",
      effect: call("block", [id], { person: name }),
    },
  });
}

function autonomy(state) {
  if (state.data.autonomy !== "work")
    return result({
      ...state,
      modal: {
        kind: "typed",
        danger: true,
        title: "Members' agents will be able to change this project",
        lines: [
          "In a turn their message starts, your Claude may pull, resolve conflicts, edit project files, commit and push when they ask, with nobody watching.",
          "",
          "Parley keeps it to the project and away from your secrets; it cannot judge whether a request is wise.",
        ],
        word: "work",
        prompt: "Type work to confirm",
        value: "",
        cursor: 0,
        effect: call("autonomy", ["work"]),
        refused: "Autonomy is unchanged",
        declined: "Autonomy is unchanged.",
      },
    });
  return result(state, [call("autonomy", ["read"])]);
}

function approvals(state) {
  if (!state.data.approvals) return result(state, [call("approvals", [true])]);
  return result({
    ...state,
    modal: {
      kind: "confirm",
      title: "Turn approvals off?",
      lines: [
        "Let your agents send messages, notes and diffs without asking you? What they send still passes Parley's checks: this project only, no secrets.",
      ],
      yesLabel: "Turn off",
      noLabel: "Keep on",
      effect: call("approvals", [false]),
      declined: "Approvals stay on.",
    },
  });
}

// Who the writing line goes to: everyone, or one approved member.
function chooseTo(state) {
  const options = [
    { label: "Everyone in the room", action: { do: "set-to", id: null } },
    ...people(state.data)
      .filter((p) => p.status === "approved")
      .map((p) => ({
        label: `${nameOf(p)}`,
        hint: p.state,
        action: { do: "set-to", id: p.id },
      })),
  ];
  const index = Math.max(
    0,
    options.findIndex((o) => o.action.id === state.to),
  );
  return result({
    ...state,
    modal: {
      kind: "choice",
      title: "Write to",
      lines: [
        "Only the one you choose gets it; the others' agents never see it.",
      ],
      options,
      index,
    },
  });
}

export const writeTo = (state, id) => ({
  ...select(state, "conv"),
  focus: "compose",
  to: id,
});

// The actions for the selection, for its Actions dialog and its keys.
export function itemActions(state, item = currentItem(state)) {
  if (item.kind === "member")
    return memberActions(personById(state.data, item.memberId));
  if (item.kind === "room")
    return [
      {
        key: "t",
        label: `Autonomy: ${state.data.autonomy === "work" ? "read only" : "work"}`,
        action: { do: "autonomy" },
      },
      {
        key: "p",
        label: `Approvals: ${state.data.approvals ? "off" : "on"}`,
        action: { do: "approvals" },
      },
      { key: "i", label: "Show invite", action: { do: "invite" } },
      { key: "c", label: "Copy invite", action: { do: "copy-invite" } },
    ];
  return [];
}

export function openActions(state, item = currentItem(state)) {
  const options = itemActions(state, item);
  if (!options.length) return null;
  const p =
    item.kind === "member" ? personById(state.data, item.memberId) : null;
  return result({
    ...state,
    modal: {
      kind: "actions",
      title: p ? nameOf(p) : "Room",
      lines: p ? [p.fingerprint] : [],
      options,
      index: 0,
    },
  });
}

// The help dialog's rows: [keys, what they do]; a row without keys is a
// heading, one without either a gap.
export const helpRows = (g) => [
  ["Keys", ""],
  [`${g.up} ${g.down}`, "move in the sidebar, choose in a pane, scroll"],
  [
    `${g.right} ${g.enter}`,
    "open: the pane, the writing line, a member's actions",
  ],
  [`${g.left} Esc`, "back to the sidebar; Esc there quits"],
  ["Tab", "the next section (Shift+Tab the one before)"],
  ["PgUp PgDn", "scroll a page; Home and End go to the top and the newest"],
  ["", ""],
  ["Writing", ""],
  [g.enter, "sends, as you: not your agent"],
  ["@name text", "to one member only"],
  ["Ctrl+T", "choose who it goes to"],
  ["Ctrl+U", "clear what is before the cursor"],
  ["", ""],
  ["Actions", ""],
  ["w a b", "on a member: write to them, approve, block"],
  ["t p", "in the room: autonomy, approvals"],
  ["i c", "show the invite, copy it"],
  ["?", "this help"],
  ["q Ctrl+C", "quit"],
  ["", ""],
  ["Mouse", ""],
  ["click", "select a row, press a button, a key in the footer"],
  ["wheel", "scroll the pane, or move in the sidebar"],
  ["", ""],
  ["What you write", ""],
  [
    "",
    "A message you write here is from you, not your agent: it goes through the same checks (the project's paths only, secrets refused), and the others' agents are told you typed it.",
  ],
];

export function perform(state, action) {
  if (!action) return result(state);
  switch (action.do) {
    case "select":
      return result({ ...select(state, action.id), focus: "pane" });
    case "write": {
      const p = personById(state.data, action.id);
      if (!p || p.status !== "approved")
        return result(toast(state, "Write to members who are in the room."));
      return result(writeTo(state, action.id));
    }
    case "set-to":
      return result({
        ...select(state, "conv"),
        focus: "compose",
        to: action.id,
      });
    case "to":
      return chooseTo(state);
    case "approve":
      return approve(state, action.id);
    case "trust":
      return trust(state, action.id);
    case "block":
      return block(state, action.id);
    case "autonomy":
      return autonomy(state);
    case "approvals":
      return approvals(state);
    case "invite":
      return result(state, [call("invite", [])]);
    case "copy-invite":
      return result(state, [call("copy", action.text ? [action.text] : [])]);
    case "help":
      return result({
        ...state,
        modal: { kind: "help", title: "Parley view", scroll: 0 },
      });
    case "actions":
      return openActions(state) ?? result(state);
    default:
      return result(state);
  }
}
