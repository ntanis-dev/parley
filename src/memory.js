import { readLog } from "./rooms.js";

// What the room's log adds up to, beyond single messages.
//
// Shared memory: notes keyed by a topic. The newest note on a topic is what
// the room knows about it; a note marked forgotten takes the topic away.
// Notes from before topics existed are each their own topic.
//
// Claims: "I am working on these paths until then", from anyone. The newest
// claim per member and path counts; a claim that has run out, or was
// released (until in the past), does not.

export const TOPIC_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,59}$/u;
export const CLAIM_MAX_MINUTES = 8 * 60;

export const topicOf = (entry) =>
  typeof entry.topic === "string" && entry.topic ? entry.topic : entry.id;

// The room's memory: the newest note per topic, newest first.
export function sharedMemory(paths, roomId) {
  const latest = new Map();
  for (const entry of readLog(paths, roomId)) {
    if (entry.kind !== "note") continue;
    const key = topicOf(entry).toLowerCase();
    const seen = latest.get(key);
    if (!seen || entry.at >= seen.at) latest.set(key, entry);
  }
  return [...latest.values()]
    .filter((entry) => !entry.forgotten)
    .sort((a, b) => b.at - a.at);
}

// A few lines for a new session's context: the room's memory, newest first,
// at most `max` characters.
export function memoryDigest(paths, room, max = 3000) {
  const notes = sharedMemory(paths, room.roomId);
  if (!notes.length) return "";
  const lines = [];
  let size = 0;
  for (const note of notes) {
    const who = note.own ? "you" : note.name;
    const line = `- ${topicOf(note)}: ${note.text.replace(/\s+/g, " ").slice(0, 400)} (${who}, ${new Date(note.at).toISOString().slice(0, 10)})`;
    if (size + line.length > max) {
      lines.push(
        `- and ${notes.length - lines.length} more: use the notes tool.`,
      );
      break;
    }
    lines.push(line);
    size += line.length;
  }
  return `The room's shared memory (what members recorded with remember; the notes tool has it all):\n${lines.join("\n")}`;
}

// Claims still running: [{ member, name, own, path, note, until }].
export function activeClaims(paths, roomId, now = Date.now()) {
  const latest = new Map();
  for (const entry of readLog(paths, roomId)) {
    if (entry.kind !== "claim") continue;
    for (const path of entry.paths ?? []) {
      const key = `${entry.from}|${path}`;
      const seen = latest.get(key);
      if (!seen || entry.at >= seen.entry.at) latest.set(key, { entry, path });
    }
  }
  return [...latest.values()]
    .filter(({ entry }) => entry.until > now)
    .map(({ entry, path }) => ({
      member: entry.from,
      name: entry.own ? "you" : entry.name,
      own: Boolean(entry.own),
      path,
      note: entry.note ?? "",
      until: entry.until,
    }));
}

// Another member's claim over project-relative `rel` (the path itself or a
// folder above it), or null.
export function claimOver(claims, rel) {
  return (
    claims.find(
      (c) =>
        !c.own &&
        (c.path === "." || rel === c.path || rel.startsWith(`${c.path}/`)),
    ) ?? null
  );
}

const clock = (at) => new Date(at).toISOString().slice(11, 16) + " UTC";

export const describeClaim = (c) =>
  `${c.name} ${c.own ? "are" : "is"} working on ${c.path} until ${clock(c.until)}${c.note ? ` (${c.note})` : ""}`;
