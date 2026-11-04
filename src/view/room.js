import { cleanLine } from "../inbound.js";
import { VERSION } from "../version.js";
import {
  fitLine,
  lineWidth,
  restyle,
  s,
  wrapLine,
  withTargets,
} from "./lines.js";
import { width as cells } from "./text.js";
import { glyphsOf } from "./theme.js";
import { people } from "./state.js";
import { buttons, fact, LABEL, sectionRule } from "./controls.js";

// The room: where it is, the relay and the connection, this person's
// settings (autonomy and approvals, changed here as `parley autonomy` and
// `parley approvals` would), the invite, and the versions around.

// A path as the person reads it: the home folder as ~, forward slashes.
export function tildify(path, home) {
  const norm = (p) => String(p ?? "").replace(/\\/g, "/");
  const a = norm(path);
  const h = norm(home).replace(/\/$/, "");
  if (!h) return a;
  return a.toLowerCase() === h.toLowerCase()
    ? "~"
    : a.toLowerCase().startsWith(`${h.toLowerCase()}/`)
      ? `~${a.slice(h.length)}`
      : a;
}
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url ?? "");
  }
};

export function relayWord(data) {
  switch (data.relay) {
    case "connected":
      return ["live", "ok"];
    case "refused":
      return ["refused", "err"];
    case "connecting":
    case "idle":
      return ["connecting", "warn"];
    case "waiting":
      return ["reconnecting", "warn"];
    default:
      return [data.relay ?? "offline", "muted"];
  }
}

function toggle(label, options, value, hint, { on, g, width }) {
  const line = [
    s(on ? `${g.arrow} ` : "  ", "brand bold"),
    s(label.padEnd(LABEL), "bold"),
  ];
  const choices = [];
  for (const [option, text] of options) {
    const chosen = option === value;
    choices.push(
      s(chosen ? g.live : g.off, chosen ? "ok" : "muted"),
      s(` ${text.padEnd(4)}`, chosen ? "bold" : "muted"),
      s("  "),
    );
  }
  line.push(...choices);
  const room = width - lineWidth(line);
  if (cells(hint) <= room) line.push(s(hint, "muted"));
  return on
    ? fitLine(restyle(line, "selected bold"), width, "selected bold")
    : line;
}

export function model(state, item, box) {
  const g = glyphsOf(state);
  const width = box.room.width;
  const data = state.data;
  const room = data.room;
  const [word, tone] = relayWord(data);
  const pick = state.picks.room ?? 0;
  const focused = state.focus === "pane";
  const body = [],
    controls = [];
  const control = (line, action) => {
    controls.push({ line: body.length, size: 1, action });
    body.push(
      withTargets(line, [{ x: 0, width, control: controls.length - 1 }]),
    );
  };
  body.push(...fact("Room", [s(cleanLine(room.name), "bold")], width));
  body.push(...fact("Folder", tildify(room.project, data.home), width));
  body.push(
    ...fact(
      "Relay",
      [
        s(hostOf(room.relay)),
        s(`  ${g.live} `, tone),
        s(word, tone),
        ...(data.relayDetail && data.relay !== "connected"
          ? [s(`  ${cleanLine(data.relayDetail, 120)}`, "muted")]
          : []),
      ],
      width,
    ),
  );
  if (data.you)
    body.push(
      ...fact(
        "You",
        [
          s(cleanLine(data.you.name), "me bold"),
          s(`  ${data.you.fingerprint}`, "muted"),
        ],
        width,
      ),
    );
  body.push(
    ...fact(
      "Sessions",
      [
        s(
          data.running === 1
            ? "1 parley session running"
            : `${data.running ?? 0} parley sessions running`,
          data.running ? "ok" : "muted",
        ),
      ],
      width,
    ),
  );
  body.push([], sectionRule("Settings", width, g, "yours, every room"), []);
  const work = data.autonomy === "work";
  control(
    toggle(
      "Autonomy",
      [
        ["work", "work"],
        ["read", "read"],
      ],
      data.autonomy,
      work
        ? "woken turns may change the project"
        : "woken turns only read and talk",
      { on: focused && pick === 0, g, width },
    ),
    { do: "autonomy" },
  );
  control(
    toggle(
      "Approvals",
      [
        [true, "on"],
        [false, "off"],
      ],
      Boolean(data.approvals),
      data.approvals
        ? "each send waits for your yes"
        : "agents send on their own",
      { on: focused && pick === 1, g, width },
    ),
    { do: "approvals" },
  );
  body.push(
    [],
    ...wrapLine(
      [
        s(
          work
            ? "A turn a member's message starts may read, talk, and keep the project in step: pull, resolve conflicts, edit project files, commit and push."
            : "A turn a member's message starts may read and talk; changes to the project wait until you write.",
          "muted",
        ),
      ],
      width,
    ),
  );
  body.push([], sectionRule("Invite", width, g), []);
  const row = buttons(
    [
      { key: "i", label: "Show invite", selected: focused && pick === 2 },
      { key: "c", label: "Copy invite", selected: focused && pick === 3 },
    ],
    width,
  );
  const at = body.length;
  row.lines.forEach((line, y) =>
    body.push(
      withTargets(
        line,
        row.targets
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => t.y === y)
          .map(({ t, i }) => ({ x: t.x, width: t.width, control: 2 + i })),
      ),
    ),
  );
  controls.push(
    { line: at + row.targets[0].y, size: 1, action: { do: "invite" } },
    { line: at + row.targets[1].y, size: 1, action: { do: "copy-invite" } },
  );
  body.push(
    ...wrapLine(
      [
        s(
          "Give it to the people who should join, over a channel you trust. It lets them ask to join; you still let each one in.",
          "muted",
        ),
      ],
      width,
    ),
  );
  body.push([], sectionRule("Versions", width, g), []);
  body.push(...fact("You", `Parley ${VERSION}`, width));
  body.push(
    ...fact(
      "Relay",
      room.versions?.relay?.app
        ? `Parley ${room.versions.relay.app}`
        : "not seen yet",
      width,
    ),
  );
  for (const p of people(data).filter((x) => x.status === "approved"))
    body.push(
      ...fact(
        cleanLine(p.name, LABEL - 2),
        p.app ? `Parley ${p.app}` : "not heard yet",
        width,
      ),
    );
  for (const notice of data.notices ?? [])
    body.push(
      [],
      ...wrapLine([s(`${g.warn} `, "warn bold"), s(notice, "warn")], width, 2),
    );
  return {
    title: [s("Room", "bold")],
    right: [s(`${g.live} `, tone), s(word, tone)],
    sub: [s(`${cleanLine(room.name)} on ${hostOf(room.relay)}`, "muted")],
    body,
    controls,
    viewKey: "room",
  };
}
