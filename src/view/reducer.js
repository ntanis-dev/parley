import { tooSmall } from "./layout.js";
import {
  editField,
  insertText,
  modalKeys,
  modalText,
  scrollModal,
} from "./modal.js";
import { hitTest } from "./mouse.js";
import { itemActions, openActions, perform } from "./actions.js";
import { currentItem, paneBox, paneModel, reveal, scrollPane } from "./pane.js";
import { recipient } from "./conversation.js";
import {
  SECTIONS,
  call,
  expireToasts,
  quit,
  result,
  sectionOf,
  toast,
} from "./state.js";
import { moveSelection, reselect, select, selectedRow } from "./tree.js";

// Key handling as a reducer: reduce(state, action) -> { state, effects }.
// Actions: { type: "key", key }, "text" (several characters at once),
// "paste", "mouse", "data" (a fresh snapshot), "tick", "resize" and
// "called" (the answer to an effect's call). Effects are data the runtime
// carries out (store.js): call, quit, redraw.
//
// The keys go to what has the focus. The sidebar: up and down move, right
// opens (a node, else the pane), left closes or goes to the parent, Enter
// acts, Esc quits. A pane: up and down choose among its controls or scroll,
// Enter presses, left or Esc go back. The writing line: text, Enter sends,
// up and down scroll the conversation, Esc clears and then goes back. Tab
// goes through the sections from anywhere.
export function reduce(state, action) {
  const now = action.now ?? Date.now();
  if (now !== state.now) state = { ...state, now };
  switch (action.type) {
    case "key":
      return onKey(state, action.key);
    case "text":
    case "paste":
      return onText(state, action.text, action.type === "paste");
    case "mouse":
      return onMouse(state, action);
    case "data":
      return result(
        seeing(reselect(expireToasts({ ...state, data: action.data }))),
      );
    case "tick":
      return result(expireToasts(state));
    case "resize":
      return result(
        { ...state, size: { cols: action.cols, rows: action.rows } },
        [{ type: "redraw" }],
      );
    case "called":
      return onCalled(state, action);
    default:
      return result(state);
  }
}

// The conversation shown counts as read up to its newest entry.
function seeing(state) {
  if (state.selected !== "conv") return state;
  const last = state.data.log?.at(-1)?.id ?? null;
  return last === state.seen ? state : { ...state, seen: last };
}
const settle = (out) => ({ ...out, state: seeing(out.state) });

// Several characters at once: a paste, or typing faster than a frame. In
// the writing line a paste keeps its lines; typed text is sent at each
// Enter in it, as the keys would have.
function onText(state, text, pasted) {
  if (state.modal) return modalText(state, text) ?? result(state);
  if (state.focus === "compose") {
    if (pasted)
      return result({
        ...state,
        draft: insertText(state.draft, text, { multiline: true }),
      });
    let out = result(state);
    const effects = [];
    String(text)
      .split(/\r\n?|\n/)
      .forEach((part, i) => {
        if (i) {
          out = send(out.state);
          effects.push(...out.effects);
        }
        out = result({
          ...out.state,
          draft: insertText(out.state.draft, part),
        });
      });
    return result(out.state, effects);
  }
  if (pasted) return result(state);
  let out = result(state);
  const effects = [];
  for (const ch of String(text)) {
    out = onKey(out.state, ch === "\r" || ch === "\n" ? "enter" : ch);
    effects.push(...out.effects);
  }
  return result(out.state, effects);
}

function onKey(state, key) {
  if (key === null || key === undefined) return result(state);
  if (key === "ctrl+c") return result(state, [quit]);
  if (key === "ctrl+l") return result(state, [{ type: "redraw" }]);
  if (tooSmall(state))
    return result(state, key === "q" || key === "escape" ? [quit] : []);
  if (state.modal) return settle(modalKeys(state, key));
  if (key === "tab" || key === "shift+tab")
    return settle(result(nextSection(state, key === "tab" ? 1 : -1)));
  const own =
    state.focus === "compose"
      ? composeKeys(state, key)
      : state.focus === "pane"
        ? paneKeys(state, key)
        : sideKeys(state, key);
  return settle(own ?? globalKeys(state, key));
}

// The next section (Tab) or the one before; the conversation's writing line
// takes the keys there, a section's row elsewhere.
function nextSection(state, step) {
  const at = SECTIONS.indexOf(sectionOf(state.selected));
  const id = SECTIONS[(at + step + SECTIONS.length) % SECTIONS.length];
  return { ...select(state, id), focus: id === "conv" ? "compose" : "side" };
}

