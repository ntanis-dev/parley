import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import {
  CLOSE,
  KeyGuard,
  LIMITS,
  ROOM_PATH_RE,
  RoomStore,
  onFrame,
} from "./core.js";

// The relay as a Node server: `parley relay`, and what the Docker image runs.
// One SQLite file holds every room. TLS is either here (--tls-cert and
// --tls-key), in front of it (Caddy, nginx, `tailscale serve`), or not needed
// because it only listens on this computer or a tailnet.

export const RELAY_DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  data: "parley-relay.db",
  maxRooms: 1000,
  maxSockets: 2000,
};

function sqlite(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  return {
    db,
    all: (sql, ...params) => db.prepare(sql).all(...params),
    run: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
  };
}

const plain = (res, status, text) => {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(text);
};

export function startRelay({
  host = RELAY_DEFAULTS.host,
  port = RELAY_DEFAULTS.port,
  data = RELAY_DEFAULTS.data,
  relayKey = "",
  tlsCert = null,
  tlsKey = null,
  maxRooms = RELAY_DEFAULTS.maxRooms,
  maxSockets = RELAY_DEFAULTS.maxSockets,
  trustProxy = false,
  guard = new KeyGuard(),
  log = () => {},
} = {}) {
  const sql = sqlite(data);
  const store = new RoomStore(sql);
  store.init();
  const rooms = new Map();
  let sockets = 0;
  // Who is connecting, for the relay key guard: the socket's address, or
  // behind a proxy of our own (trustProxy), the one it saw: the last entry of
  // X-Forwarded-For, which it appends and nobody before it can.
  const addressOf = (req) => {
    const forwarded = trustProxy
      ? String(req.headers["x-forwarded-for"] ?? "")
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .at(-1)
      : null;
    return forwarded || req.socket.remoteAddress || "";
  };

  const onRequest = (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD")
      return plain(res, 405, "Method not allowed\n");
    if (req.url === "/healthz") return plain(res, 200, "ok\n");
    if (req.url === "/")
      return plain(
        res,
        200,
        "Parley relay. It stores sealed messages it cannot read: https://github.com/ntanis-dev/parley\n",
      );
    return plain(res, 404, "Not found\n");
  };
  const server =
    tlsCert && tlsKey
      ? createHttpsServer(
          { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) },
          onRequest,
        )
      : createHttpServer(onRequest);
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.frame,
    perMessageDeflate: false,
  });

  server.on("upgrade", (req, socket, head) => {
    const match = ROOM_PATH_RE.exec(new URL(req.url, "http://relay").pathname);
    const reject = (status, text) => {
      socket.end(
        `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    };
    if (!match) return reject(404, "Not Found");
    const roomId = match[1];
    if (
      sockets >= maxSockets ||
      (rooms.get(roomId)?.size ?? 0) >= LIMITS.socketsPerRoom
    )
      return reject(503, "Service Unavailable");
    wss.handleUpgrade(req, socket, head, (ws) =>
      accept(ws, roomId, addressOf(req)),
    );
  });

  function accept(ws, roomId, address) {
    sockets++;
    const conn = {
      state: { roomId, authed: false, address },
      send: (frame) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const members = rooms.get(roomId);
    members.add(conn);
    let alive = true;
    const hello = setTimeout(() => {
      if (!conn.state.authed) conn.close(CLOSE.policy, "hello-timeout");
    }, LIMITS.helloMs);
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    // One frame at a time per connection, in order.
    let queue = Promise.resolve();
    ws.on("pong", () => (alive = true));
    ws.on("message", (data, binary) => {
      alive = true;
      if (binary) return conn.close(CLOSE.policy, "text-only");
      const text = data.toString("utf8");
      queue = queue
        .then(() =>
          onFrame(conn, text, {
            store,
            relayKey,
            maxRooms,
            guard,
            peers: () => [...members].filter((peer) => peer.state.authed),
          }),
        )
        .catch((error) => {
          log(`relay error: ${error?.message ?? error}`);
          conn.close(1011, "error");
        });
    });
    ws.on("close", () => {
      clearTimeout(hello);
      clearInterval(heartbeat);
      members.delete(conn);
      if (!members.size) rooms.delete(roomId);
      sockets--;
    });
    ws.on("error", () => {});
  }

  let closing = null;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        port: address.port,
        host,
        tls: Boolean(tlsCert && tlsKey),
        // Closing twice is fine: the second waits for the first.
        close: () =>
          (closing ??= new Promise((done) => {
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            server.close(() => {
              sql.db.close();
              done();
            });
          })),
      });
    });
  });
}
