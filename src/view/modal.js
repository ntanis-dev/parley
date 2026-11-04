import { printable } from "./keys.js";
import { result, toast } from "./state.js";
import { perform } from "./actions.js";
import { modalLayout } from "./overlays.js";

// Dialogs over the view: confirm (yes or no), typed (type a word, for
// letting someone in and for widening autonomy), actions (what can be done
// with the selection), choice (who to write to), invite (the room's
// invite, to copy) and help. Each holds what it leads to as data: an
// effect for the runtime, or an action (actions.js) for the next step.
const close = (state) => ({ ...state, modal: null });

// A text field's editing keys: { value, cursor } -> the edited field, or
// null when the key is not an editing key. The compose line uses them too.
export function editField(field, key) {
  const chars = [...field.value];
  let cursor = Math.min(field.cursor ?? chars.length, chars.length);
  if (printable(key)) {
    chars.splice(cursor, 0, key);
    cursor++;
  } else if (key === "backspace" && cursor > 0) {
    chars.splice(cursor - 1, 1);
    cursor--;
  } else if (key === "delete") chars.splice(cursor, 1);
  else if (key === "left") cursor = Math.max(0, cursor - 1);
  else if (key === "right") cursor = Math.min(chars.length, cursor + 1);
  else if (key === "home") cursor = 0;
  else if (key === "end") cursor = chars.length;
  else if (key === "ctrl+u") {
    chars.splice(0, cursor);
    cursor = 0;
  } else if (key === "ctrl+w") {
    let from = cursor;
    while (from > 0 && chars[from - 1] === " ") from--;
    while (from > 0 && chars[from - 1] !== " ") from--;
    chars.splice(from, cursor - from);
    cursor = from;
  } else return null;
  return { ...field, value: chars.join(""), cursor };
}

// Text typed or pasted at once, at the cursor. Fields of one line turn
// newlines into spaces.
export function insertText(
  field,
  text,
  { multiline = false, max = 4000 } = {},
) {
  let clean = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!multiline) clean = clean.replace(/\n+/g, " ");
  clean = clean.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const chars = [...field.value];
  const cursor = Math.min(field.cursor ?? chars.length, chars.length);
  const added = [...clean].slice(0, Math.max(0, max - chars.length));
  chars.splice(cursor, 0, ...added);
  return { ...field, value: chars.join(""), cursor: cursor + added.length };
}

// What the dialog leads to, once said yes to.
const go = (state, modal) =>
  modal.next
    ? perform(close(state), modal.next)
    : result(close(state), modal.effect ? [modal.effect] : []);

// Pasted (or quickly typed) text lands in the open field.
export function modalText(state, text) {
  const modal = state.modal;
  if (modal.kind === "typed")
    return result({ ...state, modal: insertText(modal, text, { max: 200 }) });
  return null;
}

const step = (index, count, by) => (index + by + count) % count;

// A dialog's text scrolled by `by` lines, within what it has.
export function scrollModal(state, by) {
  const { offset, max } = modalLayout(state);
  const scroll = Math.max(0, Math.min(max, offset + by));
  return { ...state, modal: { ...state.modal, scroll } };
}

export function modalKeys(state, key) {
  const modal = state.modal;
  switch (modal.kind) {
    case "confirm": {
      // Two buttons; Enter presses the focused one (No unless the dialog
      // says otherwise), y and n press theirs.
      const yes = modal.focus ? modal.focus === "yes" : Boolean(modal.yes);
      if (key === "y" || (key === "enter" && yes)) return go(state, modal);
      if (["n", "escape", "enter"].includes(key))
        return result(
          modal.declined ? toast(close(state), modal.declined) : close(state),
        );
      if (["left", "right", "tab", "shift+tab"].includes(key))
        return result({
          ...state,
          modal: { ...modal, focus: yes ? "no" : "yes" },
        });
      return result(state);
    }
    case "typed": {
      if (key === "escape")
        return result(
          modal.declined ? toast(close(state), modal.declined) : close(state),
        );
      if (key === "enter")
        return modal.value.trim().toLowerCase() === modal.word.toLowerCase()
          ? go(state, modal)
          : result(
              toast(
                close(state),
                `${modal.refused ?? "Not confirmed"} (you typed "${modal.value.trim()}").`,
              ),
            );
      const edited = editField(modal, key);
      return result(edited ? { ...state, modal: edited } : state);
    }
    case "actions": {
      if (key === "escape") return result(close(state));
      if (key === "up" || key === "down")
        return result({
          ...state,
          modal: {
            ...modal,
            index: step(
              modal.index,
              modal.options.length,
              key === "up" ? -1 : 1,
            ),
          },
        });
      const option =
        key === "enter"
          ? modal.options[modal.index]
          : modal.options.find((o) => o.key === key);
      return option ? perform(close(state), option.action) : result(state);
    }
    case "choice": {
      if (key === "escape") return result(close(state));
      const count = modal.options.length;
      if (key === "up" || key === "down")
        return result({
          ...state,
          modal: {
            ...modal,
            index: step(modal.index, count, key === "up" ? -1 : 1),
          },
        });
      if (/^[1-9]$/.test(key) && Number(key) <= count)
        return perform(close(state), modal.options[Number(key) - 1].action);
      if (key === "enter")
        return perform(close(state), modal.options[modal.index].action);
      return result(state);
    }
    case "invite": {
      if (key === "c" || key === "y")
        return perform(close(state), { do: "copy-invite", text: modal.code });
      if (["escape", "enter", "q", "i"].includes(key))
        return result(close(state));
      return result(state);
    }
    case "help": {
      const by = { up: -1, down: 1, pageup: -8, pagedown: 8 }[key];
      if (by) return result(scrollModal(state, by));
      if (["escape", "enter", "?", "q"].includes(key))
        return result(close(state));
      return result(state);
    }
    default:
      return result(close(state));
  }
}
