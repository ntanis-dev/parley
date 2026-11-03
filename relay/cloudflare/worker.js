import { DurableObject } from "cloudflare:workers";
import {
  CLOSE,
  LIMITS,
  ROOM_PATH_RE,
  RoomStore,
  onFrame,
} from "../../src/relay/core.js";

// The relay as a Cloudflare Worker: one Durable Object per room, with its own
// SQLite storage, and hibernating WebSockets so an idle room costs nothing.
// The logic is the same as the Node relay's (src/relay/core.js). Set a relay
// key with `npx wrangler secret put PARLEY_RELAY_KEY` so only people you
// give it to can open rooms on your relay.

const plain = (status, text) =>
  new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return plain(200, "ok\n");
    if (url.pathname === "/")
      return plain(
        200,
        "Parley relay. It stores sealed messages it cannot read: https://github.com/ntanis-dev/parley\n",
      );
    const match = ROOM_PATH_RE.exec(url.pathname);
    if (!match) return plain(404, "Not found\n");
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return plain(426, "Expected a WebSocket\n");
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  },
};

const sqlOf = (sql) => ({
  all: (query, ...params) => sql.exec(query, ...params).toArray(),
  run: (query, ...params) => {
    sql.exec(query, ...params);
  },
});

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new RoomStore(sqlOf(ctx.storage.sql));
    this.store.init();
  }

  conn(ws) {
    return {
      ws,
      state: ws.deserializeAttachment() ?? { authed: false },
      send: (frame) => {
        try {
          ws.send(JSON.stringify(frame));
        } catch {}
      },
      close: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {}
      },
    };
  }

  async fetch(request) {
    const roomId = ROOM_PATH_RE.exec(new URL(request.url).pathname)?.[1];
    if (!roomId) return plain(404, "Not found\n");
    if (this.ctx.getWebSockets().length >= LIMITS.socketsPerRoom)
      return plain(503, "Room busy\n");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ roomId, authed: false, opened: Date.now() });
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + LIMITS.helloMs);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const conn = this.conn(ws);
    if (typeof message !== "string")
      return conn.close(CLOSE.policy, "text-only");
    await onFrame(conn, message, {
      store: this.store,
      relayKey: this.env.PARLEY_RELAY_KEY ?? "",
      peers: () =>
        this.ctx
          .getWebSockets()
          .map((other) => this.conn(other))
          .filter((other) => other.state.authed && other.ws !== ws),
    });
    try {
      ws.serializeAttachment(conn.state);
    } catch {}
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {}
  }

  async webSocketError() {}

  // Closes connections that never said hello, and keeps the room tidy.
  async alarm() {
    const now = Date.now();
    let waiting = false;
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() ?? {};
      if (state.authed) continue;
      if (now - (state.opened ?? 0) >= LIMITS.helloMs)
        this.conn(ws).close(CLOSE.policy, "hello-timeout");
      else waiting = true;
    }
    const roomId = this.ctx
      .getWebSockets()
      .map((ws) => ws.deserializeAttachment()?.roomId)
      .find(Boolean);
    if (roomId) this.store.prune(roomId, now);
    this.store.forgetIdle(now);
    if (waiting) await this.ctx.storage.setAlarm(now + LIMITS.helloMs);
  }
}
