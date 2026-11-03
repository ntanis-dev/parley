import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CryptoError,
  decodeInvite,
  encodeInvite,
  fingerprint,
  memberId,
  newIdentity,
  newRoomSecret,
  openEnvelope,
  openOuter,
  roomKeys,
  sealEnvelope,
  sealOuter,
} from "../src/crypto.js";

const alice = newIdentity("Alice");
const bob = newIdentity("Bob");
const eve = newIdentity("Eve");
const { roomId, key } = roomKeys(newRoomSecret());
const to = (identity) => ({
  id: memberId(identity.sign.pub),
  box: identity.box.pub,
});

const sealed = (body = { text: "hi" }, recipients = [to(bob)]) =>
  sealEnvelope({ identity: alice, roomId, kind: "message", body, recipients });

test("a message opens for its recipient and says who sent it", () => {
  const envelope = openOuter(key, roomId, sealOuter(key, roomId, sealed()));
  const { head, body, forMe } = openEnvelope(envelope, {
    identity: bob,
    roomId,
  });
  assert.deepEqual(body, { text: "hi" });
  assert.equal(forMe, true);
  assert.equal(head.from, memberId(alice.sign.pub));
  assert.equal(head.name, "Alice");
});

test("someone it was not sealed for cannot read it", () => {
  const { body, forMe } = openEnvelope(sealed(), { identity: eve, roomId });
  assert.equal(body, null);
  assert.equal(forMe, false);
});

test("any change to a signed field is caught", () => {
  for (const [field, value] of [
    ["name", "Mallory"],
    ["at", Date.now() - 1000],
    ["kind", "note"],
    ["body", sealed({ text: "other" }).body],
  ]) {
    const envelope = { ...sealed(), [field]: value };
    assert.throws(
      () => openEnvelope(envelope, { identity: bob, roomId }),
      CryptoError,
      field,
    );
  }
});

test("a sender cannot claim someone else's id or keys", () => {
  const envelope = sealed();
  assert.throws(
    () =>
      openEnvelope(
        { ...envelope, from: memberId(eve.sign.pub) },
        { identity: bob, roomId },
      ),
    /sender id mismatch/,
  );
  assert.throws(
    () =>
      openEnvelope(
        { ...envelope, sign: eve.sign.pub, from: memberId(eve.sign.pub) },
        { identity: bob, roomId },
      ),
    /bad signature/,
  );
});

test("a wrap moved to another recipient does not open", () => {
  const envelope = sealed({ text: "x" }, [to(bob), to(eve)]);
  const swapped = {
    ...envelope,
    to: envelope.to.map((w) => ({
      ...w,
      k: envelope.to.find((x) => x !== w).k,
    })),
  };
  assert.throws(
    () => openEnvelope(swapped, { identity: bob, roomId }),
    CryptoError,
  );
});

test("another room's envelope and outer layer are refused", () => {
  const other = roomKeys(newRoomSecret());
  assert.throws(
    () => openEnvelope(sealed(), { identity: bob, roomId: other.roomId }),
    /malformed/,
  );
  assert.throws(
    () => openOuter(other.key, other.roomId, sealOuter(key, roomId, sealed())),
    CryptoError,
  );
});

test("a message dated far in the future is refused", () => {
  const envelope = sealEnvelope({
    identity: alice,
    roomId,
    kind: "message",
    body: { text: "later" },
    recipients: [to(bob)],
    now: Date.now() + 60 * 60 * 1000,
  });
  assert.throws(
    () => openEnvelope(envelope, { identity: bob, roomId }),
    /future/,
  );
});

test("invites round-trip and refuse damage", () => {
  const secret = newRoomSecret();
  const code = encodeInvite({
    relay: "wss://relay.example",
    secret,
    room: "shop",
    by: { name: "Alice", sign: alice.sign.pub, box: alice.box.pub },
  });
  const invite = decodeInvite(code);
  assert.deepEqual(invite.secret, secret);
  assert.equal(invite.by.name, "Alice");
  assert.throws(() => decodeInvite("hello"), /not a Parley invite/);
  assert.throws(() => decodeInvite(code.slice(0, -10)), CryptoError);
});

test("fingerprints are six groups and differ per person", () => {
  const a = fingerprint(alice.sign.pub, alice.box.pub);
  assert.match(a, /^([0-9A-F]{4} ){5}[0-9A-F]{4}$/);
  assert.notEqual(a, fingerprint(bob.sign.pub, bob.box.pub));
});
