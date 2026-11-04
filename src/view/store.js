import { reduce } from "./reducer.js";
import { initialState } from "./state.js";

// The view's state and what carries out the reducer's effects: calls to
// `actions` (sending, approving, blocking, the settings, the invite),
// quitting and drawing again. `data` is the snapshot store (makeStore): a
// fresh snapshot goes into the state as it comes.
export function createView({
  data,
  actions,
  size = { cols: 100, rows: 30 },
  color = true,
  glyphs = "rich",
  now = Date.now,
  onQuit = () => {},
  onRedraw = () => {},
}) {
  let state = initialState({
    data: data.get(),
    size,
    color,
    glyphs,
    now: now(),
  });
  let closed = false;
  const listeners = new Set();
  function dispatch(action) {
    if (closed) return;
    const out = reduce(state, { now: now(), ...action });
    if (out.state !== state) {
      state = out.state;
      for (const listener of listeners) listener();
    }
    for (const effect of out.effects) perform(effect);
  }
  function perform(effect) {
    switch (effect.type) {
      case "quit":
        return onQuit();
      case "redraw":
        return onRedraw();
      case "call": {
        const run = actions?.[effect.name];
        if (!run)
          return dispatch({
            type: "called",
            effect,
            error: { message: "The view cannot do that here." },
          });
        return void Promise.resolve()
          .then(() => run(...effect.args))
          .then(
            (value) => dispatch({ type: "called", effect, result: value }),
            (error) =>
              dispatch({
                type: "called",
                effect,
                error: { message: error?.message ?? String(error) },
              }),
          );
      }
      default:
        return undefined;
    }
  }
  const unsubscribe = data.subscribe(() =>
    dispatch({ type: "data", data: data.get() }),
  );
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    close() {
      closed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