function setOpen(state, node, open) {
  const next = { ...state, open: { ...state.open, [node]: open } };
  // A closed node takes the selection from the row beneath it.
  return !open && sectionOf(state.selected) === node
    ? select(next, node)
    : next;
}

// The pane takes the keys: the writing line in the conversation.
const intoPane = (state) =>
  currentItem(state).kind === "conv"
    ? { ...state, focus: "compose" }
    : { ...state, focus: "pane" };

function sideKeys(state, key) {
  const row = selectedRow(state);
  const item = currentItem(state);
  switch (key) {
    case "up":
      return result(moveSelection(state, -1));
    case "down":
      return result(moveSelection(state, 1));
    case "home":
      return result(moveSelection(state, "first"));
    case "end":
      return result(moveSelection(state, "last"));
    case "pageup":
    case "pagedown":
      return result(scrollCurrent(state, key));
    case "right":
      if (row?.node && !row.open) return result(setOpen(state, row.id, true));
      return result(intoPane(state));
    case "left":
      if (row?.node && row.open) return result(setOpen(state, row.id, false));
      return result(row?.parent ? select(state, row.parent) : state);
    case "enter":
    case " ":
      if (item.kind === "member" || item.kind === "room")
        return openActions(state, item) ?? result(intoPane(state));
      return result(intoPane(state));
    case "escape":
      return result(state, [quit]);
    default:
      return itemKeys(state, key);
  }
}

function scrollCurrent(state, key) {
  const box = paneBox(state);
  return (
    scrollPane(state, key, paneModel(state, currentItem(state), box), box) ??
    state
  );
}

// The control marked in a pane, moved by `step`, scrolled into view.
function movePick(state, model, box, step) {
  const count = model.controls.length;
  const at = Math.min(state.picks[model.viewKey] ?? 0, count - 1);
  const to =
    step === "first"
      ? 0
      : step === "last"
        ? count - 1
        : Math.max(0, Math.min(count - 1, at + step));
  const next = { ...state, picks: { ...state.picks, [model.viewKey]: to } };
  const c = model.controls[to];
  return reveal(next, model, box, c.line, c.size);
}

function paneKeys(state, key) {
  const item = currentItem(state);
  const box = paneBox(state);
  const model = paneModel(state, item, box);
  const controls = model.controls.length;
  if (controls && ["up", "down", "home", "end"].includes(key)) {
    const step = { up: -1, down: 1, home: "first", end: "last" }[key];
    return result(movePick(state, model, box, step));
  }
  if (key === "enter" || key === " ") {
    if (!controls) return result(state);
    const pick = Math.min(state.picks[model.viewKey] ?? 0, controls - 1);
    return perform(state, model.controls[pick].action);
  }
  const scrolled = scrollPane(state, key, model, box);
  if (scrolled) return result(scrolled);
  if (key === "left" || key === "escape")
    return result({ ...state, focus: "side" });
  return itemKeys(state, key);
}

function composeKeys(state, key) {
  const draft = state.draft;
  switch (key) {
    case "enter":
      return send(state);
    case "escape":
      if (draft.value)
        return result({ ...state, draft: { value: "", cursor: 0 } });
      return result({ ...state, focus: "side" });
    case "left":
      if ((draft.cursor ?? 0) === 0) return result({ ...state, focus: "side" });
      break;
    case "up":
    case "down":
    case "pageup":
    case "pagedown":
      return result(scrollCurrent(state, key));
    case "home":
    case "end":
      if (!draft.value) return result(scrollCurrent(state, key));
      break;
    case "ctrl+t":
      return perform(state, { do: "to" });
    default:
      break;
  }
  const edited = editField(draft, key);
  if (edited)
    return result({
      ...state,
      draft: { ...edited, value: edited.value.slice(0, 4000) },
    });
  return result(state);
}

// Enter in the writing line: "@name text" goes to that member, else to the
// one chosen, else to the room.
function send(state) {
  const text = state.draft.value.trim();
  if (!text) return result(state);
  const to = recipient(state);
  const typed = /^@(\S+)\s+([\s\S]+)$/.exec(text);
  const body = typed ? typed[2].trim() : text;
  const names = typed ? [typed[1]] : to?.person ? [to.person.name] : [];
  return result({ ...state, draft: { value: "", cursor: 0 } }, [
    call("say", [body, names], { draft: state.draft.value }),
  ]);
}

