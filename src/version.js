// Parley's version, and the versions of the two protocols it speaks. The app
// version is what people compare ("Alex has 0.3.0, you have 0.2.0"); the
// protocol versions decide what still works together.
//
//   WIRE      client <-> relay frames (relay/core.js). A client says hello
//             with the highest version it speaks and the lowest it still
//             can; the relay answers with the one both speak, or refuses
//             and says which side is behind.
//   ENVELOPE  member <-> member envelopes (crypto.js). Members announce
//             their range in a presence message; a sender writes the
//             highest version every recipient reads.
//
// Rules for the future: add fields, never change one; a new message kind or
// frame is ignored, with a notice, by versions that do not know it; raise
// a protocol's max when a change cannot be read by the previous version,
// and its min only when that version can no longer be supported. Keep
// VERSION equal to package.json's (a test checks).

export const VERSION = "0.4.0";
export const WIRE = { min: 1, max: 1 };
export const ENVELOPE = { min: 1, max: 1 };

const parse = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  return match ? match.slice(1, 4).map(Number) : null;
};

export const isVersion = (version) => parse(version) !== null;

// -1, 0 or 1, like a sort comparator; versions that do not parse sort first.
export function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// The protocol version two ranges share, or null.
export function shared(a, b) {
  const top = Math.min(a.max, b.max);
  return top >= Math.max(a.min, b.min) ? top : null;
}

export const validRange = (range) =>
  Number.isSafeInteger(range?.min) &&
  Number.isSafeInteger(range?.max) &&
  range.min >= 1 &&
  range.min <= range.max;

export const UPDATE_HINT =
  "update it with `parley update` (or git pull and npm install in Parley's folder)";
