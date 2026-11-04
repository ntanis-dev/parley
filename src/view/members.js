import { activityText } from "../activity.js";
import { authorOf } from "../authors.js";
import { clean, cleanLine } from "../inbound.js";
import { VERSION, compareVersions } from "../version.js";
import {
  cutSpans,
  fitLine,
  restyle,
  s,
  spread,
  wrapLine,
  withTargets,
} from "./lines.js";
import { cut, stamp, hhmm, oneLine, plural, width as cells } from "./text.js";
import { glyphsOf } from "./theme.js";
import { people, personById } from "./state.js";
import { presence } from "./tree.js";
import { buttons, fact, sectionRule } from "./controls.js";

// The members: all of them with their state, fingerprint and version, and
// one member in full with what can be done (write to them, let them in
// after comparing fingerprints, block them).

const versionText = (app) =>
  !app
    ? "not heard yet"
    : compareVersions(app, VERSION) > 0
      ? `Parley ${app}, newer than yours (${VERSION})`
      : compareVersions(app, VERSION) < 0
        ? `Parley ${app}, older than yours (${VERSION})`
        : `Parley ${app}, the same as yours`;

function stateText(p, now) {
  if (p.status === "pending")
    return p.via === "key change"
      ? "waiting: their keys changed"
      : "waiting to be let in";
  if (p.status === "blocked") return "blocked";
  return activityText(p, now);
}

// What each member can be done with, as buttons: [key, label, action].
export function memberActions(p) {
  if (!p) return [];
  const out = [];
  if (p.status === "approved")
    out.push({
      key: "w",
      label: `Write to ${cut(cleanLine(p.name), 18)}`,
      action: { do: "write", id: p.id },
    });
  if (p.status === "pending")
    out.push({
      key: "a",
      label: "Approve",
      action: { do: "approve", id: p.id },
      style: "warn bold",
    });
  if (p.status === "blocked")
    out.push({
      key: "a",
      label: "Let back in",
      action: { do: "approve", id: p.id },
    });
  if (p.status !== "blocked")
    out.push({
      key: "b",
      label: "Block",
      action: { do: "block", id: p.id },
      style: "err",
    });
  return out;
}

// The members, two lines each; each is a control that opens the member.
export function listModel(state, item, box) {
  const g = glyphsOf(state);
  const width = box.room.width;
  const everyone = people(state.data);
  const pick = state.picks.members ?? 0;
  const focused = state.focus === "pane";
  const body = [],
    controls = [];
  const approved = everyone.filter((p) => p.status === "approved");
  const online = approved.filter((p) => p.state !== "offline").length;
  // The names in a column, as wide as the longest (within reason).
  const nameWidth = Math.min(
    16,
    Math.max(0, ...everyone.map((p) => cells(cleanLine(p.name)))),
  );
  everyone.forEach((p, i) => {
    const look = presence(p, g);
    const name = cleanLine(p.name);
    let first = spread(
      [
        s("  "),
        look.icon,
        s(" "),
        s(name, "bold"),
        s(" ".repeat(Math.max(0, nameWidth - cells(name)) + 2)),
        s(stateText(p, state.now), look.tone),
      ],
      p.status === "approved" && p.app ? [s(`Parley ${p.app}`, "muted")] : [],
      width,
    );
    let second = [
      s(" ".repeat(nameWidth + 6)),
      s(p.fingerprint, p.status === "pending" ? "warn" : "muted"),
    ];
    if (focused && i === pick) {
      first = fitLine(restyle(first, "selected bold"), width, "selected bold");
      first[0] = [`${g.arrow} `, "selected bold"];
      second = fitLine(restyle(second, "selected"), width, "selected");
    }
    controls.push({
      line: body.length,
      size: 2,
      action: { do: "select", id: `member:${p.id}` },
    });
    const target = [{ x: 0, width, control: controls.length - 1 }];
    body.push(withTargets(first, target), withTargets(second, target));
  });
  if (!everyone.length)
    body.push(
      ...wrapLine(
        [
          s(
            "Nobody else yet. Share the invite (Room, or i) with the people who should join; you let each one in here.",
            "muted",
          ),
        ],
        width,
      ),
    );
  const waiting = everyone.filter((p) => p.status === "pending").length;
  return {
    title: [s("Members", "bold")],
    right: [
      s(`${online} of ${approved.length} online`, online ? "ok" : "muted"),
      ...(waiting ? [s(`  ${g.wait} ${waiting} waiting`, "warn bold")] : []),
    ],
    sub: [
      s(
        `Everyone in ${cleanLine(state.data.room.name)}, and who asks to join`,
        "muted",
      ),
    ],
    body,
    controls,
    viewKey: "members",
  };
}

