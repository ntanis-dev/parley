// `parley view` lives in src/view/: the room, live, in a terminal of its
// own. This is what the CLI and the tests use of it.
export {
  ViewApp,
  createView,
  entryLines,
  makeStore,
  runView,
  sayAsPerson,
  snapshot,
} from "./view/index.js";
