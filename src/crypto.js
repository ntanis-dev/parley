import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

// Parley's cryptography, on Node's own primitives and nothing else: Ed25519
// signs, X25519 agrees keys, HKDF-SHA256 derives, ChaCha20-Poly1305 seals.
//
// A message has two layers:
// - The inner envelope is end to end. Its body is sealed with a fresh
//   content key, the content key is wrapped for each approved member against
//   a one-time X25519 key, and the whole envelope is signed with the sender's
//   Ed25519 key. Only the members it was wrapped for can read it, and the
//   signature says which member wrote it.
// - The outer layer seals the inner envelope with the room key, which comes
//   from the room secret in the invite. The relay sees sizes and times, not
//   who writes to whom.
//
// The room secret alone never reads a message: someone holding a leaked
// invite can knock (ask to join), and nothing more until a member approves.

export const VERSION = 1;
const SALT = Buffer.from("parley");
const B64U_RE = /^[A-Za-z0-9_-]*$/;

export const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

export function unb64u(text, length = null) {
  if (typeof text !== "string" || !B64U_RE.test(text))
    throw new CryptoError("not base64url");
  const bytes = Buffer.from(text, "base64url");
  if (length !== null && bytes.length !== length)
    throw new CryptoError(`expected ${length} bytes, got ${bytes.length}`);
  return bytes;
}

export class CryptoError extends Error {}

const utf8 = (text) => Buffer.from(text, "utf8");

export const sha256 = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts)
    hash.update(typeof part === "string" ? utf8(part) : part);
  return hash.digest();
};

export const hkdf = (ikm, info, length) =>
  Buffer.from(hkdfSync("sha256", ikm, SALT, utf8(info), length));

