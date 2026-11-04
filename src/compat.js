import {
  ENVELOPE,
  UPDATE_HINT,
  VERSION,
  WIRE,
  compareVersions,
  isVersion,
  validRange,
} from "./version.js";
import { KINDS } from "./crypto.js";

// What the room knows about the versions around it, kept in room.json:
//   versions.relay           { app, wire, at }
//   versions.members[id]     { app, envelope, at, unknownKinds, newerFormat }
//                            from their presence messages, and from what
//                            they sent that this version could not read
//   announced                { app, members }: the version this person last
//                            announced, and to whom
// and the notices that tell the person who is behind.

export const presenceBody = () => ({
  app: VERSION,
  envelope: ENVELOPE,
  wire: WIRE,
});

export function validPresence(body) {
  if (!body || !isVersion(body.app) || !validRange(body.envelope)) return null;
  return {
    app: String(body.app).slice(0, 32),
    envelope: { min: body.envelope.min, max: body.envelope.max },
  };
}

const approvedIds = (room) =>
  Object.entries(room.members)
    .filter(([, m]) => m.status === "approved")
    .map(([id]) => id)
    .sort();

// This person's version is news to the room when it changed, or when
// someone was let in since it was last said.
export function presenceDue(room) {
  const ids = approvedIds(room);
  return (
    ids.length > 0 &&
    (room.announced?.app !== VERSION ||
      JSON.stringify(room.announced?.members ?? []) !== JSON.stringify(ids))
  );
}

export function markAnnounced(room, now = Date.now()) {
  room.announced = { app: VERSION, members: approvedIds(room), at: now };
}

export function recordRelay(room, relay, now = Date.now()) {
  room.versions ??= {};
  room.versions.relay = {
    app: typeof relay?.app === "string" ? relay.app.slice(0, 32) : null,
    wire: validRange(relay?.wire) ? relay.wire : null,
    at: now,
  };
}

export function recordMember(room, id, change) {
  room.versions ??= {};
  room.versions.members ??= {};
  const entry = (room.versions.members[id] ??= {});
  change(entry);
}

// One line per thing the person should know: who runs a newer Parley than
// theirs (they should update), who runs an older one (they could ask).
export function notices(room) {
  const out = [];
  const relay = room.versions?.relay;
  if (relay?.app) {
    const order = compareVersions(relay.app, VERSION);
    if (order < 0)
      out.push(
        `The relay runs Parley ${relay.app}, older than yours (${VERSION}); everything works, and its host can update it.`,
      );
    else if (order > 0)
      out.push(
        `The relay runs Parley ${relay.app}, newer than yours (${VERSION}): ${UPDATE_HINT}.`,
      );
  }
  for (const [id, member] of Object.entries(room.members)) {
    if (member.status !== "approved") continue;
    const seen = room.versions?.members?.[id];
    if (!seen) continue;
    // What this version still cannot read (an update clears these).
    const unknown = (seen.unknownKinds ?? []).filter((k) => !KINDS.has(k));
    const newerFormat = seen.newerFormat > ENVELOPE.max;
    const newer =
      newerFormat ||
      unknown.length ||
      (seen.app && compareVersions(seen.app, VERSION) > 0);
    if (newer) {
      const what = unknown.length
        ? ` and sent things yours cannot read (${unknown.join(", ")})`
        : newerFormat
          ? " and writes messages yours cannot read"
          : "";
      out.push(
        `${member.name} uses ${seen.app ? `Parley ${seen.app}` : "a newer Parley"}, newer than yours (${VERSION})${what}: ${UPDATE_HINT}.`,
      );
    } else if (seen.app && compareVersions(seen.app, VERSION) < 0)
      out.push(
        `${member.name} uses Parley ${seen.app}, older than yours (${VERSION}); everything works, and they can update.`,
      );
  }
  return out;
}

// Every member's version as far as this person knows, for `parley status`.
export function memberVersions(room) {
  return Object.entries(room.members)
    .filter(([, m]) => m.status === "approved")
    .map(([id, m]) => ({
      name: m.name,
      app: room.versions?.members?.[id]?.app ?? null,
    }));
}
