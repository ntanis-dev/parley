import { cleanLine } from "./inbound.js";

// Who wrote an entry, as the person reads it. Theirs are "you" (typed by
// them) or "your agent"; a member's are their name when they typed it, and
// their agent otherwise: "Jo's agent", or "Chris' agent" for a name that
// ends in s.

export const possessive = (name) =>
  /s$/i.test(name) ? `${name}'` : `${name}'s`;

export function authorOf(entry) {
  if (entry.own) return entry.human ? "you" : "your agent";
  const name = cleanLine(entry.name ?? "someone");
  return entry.human ? name : `${possessive(name)} agent`;
}