// The selection's own keys (w a b on a member, t p in the room) and the
// ones that work from anywhere but the writing line.
function itemKeys(state, key) {
  const action = itemActions(state).find((a) => a.key === key);
  if (action) return perform(state, action.action);
  return null;
}

function globalKeys(state, key) {
  switch (key) {
    case "q":
      return result(state, [quit]);
    case "?":
      return perform(state, { do: "help" });
    case "i":
      return perform(state, { do: "invite" });
    case "c":
      return perform(state, { do: "copy-invite" });
    default:
      return result(state);
  }
}

function onMouse(state, event) {
  const target = hitTest(state, event);
  if (!target) return result(state);
  if (target.toast !== undefined)
    return result({
      ...state,
      toasts: state.toasts.filter((t) => t.id !== target.toast),
    });
  if (target.modalScroll !== undefined) {
    const modal = state.modal;
    if (modal.kind === "actions" || modal.kind === "choice")
      return modalKeys(state, target.modalScroll > 0 ? "down" : "up");
    return result(scrollModal(state, Math.sign(target.modalScroll) * 2));
  }
  if (target.option !== undefined)
    return settle(
      modalKeys(
        { ...state, modal: { ...state.modal, index: target.option } },
        "enter",
      ),
    );
  if (target.go)
    return settle(
      result({
        ...select(state, target.go),
        focus: target.go === "conv" ? "compose" : "side",
        open: target.go.startsWith("member:")
          ? { ...state.open, members: true }
          : state.open,
      }),
    );
  if (target.select) {
    const row = selectedRow({ ...state, selected: target.select });
    if (target.fold && row?.node)
      return settle(result(setOpen(state, row.id, !row.open)));
    const next = select(state, target.select);
    return settle(
      result({ ...next, focus: target.select === "conv" ? "compose" : "side" }),
    );
  }
  if (target.sideScroll)
    return settle(
      result(moveSelection({ ...state, focus: "side" }, target.sideScroll)),
    );
  if (target.paneScroll) {
    const box = paneBox(state);
    const model = paneModel(state, currentItem(state), box);
    return result(scrollPane(state, target.paneScroll, model, box) ?? state);
  }
  if (target.chooseTo)
    return perform({ ...state, focus: "compose" }, { do: "to" });
  if (target.compose) return result({ ...state, focus: "compose" });
  if (target.control !== undefined) {
    const model = paneModel(state);
    const control = model.controls[target.control];
    const focused = {
      ...state,
      focus: "pane",
      picks: { ...state.picks, [model.viewKey]: target.control },
    };
    return settle(control ? perform(focused, control.action) : result(focused));
  }
  if (target.focusPane) return result(intoPane(state));
  if (target.command) return onKey(state, target.command);
  return result(state);
}

// What came back from an effect's call: a toast, and for the invite its
// dialog. A message that could not be sent goes back into the writing line.
function onCalled(state, { effect, result: value, error }) {
  if (error) {
    let next = toast(state, error.message ?? String(error), "error");
    if (effect.name === "say" && !next.draft.value && effect.draft)
      next = {
        ...next,
        draft: { value: effect.draft, cursor: [...effect.draft].length },
      };
    return result(next);
  }
  switch (effect.name) {
    case "say":
      return result(toast(state, value || "Sent.", "ok"));
    case "invite":
      return result({
        ...state,
        modal: {
          kind: "invite",
          title: `Invite to ${state.data.room.name}`,
          code: value,
        },
      });
    case "approve": {
      let next = toast(state, `${effect.person} is in.`, "ok");
      if (value && value.announced === false)
        next = toast(
          next,
          `Could not tell the room yet (${value.error ?? "no answer"}); it learns when you next write.`,
          "info",
        );
      return result(next);
    }
    case "block":
      return result(toast(state, `Blocked ${effect.person}.`, "ok"));
    case "autonomy":
      return result(
        toast(
          state,
          effect.args[0] === "work"
            ? "Autonomy is work: woken turns may keep the project in step."
            : "Autonomy is read: woken turns only read and talk.",
          "ok",
        ),
      );
    case "approvals":
      return result(
        toast(
          state,
          effect.args[0]
            ? "Approvals are on: each send waits for your yes."
            : "Approvals are off: your agents send on their own.",
          "ok",
        ),
      );
    case "copy":
      return result(toast(state, value || "Copied the invite.", "ok"));
    default:
      return result(state);
  }
}