// One member in full.
export function memberModel(state, item, box) {
  const g = glyphsOf(state);
  const width = box.room.width;
  const data = state.data;
  const p = personById(data, item.memberId);
  if (!p)
    return {
      title: [s("Member", "bold")],
      sub: [s("No longer in the room.", "muted")],
      body: [],
    };
  const look = presence(p, g);
  const name = cleanLine(p.name);
  const body = [];
  const since = p.since ? stamp(Date.parse(p.since)) : null;
  const how =
    p.status === "pending"
      ? p.via === "key change"
        ? `${name}'s keys changed${since ? ` (${since})` : ""}: compare the new fingerprint with them before you let them in again.`
        : `${name} asked to join${since ? ` on ${since}` : ""}. Compare fingerprints before you let them in.`
      : p.status === "blocked"
        ? `Blocked: nothing is sent to or read from ${name}.`
        : `In the room${since ? ` since ${since}` : ""}${p.via === "invite" ? ", who invited you" : ""}.`;
  body.push(
    ...wrapLine([s(how, p.status === "pending" ? "warn" : "muted")], width),
    [],
  );
  body.push(sectionRule("Fingerprint", width, g), []);
  body.push([
    s(p.fingerprint, p.status === "pending" ? "warn bold" : "brand bold"),
  ]);
  if (p.status === "pending")
    body.push(
      ...wrapLine(
        [
          s(
            `Ask ${name} to read you theirs (on a call, in person) and compare every group.`,
            "muted",
          ),
        ],
        width,
      ),
    );
  body.push([]);
  body.push(sectionRule("Status", width, g), []);
  body.push(...fact("State", [s(stateText(p, state.now), look.tone)], width));
  if (p.status === "approved")
    body.push(...fact("Version", versionText(p.app), width));
  const claims = (data.claims ?? []).filter((c) => c.member === p.id);
  if (claims.length)
    body.push(
      ...fact(
        "Claims",
        claims
          .map((c) => `${cleanLine(c.path, 80)} until ${hhmm(c.until)} UTC`)
          .join(", "),
        width,
      ),
    );
  const said = [...(data.log ?? [])]
    .reverse()
    .find((e) => !e.own && e.from === p.id && e.kind === "message");
  if (said)
    body.push(
      ...fact(
        "Last said",
        [
          s(`${hhmm(said.at)} `, "muted"),
          s(`${authorOf(said)}: `, "brand"),
          ...cutSpans(
            [s(oneLine(clean(said.text, 400)))],
            Math.max(10, width - 30),
          ),
        ],
        width,
      ),
    );
  const sent = (data.log ?? []).filter((e) => !e.own && e.from === p.id).length;
  if (sent)
    body.push(...fact("In the log", plural(sent, "entry", "entries"), width));
  // The buttons; with the keys in the pane, the marked one is highlighted.
  const actions = memberActions(p);
  const pick = Math.min(
    state.picks[item.key] ?? 0,
    Math.max(0, actions.length - 1),
  );
  const focused = state.focus === "pane";
  body.push([]);
  const row = buttons(
    actions.map((a, i) => ({ ...a, selected: focused && i === pick })),
    width,
  );
  const controls = [];
  const start = body.length;
  row.lines.forEach((line, y) =>
    body.push(
      withTargets(
        line,
        row.targets
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => t.y === y)
          .map(({ t, i }) => ({ x: t.x, width: t.width, control: i })),
      ),
    ),
  );
  row.targets.forEach((t, i) =>
    controls.push({ line: start + t.y, size: 1, action: actions[i].action }),
  );
  return {
    title: [look.icon, s(" "), s(name, "bold")],
    right: [s(stateText(p, state.now), look.tone)],
    sub: [
      s(
        p.status === "approved"
          ? `Member of ${cleanLine(data.room.name)}`
          : p.status === "pending"
            ? "Waiting for you to let them in"
            : "Blocked",
        "muted",
      ),
    ],
    body,
    controls,
    viewKey: item.key,
  };
}
