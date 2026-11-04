import { readLaunch } from "./sessions.js";

// `parley watch --launch <id>`: what the agent's Monitor runs. It connects to
// the launch's MCP server (its WebSocket on 127.0.0.1) and prints each batch
// of new content at once, so each batch is one Monitor event. It prints
// nothing else, and ends when the server does (the session ended); the agent
// arms it again when it ends or expires.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runWatch({
  paths,
  launchId,
  stdout = process.stdout,
  waitMs = 15_000,
  WebSocketImpl = globalThis.WebSocket,
}) {
  // The server opens its socket when Claude Code starts it; a watch armed
  // at the very start may wait a moment for it.
  const end = Date.now() + waitMs;
  let url = null;
  while (!(url = readLaunch(paths, launchId)?.watch)) {
    if (Date.now() > end) {
      stdout.write(
        "Parley's message watch is not available in this session (start Claude Code with `parley`).\n",
      );
      return 1;
    }
    await sleep(250);
  }
  return new Promise((resolve) => {
    const ws = new WebSocketImpl(url);
    ws.addEventListener("message", (event) => {
      const text = String(event.data).replace(/\r\n/g, "\n");
      stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    });
    ws.addEventListener("close", () => resolve(0));
    ws.addEventListener("error", () => {});
  });
}
