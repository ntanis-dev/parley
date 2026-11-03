import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

// One connection to a room on a relay: hello, the backlog since the last
// cursor, then live messages; posts wait for the relay's ack. It reconnects
// on its own, backing off, and gives up only when the relay says the room
// token or relay key is wrong.

export class RelayError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Everything is sealed before it reaches the relay, but the room token and
// the timing of messages are not, so plain ws:// is accepted only on this
// computer and on a Tailscale tailnet (100.64.0.0/10), which encrypts by
// itself. Anywhere else the relay needs TLS (wss://).
export function relayUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new RelayError("bad-url", `Not a relay address: ${input}`);
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:")
    throw new RelayError(
      "bad-url",
      `A relay address starts with wss:// (or https://), not ${url.protocol}`,
    );
  if (url.username || url.password || url.search || url.hash)
    throw new RelayError(
      "bad-url",
      "A relay address has no user, password, query or fragment.",
    );
  if (url.protocol === "ws:" && !privateHost(url.hostname))
    throw new RelayError(
      "insecure",
      `ws://${url.hostname} is not encrypted. Use wss:// (TLS), or a relay on this computer or your tailnet.`,
    );
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function privateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split(".").map(Number);
  return a === 127 || (a === 100 && b >= 64 && b <= 127);
}

const FATAL = new Set(["auth", "relay-key", "bad-hello"]);

export class RoomConnection {
  constructor({
    relay,
    roomId,
    token,
    relayKey = "",
    cursor = 0,
    onMessage,
    onState = () => {},
    onSynced = () => {},
    WebSocketImpl = globalThis.WebSocket,
  }) {
    this.url = `${relayUrl(relay)}/v1/rooms/${roomId}`;
    this.token = token;
    this.relayKey = relayKey;
    this.cursor = cursor;
    this.onMessage = onMessage;
    this.onState = onState;
    this.onSynced = onSynced;
    this.WebSocket = WebSocketImpl;
    this.pending = new Map();
    this.state = "idle";
    this.attempt = 0;
    this.stopped = false;
  }

  setState(state, detail = null) {
    this.state = state;
    this.detail = detail;
    this.onState(state, detail);
  }

  start() {
    this.stopped = false;
    this.open();
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.keepalive);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new RelayError("closed", "The connection to the relay closed."));
    }
    this.pending.clear();
    try {
      this.ws?.close(1000, "bye");
    } catch {}
    this.setState("stopped");
  }

  open() {
    if (this.stopped) return;
    this.setState("connecting");
    let ws;
    try {
      ws = new this.WebSocket(this.url);
    } catch (error) {
      return this.later(error);
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          t: "hello",
          v: 1,
          token: this.token,
          after: this.cursor,
          key: this.relayKey || undefined,
        }),
      );
    });
    ws.addEventListener("message", (event) => this.frame(event.data));
    ws.addEventListener("close", () => {
      clearInterval(this.keepalive);
      if (this.ws === ws) this.later();
    });
    ws.addEventListener("error", () => {});
  }

  later(error = null) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new RelayError("closed", "The connection to the relay closed."));
    }
    this.pending.clear();
    if (this.stopped || this.state === "refused") return;
    const delay =
      Math.min(60_000, 1000 * 2 ** Math.min(this.attempt++, 6)) *
      (0.75 + Math.random() / 2);
    this.setState("waiting", error?.message ?? null);
    this.retry = setTimeout(() => this.open(), delay);
  }

  frame(data) {
    let frame;
    try {
      frame = JSON.parse(
        typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
      );
    } catch {
      return;
    }
    switch (frame?.t) {
      case "ready":
        this.attempt = 0;
        this.setState("connected", { created: Boolean(frame.created) });
        clearInterval(this.keepalive);
        this.keepalive = setInterval(() => this.send({ t: "ping" }), 25_000);
        return;
      case "msg":
        if (Number.isSafeInteger(frame.c) && typeof frame.blob === "string") {
          if (frame.c > this.cursor) this.cursor = frame.c;
          this.onMessage({ c: frame.c, at: frame.at, blob: frame.blob });
        }
        return;
      case "synced":
        if (frame.more) this.send({ t: "sync", after: this.cursor });
        else this.onSynced(this.cursor);
        return;
      case "ack": {
        const waiting = this.pending.get(frame.id);
        if (waiting) {
          clearTimeout(waiting.timer);
          this.pending.delete(frame.id);
          if (frame.c > this.cursor && frame.c === this.cursor + 1)
            this.cursor = frame.c;
          waiting.resolve({ c: frame.c, at: frame.at });
        }
        return;
      }
      case "error": {
        const error = new RelayError(
          frame.code,
          String(frame.message ?? frame.code),
        );
        const waiting = frame.id && this.pending.get(frame.id);
        if (waiting) {
          clearTimeout(waiting.timer);
          this.pending.delete(frame.id);
          waiting.reject(error);
        } else if (FATAL.has(frame.code)) {
          this.setState("refused", error.message);
        }
        return;
      }
    }
  }

  send(frame) {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  post(blob, timeoutMs = 20_000) {
    if (this.state !== "connected")
      return Promise.reject(
        new RelayError("offline", "Not connected to the relay right now."),
      );
    const id = randomBytes(9).toString("base64url");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RelayError("timeout", "The relay did not confirm the message."),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ t: "post", id, blob })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new RelayError("offline", "Not connected to the relay right now."),
        );
      }
    });
  }
}