export function equalBytes(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---- Sealing ----------------------------------------------------------------

// nonce (12) | ciphertext | tag (16). Every key here is either fresh for one
// message or used for few enough messages that random nonces never repeat.
export function seal(key, plaintext, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(utf8(aad), { plaintextLength: plaintext.length });
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

export function open(key, sealed, aad) {
  if (sealed.length < 28) throw new CryptoError("sealed data too short");
  const nonce = sealed.subarray(0, 12);
  const tag = sealed.subarray(sealed.length - 16);
  const body = sealed.subarray(12, sealed.length - 16);
  try {
    const decipher = createDecipheriv("chacha20-poly1305", key, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(utf8(aad), { plaintextLength: body.length });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new CryptoError("could not be opened");
  }
}

// ---- Identities -------------------------------------------------------------

// Keys are kept as raw 32-byte values in base64url (a JWK's x and d).
const pair = (type) => {
  const { publicKey, privateKey } = generateKeyPairSync(type);
  const jwk = privateKey.export({ format: "jwk" });
  return { pub: publicKey.export({ format: "jwk" }).x, priv: jwk.d };
};

export function newIdentity(name, now = Date.now()) {
  return {
    v: VERSION,
    name,
    created: new Date(now).toISOString(),
    sign: pair("ed25519"),
    box: pair("x25519"),
  };
}

const CURVES = { sign: "Ed25519", box: "X25519" };
const publicKeyOf = (kind, x) =>
  createPublicKey({
    key: { kty: "OKP", crv: CURVES[kind], x: b64u(unb64u(x, 32)) },
    format: "jwk",
  });
const privateKeyOf = (kind, keys) =>
  createPrivateKey({
    key: { kty: "OKP", crv: CURVES[kind], x: keys.pub, d: keys.priv },
    format: "jwk",
  });

export function validIdentity(identity) {
  try {
    privateKeyOf("sign", identity.sign);
    privateKeyOf("box", identity.box);
    return typeof identity.name === "string" && identity.name.length > 0;
  } catch {
    return false;
  }
}

// A member is known by their signing key; the id is a short hash of it.
export const memberId = (signPub) =>
  b64u(sha256("parley/v1/member|", unb64u(signPub, 32)).subarray(0, 12));

// What two people read to each other to check they have the right keys:
// 96 bits of a hash of both public keys, in six groups.
export function fingerprint(signPub, boxPub) {
  const hex = sha256(
    "parley/v1/fingerprint|",
    unb64u(signPub, 32),
    unb64u(boxPub, 32),
  )
    .subarray(0, 12)
    .toString("hex")
    .toUpperCase();
  return hex.match(/.{4}/g).join(" ");
}

// ---- Rooms -------------------------------------------------------------------

export const newRoomSecret = () => randomBytes(32);

// Everything about a room comes from its secret. The id is the relay's
// address for it, the token proves to the relay that a client was invited,
// and the key seals the outer layer.
export function roomKeys(secret) {
  const ikm = Buffer.isBuffer(secret) ? secret : unb64u(secret, 32);
  return {
    roomId: b64u(hkdf(ikm, "parley/v1/room-id", 16)),
    token: b64u(hkdf(ikm, "parley/v1/relay-token", 32)),
    key: hkdf(ikm, "parley/v1/room-key", 32),
  };
}

const INVITE_PREFIX = "parley1:";

// `tags` say which project the room is for (project.js): keyed hashes of
// the repository's first commits.
export function encodeInvite({ relay, secret, room, by, tags = [] }) {
  return (
    INVITE_PREFIX +
    b64u(
      utf8(
        JSON.stringify({
          relay,
          secret: b64u(secret),
          room,
          by: { name: by.name, sign: by.sign, box: by.box },
          tags,
        }),
      ),
    )
  );
}

export function decodeInvite(code) {
  const text = String(code ?? "").trim();
  if (!text.startsWith(INVITE_PREFIX))
    throw new CryptoError("not a Parley invite (it starts with parley1:)");
  let invite;
  try {
    invite = JSON.parse(
      unb64u(text.slice(INVITE_PREFIX.length)).toString("utf8"),
    );
  } catch {
    throw new CryptoError("the invite is damaged; copy it again in one piece");
  }
  unb64u(invite?.secret, 32);
  unb64u(invite?.by?.sign, 32);
  unb64u(invite?.by?.box, 32);
  if (typeof invite.relay !== "string" || typeof invite.by.name !== "string")
    throw new CryptoError("the invite is incomplete");
  return {
    relay: invite.relay,
    secret: unb64u(invite.secret, 32),
    room: typeof invite.room === "string" ? invite.room : "",
    by: { name: invite.by.name, sign: invite.by.sign, box: invite.by.box },
    tags: Array.isArray(invite.tags)
      ? invite.tags
          .filter(
            (tag) => typeof tag === "string" && /^[A-Za-z0-9_-]{43}$/.test(tag),
          )
          .slice(0, 16)
      : [],
  };
}

// ---- Envelopes ---------------------------------------------------------------

// The kinds this version sends and reads; presence carries a member's
// Parley version. A kind a version does not know becomes a notice there.
export const KINDS = new Set([
  "join",
  "message",
  "diff",
  "note",
  "presence",
  "pulse",
  "file",
  "claim",
]);
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;

export class NewerFormat extends CryptoError {
  constructor(version, from) {
    super(`envelope format ${version} is newer than this Parley reads`);
    this.version = version;
    this.from = from;
  }
}
const NAME_MAX = 64;
// A clock may be off; a message from further ahead than this is refused.
const FUTURE_SKEW_MS = 10 * 60 * 1000;

// The bytes the signature covers: every field, in a fixed order.
const signed = (head) =>
  utf8(
    "parley/v1/sig|" +
      JSON.stringify([
        head.v,
        head.room,
        head.id,
        head.from,
        head.sign,
        head.box,
        head.name,
        head.at,
        head.kind,
        head.eph,
        head.to.map((wrap) => [wrap.to, wrap.k]),
        head.body,
      ]),
  );

const bodyAad = (roomId, id) => `parley/v1/body|${roomId}|${id}`;
const wrapAad = (roomId, id, to) => `parley/v1/wrap|${roomId}|${id}|${to}`;

function wrapKey(shared, ephPub, recipientBox) {
  // X25519 with a small-order public key gives all zeros; never use that.
  if (shared.every((byte) => byte === 0))
    throw new CryptoError("unusable key agreement");
  return hkdf(
    Buffer.concat([shared, unb64u(ephPub, 32), unb64u(recipientBox, 32)]),
    "parley/v1/wrap-key",
    32,
  );
}

// Seals `body` (any JSON value) for `recipients` ([{ id, box }]), signed by
// `identity`. A join carries no body: its point is the signed keys.
export function sealEnvelope({
  identity,
  roomId,
  kind,
  body = null,
  recipients = [],
  now = Date.now(),
}) {
  if (!KINDS.has(kind)) throw new CryptoError(`unknown kind ${kind}`);
  const id = b64u(randomBytes(16));
  const contentKey = randomBytes(32);
  const eph = generateKeyPairSync("x25519");
  const ephPub = eph.publicKey.export({ format: "jwk" }).x;
  const to = recipients.map((recipient) => {
    const shared = diffieHellman({
      privateKey: eph.privateKey,
      publicKey: publicKeyOf("box", recipient.box),
    });
    return {
      to: recipient.id,
      k: b64u(
        seal(
          wrapKey(shared, ephPub, recipient.box),
          contentKey,
          wrapAad(roomId, id, recipient.id),
        ),
      ),
    };
  });
  const head = {
    v: VERSION,
    room: roomId,
    id,
    from: memberId(identity.sign.pub),
    sign: identity.sign.pub,
    box: identity.box.pub,
    name: String(identity.name).slice(0, NAME_MAX),
    at: now,
    kind,
    eph: ephPub,
    to,
    body:
      body === null
        ? ""
        : b64u(
            seal(contentKey, utf8(JSON.stringify(body)), bodyAad(roomId, id)),
          ),
  };
  const signature = sign(
    null,
    signed(head),
    privateKeyOf("sign", identity.sign),
  );
  return { ...head, sig: b64u(signature) };
}

const isString = (value, max) =>
  typeof value === "string" && value.length <= max;

// Checks an envelope's shape and signature, and opens its body when it was
// wrapped for `identity`. Whether the sender may be listened to is the
// caller's call (rooms.js): this only proves who signed it.
//
// A kind this version does not know still has its signature checked and is
// returned as it is, so the caller can tell the person a member is ahead. An
// envelope of a newer format cannot even be checked: NewerFormat says so,
// with the sender id it claims.
export function openEnvelope(envelope, { identity, roomId, now = Date.now() }) {
  const e = envelope;
  if (e && Number.isSafeInteger(e.v) && e.v > VERSION)
    throw new NewerFormat(e.v, typeof e.from === "string" ? e.from : null);
  if (
    !e ||
    typeof e !== "object" ||
    e.v !== VERSION ||
    e.room !== roomId ||
    !isString(e.id, 32) ||
    !isString(e.name, NAME_MAX) ||
    !Number.isSafeInteger(e.at) ||
    !KIND_RE.test(e.kind ?? "") ||
    !Array.isArray(e.to) ||
    e.to.length > 64 ||
    !isString(e.body, 1 << 20) ||
    !isString(e.sig, 128)
  )
    throw new CryptoError("malformed envelope");
  unb64u(e.id, 16);
  unb64u(e.eph, 32);
  unb64u(e.box, 32);
  const signature = unb64u(e.sig, 64);
  if (e.from !== memberId(e.sign)) throw new CryptoError("sender id mismatch");
  for (const wrap of e.to)
    if (!wrap || !isString(wrap.to, 16) || !isString(wrap.k, 128))
      throw new CryptoError("malformed envelope");
  if (!verify(null, signed(e), publicKeyOf("sign", e.sign), signature))
    throw new CryptoError("bad signature");
  if (e.at > now + FUTURE_SKEW_MS) throw new CryptoError("dated in the future");

  const head = {
    id: e.id,
    from: e.from,
    name: e.name,
    sign: e.sign,
    box: e.box,
    at: e.at,
    kind: e.kind,
  };
  const me = memberId(identity.sign.pub);
  const mine = e.to.find((wrap) => wrap.to === me);
  if (!mine || !e.body) return { head, body: null, forMe: Boolean(mine) };
  const shared = diffieHellman({
    privateKey: privateKeyOf("box", identity.box),
    publicKey: publicKeyOf("box", e.eph),
  });
  const contentKey = open(
    wrapKey(shared, e.eph, identity.box.pub),
    unb64u(mine.k),
    wrapAad(roomId, e.id, me),
  );
  const body = JSON.parse(
    open(contentKey, unb64u(e.body), bodyAad(roomId, e.id)).toString("utf8"),
  );
  return { head, body, forMe: true };
}

const outerAad = (roomId) => `parley/v1/outer|${roomId}`;

export const sealOuter = (roomKey, roomId, envelope) =>
  b64u(seal(roomKey, utf8(JSON.stringify(envelope)), outerAad(roomId)));

export function openOuter(roomKey, roomId, blob) {
  const text = open(roomKey, unb64u(blob), outerAad(roomId)).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new CryptoError("malformed envelope");
  }
}
