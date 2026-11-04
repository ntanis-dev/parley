#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pathsFor } from "./paths.js";
import { VERSION } from "./version.js";
import { printer, s, wrapLine } from "./ui.js";

// parley: one command for the person, the hooks and the MCP server. What
// the person reads is one document per command, drawn by ui.js:
// Parley's mark, then what happened, facts in a column,
// sections under ruled headings, the next step; plain lines in a pipe. The
// commands that decide who is trusted (setup, create, join, approve, block,
// leave) and the ones that speak as the person (say, view) need a person at
// a terminal: they ask, and refuse without one, so an agent running them
// through its shell gets nowhere.

const CLI_PATH = fileURLToPath(import.meta.url);

export class UsageError extends Error {}
export class Failure extends Error {}

const version = () => VERSION;

function readStdin(limit = 4 << 20) {
  if (process.stdin.isTTY) return "";
  try {
    const text = readFileSync(0, "utf8");
    return text.length > limit ? text.slice(0, limit) : text;
  } catch {
    return "";
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// A person at a terminal, not an agent: Claude Code marks the commands its
// tools run with CLAUDECODE, and an agent's shell has no terminal (one it
// makes up, with script or winpty, still carries the mark).
const interactive = (io) =>
  Boolean(io.stdin.isTTY && io.stdout.isTTY && !io.env?.CLAUDECODE);
const NEEDS_PERSON =
  "This needs a person at a terminal: run it yourself, not through an agent or a pipe.";

function needPerson(io) {
  if (!interactive(io)) throw new Failure(NEEDS_PERSON);
}

// A question in the command's document; the answer, trimmed.
async function ask(io, question, hint = "") {
  needPerson(io);
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    return (await rl.question(io.ui.prompt(question, hint))).trim();
  } finally {
    rl.close();
  }
}

const yes = async (io, question) =>
  /^(y|yes)$/i.test(await ask(io, question, "[y/N]"));

// Letting someone into a room is letting their agent ask yours to act. Said
// plainly, in a red box, and confirmed by typing their name rather than "y".
async function trust(io, name, paths) {
  const { readConfig } = await import("./config.js");
  const work = readConfig(paths).autonomy === "work";
  io.ui.danger(`you are about to trust ${name}`, [
    `${name}'s agent will send messages that your Claude reads and acts on, also while you are away.`,
    work
      ? `With autonomy "work" (yours now), it can pull, resolve conflicts, edit project files, commit and push when ${name}'s agent asks.`
      : `With autonomy "read" (yours now), it only reads and answers; \`parley autonomy work\` would let it change the project when asked.`,
    "Parley keeps all of it to this project and never sends your secrets, but it cannot tell a wise request from a harmful one.",
    `Only continue if you trust ${name} with this repository.`,
  ]);
  const typed = await ask(io, `Type ${name} to confirm:`);
  return typed.trim().toLowerCase() === name.trim().toLowerCase();
}

const DISCLAIMER = [
  "Parley is an independent project, not affiliated with, endorsed by, or sponsored by Anthropic.",
  "It lets other people's agents send messages your Claude Code acts on, and lets yours act on theirs. You decide who is in your rooms and what their requests may do (`parley autonomy`).",
  "It is provided as is, without warranty; you are responsible for how you use it and for your Claude Code use under Anthropic's terms.",
];

async function needIdentity(paths) {
  const { loadIdentity } = await import("./rooms.js");
  const identity = loadIdentity(paths);
  if (!identity)
    throw new Failure("Parley is not set up yet: run `parley setup` first.");
  return identity;
}

async function hereRoom(paths, cwd) {
  const { projectFor, loadRoom } = await import("./rooms.js");
  const project = projectFor(paths, cwd);
  const room = project && loadRoom(paths, project.roomId);
  if (!room)
    throw new Failure(
      "This folder is not in a Parley room: `parley create` opens one, `parley join <invite>` joins one.",
    );
  return room;
}

async function rootOf(cwd) {
  const { spawnSync } = await import("node:child_process");
  const { projectRoot } = await import("./egress.js");
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return projectRoot(
    git.status === 0 && git.stdout.trim() ? git.stdout.trim() : cwd,
  );
}

const fingerprintOf = async (keys) =>
  (await import("./crypto.js")).fingerprint(
    keys.sign.pub ?? keys.sign,
    keys.box.pub ?? keys.box,
  );

// A path as the person reads it: the home folder as ~, forward slashes.
function tildify(path, home) {
  const norm = (p) => String(p).replace(/\\/g, "/");
  const a = norm(path);
  const h = norm(home).replace(/\/$/, "");
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
    return String(url);
  }
};

const when = (iso) =>
  new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "Next  parley approve": a command to run, in the accent colour.
const command = (ui, label, text) => ui.fact(label, [s(text, "accent bold")]);

// ---- Commands --------------------------------------------------------------

const COMMANDS = {
  async setup({ values, paths, io }) {
    const { loadIdentity, createIdentity } = await import("./rooms.js");
    const ui = io.ui;
    needPerson(io);
    const existing = loadIdentity(paths);
    if (existing && !values["new-keys"]) {
      ui.ok(`You are set up as ${existing.name}`);
      ui.blank();
      ui.fact("Fingerprint", await fingerprintOf(existing), "accent bold");
      ui.fact("New keys", [s("parley setup --new-keys", "accent")]);
      return 0;
    }
    if (existing) {
      ui.warn(
        "New keys make you someone new to every room: its members must approve you again.",
      );
      ui.blank();
      if (!(await yes(io, "Make new keys?"))) {
        ui.blank();
        ui.skip("Kept your keys.");
        return 1;
      }
    } else {
      ui.full();
      ui.heading("Welcome", `version ${VERSION}`);
      for (const paragraph of DISCLAIMER) {
        ui.paragraph(paragraph);
        ui.blank();
      }
      if (!(await yes(io, "Understood, and set Parley up?"))) {
        ui.blank();
        ui.skip("Not set up.");
        return 1;
      }
    }
    const name =
      values.name ||
      (await ask(io, "Your name, as the other members will see it:"));
    if (!name) throw new UsageError("A name is needed.");
    const identity = createIdentity(paths, name);
    ui.blank();
    ui.ok(`You are ${identity.name}`);
    ui.blank();
    ui.fact("Fingerprint", await fingerprintOf(identity), "accent bold");
    ui.blank();
    ui.paragraph(
      "Read your fingerprint to the people you work with when they join, so each of you knows the keys are right.",
    );
    ui.blank();
    command(ui, "Open a room", "parley create --relay <address>");
    command(ui, "Or join one", "parley join <invite>");
    return 0;
  },

  async create({ values, paths, io, cwd }) {
    const identity = await needIdentity(paths);
    const { createRoom } = await import("./ops.js");
    const ui = io.ui;
    needPerson(io);
    const root = await rootOf(cwd);
    const relay = values.relay || (await ask(io, "Relay address:", "wss://"));
    const { room, invite, checked } = await createRoom({
      paths,
      identity,
      root,
      relay,
      relayKey: values["relay-key"] ?? "",
      name: values.name || root.split(/[\\/]/).pop(),
    });
    ui.blank();
    ui.ok(`Opened room "${room.name}"`);
    ui.blank();
    ui.fact("Folder", tildify(root, paths.home));
    ui.fact("Relay", hostOf(room.relay));
    ui.fact(
      "Repository",
      checked
        ? "only copies of it can join"
        : "not checked: no commits yet (commit, then open the room again)",
      checked ? "" : "warn",
    );
    ui.heading("Invite");
    ui.paragraph(
      "Give it to the people who should join, over a channel you trust. It lets them ask to join; you still let each one in.",
    );
    ui.blank();
    ui.code(invite);
    ui.blank();
    ui.next("parley approve", "once they have joined");
    return 0;
  },

  async invite({ paths, io, cwd }) {
    const identity = await needIdentity(paths);
    const room = await hereRoom(paths, cwd);
    needPerson(io);
    const { inviteFor } = await import("./ops.js");
    const ui = io.ui;
    ui.heading("Invite", `room "${room.name}"`);
    ui.paragraph(
      "Give it to the people who should join, over a channel you trust. It lets them ask to join; you still let each one in.",
    );
    ui.blank();
    ui.code(inviteFor(room, identity));
    ui.blank();
    ui.next("parley approve", "once they have joined");
    return 0;
  },

  async join({ positionals, values, paths, io, cwd }) {
    const identity = await needIdentity(paths);
    const { readInvite, joinRoom } = await import("./ops.js");
    const ui = io.ui;
    const code = positionals[0] || (await ask(io, "Invite:"));
    const invite = readInvite(code, identity);
    const root = await rootOf(cwd);
    const by = invite.by.name;
    ui.heading("Join", `room "${invite.room}"`);
    ui.fact("From", by, "bold");
    ui.fact("Fingerprint", await fingerprintOf(invite.by), "accent bold");
    ui.fact("Folder", tildify(root, paths.home));
    ui.fact("Relay", hostOf(invite.relay));
    ui.blank();
    if (
      !(await yes(io, `Is that ${by}'s fingerprint (check it with them)?`)) ||
      !(await trust(io, by, paths))
    ) {
      ui.blank();
      ui.skip("Not joined.");
      return 1;
    }
    const room = await joinRoom({
      paths,
      identity,
      root,
      invite,
      relayKey: values["relay-key"] ?? "",
    });
    ui.blank();
    ui.ok(`Joined "${room.name}"`, `${by} lets you in next`);
    ui.blank();
    ui.fact("You", [
      s(identity.name, "bold"),
      s(`  ${await fingerprintOf(identity)}`, "accent bold"),
    ]);
    ui.blank();
    ui.paragraph(
      `${by} lets you in with \`parley approve\`: read them your fingerprint, so they know it is you.`,
    );
    ui.blank();
    ui.next("parley", `in this folder, once ${by} lets you in`);
    return 0;
  },

  async approve({ positionals, paths, io, cwd }) {
    const identity = await needIdentity(paths);
    const { syncRoom, setMemberStatus } = await import("./ops.js");
    const { findMember, pendingMembers } = await import("./rooms.js");
    const ui = io.ui;
    let room = await hereRoom(paths, cwd);
    needPerson(io);
    room = await syncRoom(paths, identity, room);
    const pending = positionals[0]
      ? [findMember(room, positionals[0])].filter(Boolean)
      : pendingMembers(room);
    if (!pending.length) {
      if (positionals[0])
        throw new Failure(
          `No member of "${room.name}" matches "${positionals[0]}".`,
        );
      ui.skip(`Nobody is waiting to be let into "${room.name}".`);
      return 0;
    }
    let approved = 0;
    for (const member of pending) {
      ui.heading("Approve", `room "${room.name}"`);
      ui.fact("Name", member.name, "bold");
      ui.fact("Fingerprint", member.fingerprint, "accent bold");
      ui.fact(
        "Asked",
        `${when(member.since)}${member.via === "invite" ? ", with your invite" : ""}`,
      );
      ui.blank();
      if (
        !(await yes(
          io,
          `Did ${member.name} read you that same fingerprint? Approve?`,
        )) ||
        !(await trust(io, member.name, paths))
      ) {
        ui.blank();
        ui.skip(`${member.name} is still waiting.`);
        continue;
      }
      const { announced, error } = await setMemberStatus({
        paths,
        identity,
        room,
        id: member.id,
        status: "approved",
      });
      approved++;
      ui.blank();
      ui.ok(`${member.name} is in`);
      if (!announced)
        ui.warn(
          `Could not tell the room yet (${error}); it learns when you next write.`,
        );
    }
    return approved ? 0 : 1;
  },

  async block({ positionals, paths, io, cwd }) {
    const identity = await needIdentity(paths);
    const { setMemberStatus } = await import("./ops.js");
    const { findMember } = await import("./rooms.js");
    const ui = io.ui;
    const room = await hereRoom(paths, cwd);
    const member = findMember(room, positionals[0]);
    if (!member)
      throw new UsageError(`No member matches "${positionals[0] ?? ""}".`);
    ui.heading("Block", `room "${room.name}"`);
    ui.fact("Name", member.name, "bold");
    ui.fact("Fingerprint", member.fingerprint, "muted");
    ui.blank();
    if (
      !(await yes(
        io,
        `Block ${member.name}? Nothing more is sent to or read from them.`,
      ))
    ) {
      ui.blank();
      ui.skip(`${member.name} is not blocked.`);
      return 1;
    }
    await setMemberStatus({
      paths,
      identity,
      room,
      id: member.id,
      status: "blocked",
    });
    ui.blank();
    ui.ok(`Blocked ${member.name}`);
    return 0;
  },

  async status({ paths, io, cwd, values }) {
    const { loadIdentity, projectFor, loadRoom } = await import("./rooms.js");
    const { activityText, memberActivity } = await import("./activity.js");
    const { activeClaims, describeClaim, sharedMemory } =
      await import("./memory.js");
    const { memberVersions, notices } = await import("./compat.js");
    const { readConfig } = await import("./config.js");
    const { runningLaunches } = await import("./sessions.js");
    const ui = io.ui;
    const g = ui.term.g;
    const identity = loadIdentity(paths);
    if (!identity) {
      ui.skip("Parley is not set up on this computer.");
      ui.blank();
      ui.next("parley setup");
      return 0;
    }
    const you = [
      s(identity.name, "bold"),
      s(`  ${await fingerprintOf(identity)}`, "muted"),
    ];
    const project = projectFor(paths, cwd);
    let room = project && loadRoom(paths, project.roomId);
    if (!room) {
      ui.fact("You", you);
      ui.blank();
      ui.skip("This folder is not in a room.");
      ui.blank();
      command(ui, "Open one", "parley create --relay <address>");
      command(ui, "Join one", "parley join <invite>");
      return 0;
    }
    let relayNote = values.offline ? "not asked (--offline)" : "reached";
    let reached = true;
    if (!values.offline) {
      const { syncRoom } = await import("./ops.js");
      try {
        room = await syncRoom(paths, identity, room);
      } catch (error) {
        reached = false;
        relayNote = `did not answer: ${error.message}`;
      }
    }
    const config = readConfig(paths);
    const running = runningLaunches(paths).filter((l) => {
      try {
        return projectFor(paths, l.cwd)?.roomId === room.roomId;
      } catch {
        return false;
      }
    });
    ui.heading("Room", room.name);
    ui.fact("You", you);
    ui.fact("Folder", tildify(room.project, paths.home));
    ui.fact("Relay", [
      s(hostOf(room.relay), reached ? "" : "warn"),
      s(`  ${relayNote}`, "muted"),
    ]);
    ui.fact(
      "Autonomy",
      `${config.autonomy}${config.approvals ? ", approvals on" : ""}`,
    );
    ui.fact(
      "Sessions",
      running.length
        ? `${running.length} \`parley\` running here`
        : "none running here",
      running.length ? "ok" : "muted",
    );
    ui.fact(
      "Versions",
      `you ${VERSION} ${g.dot} relay ${room.versions?.relay?.app ?? "not seen yet"}`,
    );

    const activity = memberActivity(paths, room);
    const versions = memberVersions(room);
    const members = Object.entries(room.members);
    const online = activity.filter((a) => a.state !== "offline");
    const working = online.filter((a) => a.state === "working").length;
    ui.heading(
      "Members",
      members.length
        ? `${online.length}/${activity.length} online${working ? ` ${g.dot} ${working} working` : ""}`
        : "",
    );
    if (!members.length) {
      ui.skip("Nobody else yet.");
      ui.blank();
      ui.next("parley invite", "and send it to them");
    }
    const tone = { working: "brand", idle: "ok", offline: "muted" };
    const nameWidth = Math.max(10, ...members.map(([, m]) => m.name.length));
    for (const [id, m] of members) {
      const seen = activity.find((a) => a.id === id);
      const app = versions.find((v) => v.name === m.name)?.app;
      const state =
        m.status === "approved" ? (seen?.state ?? "offline") : m.status;
      const shade = m.status === "approved" ? tone[state] : "warn";
      const glyph =
        m.status !== "approved" ? g.wait : state === "offline" ? g.off : g.live;
      const words =
        m.status === "approved"
          ? seen
            ? activityText(seen)
            : "offline"
          : m.status === "pending"
            ? "waiting for approval"
            : m.status;
      ui.entry(
        [s(glyph, shade)],
        m.name,
        [
          s(words.padEnd(24), shade),
          s(m.fingerprint, "muted"),
          ...(app ? [s(`  ${app}`, "muted")] : []),
        ],
        nameWidth,
      );
    }

    const claims = activeClaims(paths, room.roomId);
    if (claims.length) {
      ui.heading("Claims", plural(claims.length, "claim"));
      for (const c of claims)
        ui.lines(
          wrapLine(
            [s(`${g.bullet} `, "brand"), s(describeClaim(c))],
            ui.width,
            2,
          ),
        );
    }
    const memory = sharedMemory(paths, room.roomId);
    if (memory.length) {
      ui.heading("Shared memory", plural(memory.length, "topic"));
      const topicWidth = Math.min(
        20,
        Math.max(...memory.slice(0, 8).map((n) => (n.topic ?? "note").length)),
      );
      for (const n of memory.slice(0, 8))
        ui.entry(
          [s(g.bullet, "brand")],
          (n.topic ?? "note").slice(0, topicWidth),
          [s(n.text.replace(/\s+/g, " ").slice(0, 160))],
          topicWidth,
        );
      if (memory.length > 8)
        ui.paragraph(`and ${memory.length - 8} more: parley view has them all`);
    }
    const lines = notices(room);
    if (lines.length) {
      ui.blank();
      for (const line of lines) ui.warn(line);
    }
    return 0;
  },

  // What a turn a member's message started may do here. Narrowing it to
  // "read" is always allowed; widening it to "work" needs the person, warned.
  async autonomy({ positionals, paths, io }) {
    const { readConfig, writeConfig } = await import("./config.js");
    const ui = io.ui;
    const wanted = positionals[0]?.toLowerCase();
    if (wanted !== undefined && wanted !== "read" && wanted !== "work")
      throw new UsageError("parley autonomy [read|work]");
    if (wanted === "work" && readConfig(paths).autonomy !== "work") {
      ui.danger("members' agents will be able to change this project", [
        "In a turn their message starts, your Claude may pull, resolve conflicts, edit project files, commit and push when they ask, with nobody watching.",
        "Parley keeps it to the project and away from your secrets; it cannot judge whether a request is wise.",
      ]);
      const typed = await ask(io, "Type work to confirm:");
      if (typed.trim().toLowerCase() !== "work") {
        ui.blank();
        ui.skip("Autonomy is unchanged.");
        return 1;
      }
      ui.blank();
    }
    if (wanted) writeConfig(paths, (c) => (c.autonomy = wanted));
    const work = readConfig(paths).autonomy === "work";
    ui.ok(`Autonomy is ${work ? "work" : "read"}`);
    ui.blank();
    ui.paragraph(
      work
        ? "A turn a member's message starts may read, talk, and keep the project in step: pull, resolve conflicts, edit project files, commit and push."
        : "A turn a member's message starts may read and talk; changes to the project wait until you write.",
    );
    ui.blank();
    command(
      ui,
      work ? "Narrow it" : "Widen it",
      work ? "parley autonomy read" : "parley autonomy work",
    );
    return 0;
  },

  // Turning approvals on is always allowed; turning them off lets agents send
  // on their own again, so it needs the person.
  async approvals({ positionals, paths, io }) {
    const { readConfig, writeConfig } = await import("./config.js");
    const ui = io.ui;
    const wanted = positionals[0]?.toLowerCase();
    if (wanted !== undefined && wanted !== "on" && wanted !== "off")
      throw new UsageError("parley approvals [on|off]");
    if (wanted === "off" && readConfig(paths).approvals) {
      if (
        !(await yes(
          io,
          "Let your agents send messages, notes and diffs without asking you?",
        ))
      ) {
        ui.blank();
        ui.skip("Approvals stay on.");
        return 1;
      }
      ui.blank();
    }
    if (wanted) writeConfig(paths, (c) => (c.approvals = wanted === "on"));
    const on = readConfig(paths).approvals;
    ui.ok(`Approvals are ${on ? "on" : "off"}`);
    ui.blank();
    ui.paragraph(
      on
        ? "Each message, note and diff your agent sends waits for your yes in a dialog."
        : "Your agent talks to the room on its own, through Parley's checks: this project only, no secrets.",
    );
    ui.blank();
    command(
      ui,
      on ? "Turn off" : "Turn on",
      on ? "parley approvals off" : "parley approvals on",
    );
    return 0;
  },

  // Parley updates the way it was installed: a git checkout, pulled
  // (fast-forward only) and its dependencies installed again.
  async update({ io, env, paths }) {
    const { spawnSync } = await import("node:child_process");
    const { dirname } = await import("node:path");
    const ui = io.ui;
    const repo = dirname(dirname(CLI_PATH));
    const git = (...args) =>
      spawnSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        windowsHide: true,
      });
    if (git("rev-parse", "--is-inside-work-tree").stdout?.trim() !== "true")
      throw new Failure(
        `Parley in ${repo} is not a git checkout; update it the way you installed it.`,
      );
    if (git("status", "--porcelain", "--untracked-files=no").stdout.trim())
      throw new Failure(
        `Parley's folder (${repo}) has changes of its own; commit or stash them first.`,
      );
    const remote =
      git("remote", "get-url", "origin").stdout?.trim() || "origin";
    ui.heading("Update", `version ${VERSION}`);
    ui.fact("Folder", tildify(repo, paths.home));
    ui.fact("From", remote);
    ui.fact("Steps", "git pull --ff-only, then npm install");
    ui.blank();
    if (!(await yes(io, "Update Parley?"))) {
      ui.blank();
      ui.skip("Not updated.");
      return 1;
    }
    ui.blank();
    const run = (command, args) =>
      spawnSync(command, args, {
        cwd: repo,
        stdio: "inherit",
        env,
        // npm is a .cmd script on Windows, which needs a shell; the
        // arguments are fixed.
        shell: process.platform === "win32" && command === "npm",
      });
    if (run("git", ["pull", "--ff-only"]).status !== 0)
      throw new Failure("git pull did not finish; see above.");
    if (run("npm", ["install", "--no-audit", "--no-fund"]).status !== 0)
      throw new Failure("npm install did not finish; see above.");
    // The new code, asked in a process of its own.
    const after = spawnSync(process.execPath, [CLI_PATH, "--version"], {
      encoding: "utf8",
      env,
    }).stdout?.trim();
    ui.blank();
    if (after && after !== VERSION) {
      ui.ok(`Updated Parley ${VERSION} to ${after}`);
      ui.blank();
      ui.paragraph("Restart running `parley` sessions to use it.");
    } else ui.ok(`Parley ${VERSION} is the newest`, `on ${remote}`);
    return 0;
  },

  async log({ values, paths, io, cwd }) {
    const { readLog, loadIdentity } = await import("./rooms.js");
    const { lineFor } = await import("./hooks.js");
    const room = await hereRoom(paths, cwd);
    const ui = io.ui;
    const count = Math.max(1, Math.min(500, Number(values.count ?? 20) || 20));
    // What the relay has that this computer has not seen yet, first.
    let unreached = null;
    const identity = loadIdentity(paths);
    if (identity && !values.offline) {
      const { syncRoom } = await import("./ops.js");
      try {
        await syncRoom(paths, identity, room);
      } catch (error) {
        unreached = error.message;
      }
    }
    const shown = readLog(paths, room.roomId)
      .slice(-count)
      .map((e) => [e, lineFor(e, room, ui.term.g)])
      .filter(([, line]) => line);
    if (unreached)
      ui.warn(
        `The relay did not answer (${unreached}); this is what this computer has.`,
      );
    ui.heading("Log", `room "${room.name}", the last ${count}`);
    if (!shown.length) ui.skip("Nothing yet.");
    // The same lines a session shows, with when.
    for (const [e, line] of shown) {
      const at = new Date(e.at);
      const stamp = `${at.toLocaleDateString([], { month: "short", day: "2-digit" })} ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      ui.lines(
        wrapLine(
          [
            s(`${stamp}  `, "muted"),
            s(
              line.slice(`${ui.term.g.mark} Parley `.length),
              e.own ? "me" : "",
            ),
          ],
          ui.width,
          stamp.length + 2,
        ),
      );
    }
    return 0;
  },

  // A message from the person themselves, not their agent: the others' agents
  // see it as such.
  async say({ positionals, values, paths, io, cwd, env }) {
    const identity = await needIdentity(paths);
    needPerson(io);
    const text = positionals.join(" ").trim();
    if (!text) throw new UsageError('parley say "message" [--to name]');
    const room = await hereRoom(paths, cwd);
    const { sayAsPerson } = await import("./view.js");
    const sent = await sayAsPerson({
      paths,
      identity,
      room,
      text,
      to: values.to ? [values.to] : [],
      env,
    });
    io.ui.ok(sent.replace(/\.$/, ""), "as you, not your agent");
    return 0;
  },

  async view({ paths, io, cwd, env }) {
    const identity = await needIdentity(paths);
    needPerson(io);
    const room = await hereRoom(paths, cwd);
    const { runView } = await import("./view.js");
    return runView({ paths, identity, room, env });
  },

  async leave({ paths, io, cwd }) {
    const { leaveRoom } = await import("./ops.js");
    const ui = io.ui;
    const room = await hereRoom(paths, cwd);
    ui.heading("Leave", `room "${room.name}"`);
    ui.fact("Folder", tildify(room.project, paths.home));
    ui.fact("Members", String(Object.keys(room.members).length));
    ui.blank();
    if (
      !(await yes(
        io,
        `Leave "${room.name}" and delete its keys and messages from this computer?`,
      ))
    ) {
      ui.blank();
      ui.skip(`Still in "${room.name}".`);
      return 1;
    }
    leaveRoom(paths, room);
    ui.blank();
    ui.ok(`Left "${room.name}"`, "its keys and messages are gone from here");
    return 0;
  },

  async relay({ values, io, env, paths }) {
    const { startRelay, RELAY_DEFAULTS } = await import("./relay/server.js");
    const ui = io.ui;
    const host = values.host ?? env.PARLEY_RELAY_HOST ?? RELAY_DEFAULTS.host;
    const port = Number(
      values.port ?? env.PARLEY_RELAY_PORT ?? RELAY_DEFAULTS.port,
    );
    const relayKey = env.PARLEY_RELAY_KEY ?? "";
    const tlsCert = values["tls-cert"] ?? env.PARLEY_RELAY_TLS_CERT ?? null;
    const tlsKey = values["tls-key"] ?? env.PARLEY_RELAY_TLS_KEY ?? null;
    const data = values.data ?? env.PARLEY_RELAY_DATA ?? RELAY_DEFAULTS.data;
    const maxRooms = Number(
      values["max-rooms"] ??
        env.PARLEY_RELAY_MAX_ROOMS ??
        RELAY_DEFAULTS.maxRooms,
    );
    const relay = await startRelay({
      host,
      port,
      data,
      relayKey,
      tlsCert,
      tlsKey,
      maxRooms,
      log: (line) => io.err(line),
    });
    ui.heading("Relay", `version ${VERSION}`);
    ui.ok(`Listening on ${relay.tls ? "wss" : "ws"}://${host}:${relay.port}`);
    ui.blank();
    ui.fact(
      "Data",
      data === ":memory:" ? "in memory only" : tildify(data, paths.home),
    );
    ui.fact("Rooms", `at most ${maxRooms}`);
    ui.fact(
      "Relay key",
      relayKey ? "set: only those who have it open rooms" : "none",
      relayKey ? "" : "warn",
    );
    if (
      !relayKey ||
      (!relay.tls && !["127.0.0.1", "localhost", "::1"].includes(host))
    )
      ui.blank();
    if (!relayKey)
      ui.warn(
        "Without PARLEY_RELAY_KEY, anyone who can reach this relay can open rooms on it.",
      );
    if (!relay.tls && !["127.0.0.1", "localhost", "::1"].includes(host))
      ui.warn(
        "No TLS here: put it behind TLS (Caddy, `tailscale serve`) or use it on a tailnet. Parley clients refuse ws:// anywhere else.",
      );
    ui.blank();
    ui.paragraph("Ctrl+C stops it. What it does is logged below.");
    ui.end();
    await new Promise((resolve) => {
      const stop = () => relay.close().then(resolve);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  },

  async doctor({ paths, io, cwd, env }) {
    const { loadIdentity, projectFor, loadRoom } = await import("./rooms.js");
    const { resolveClaude } = await import("./claude-path.js");
    const { spawnSync } = await import("node:child_process");
    const ui = io.ui;
    const checks = [];
    const check = (state, name, detail) => checks.push({ state, name, detail });
    const major = Number(process.versions.node.split(".")[0]);
    check(
      major >= 24 ? "done" : "fail",
      "Node",
      major >= 24
        ? process.versions.node
        : `${process.versions.node}: Parley needs Node 24 or newer`,
    );
    try {
      const claude = resolveClaude({ env, home: paths.home });
      const out = spawnSync(claude.command, [...claude.prefix, "--version"], {
        encoding: "utf8",
        windowsHide: true,
      });
      check(
        out.status === 0 ? "done" : "fail",
        "Claude Code",
        out.status === 0 ? out.stdout.trim() : "claude --version failed",
      );
    } catch (error) {
      check("fail", "Claude Code", error.message);
    }
    const identity = loadIdentity(paths);
    check(
      identity ? "done" : "fail",
      "Your keys",
      identity
        ? `${identity.name}, ${await fingerprintOf(identity)}`
        : "run parley setup",
    );
    if (process.platform === "win32") {
      const { statusLineShell } = await import("./statusline.js");
      const bash = /bash\.exe$/i.test(statusLineShell(env).command);
      check(
        bash ? "done" : "fail",
        "Git Bash",
        bash
          ? "for Claude Code's Monitor tool, Parley's message watch"
          : "install Git for Windows: the message watch needs it",
      );
    }
    const project = projectFor(paths, cwd);
    const room = project && loadRoom(paths, project.roomId);
    check(
      room ? "done" : "fail",
      "Room",
      room
        ? `"${room.name}", ${tildify(room.project, paths.home)}`
        : "this folder is not in one: parley create, or parley join <invite>",
    );
    const notes = [];
    if (room && identity) {
      const { syncRoom } = await import("./ops.js");
      const { notices } = await import("./compat.js");
      try {
        const fresh = await syncRoom(paths, identity, room);
        check("done", "Relay", hostOf(room.relay));
        notes.push(...notices(fresh));
      } catch (error) {
        check("fail", "Relay", `${hostOf(room.relay)}: ${error.message}`);
      }
    }
    if (process.platform === "win32")
      check(
        "warn",
        "Sandbox",
        "Claude Code does not sandbox commands on native Windows: keep Parley sessions out of bypass mode (Parley refuses it) and review what you approve.",
      );
    for (const note of notes) check("warn", "Versions", note);
    const marksFor = {
      done: [s(ui.term.g.check, "ok bold")],
      fail: [s(ui.term.g.cross, "err bold")],
      warn: [s(ui.term.g.warn, "warn bold")],
    };
    const nameWidth = Math.max(...checks.map((c) => c.name.length));
    ui.heading("Doctor", `version ${VERSION}`);
    for (const c of checks)
      ui.entry(
        marksFor[c.state],
        c.name,
        [s(c.detail, c.state === "fail" ? "" : "muted")],
        nameWidth,
      );
    const failed = checks.filter((c) => c.state === "fail").length;
    const warned = checks.filter((c) => c.state === "warn").length;
    ui.blank();
    if (failed) ui.err(`${plural(failed, "check")} failed.`);
    else
      ui.ok(
        warned
          ? `All checks passed; ${plural(warned, "note")} above.`
          : "All checks passed.",
      );
    return failed ? 1 : 0;
  },

  // ---- Claude Code's callers ----------------------------------------------

  async hook({ positionals, values, paths, io }) {
    try {
      const { handleHook } = await import("./hooks.js");
      const output = handleHook(positionals[0], parseJson(readStdin()), {
        paths,
        launchId: values.launch ?? null,
      });
      if (output) io.out(JSON.stringify(output));
    } catch {
      // A hook never fails the session.
    }
    return 0;
  },

  async watch({ values, paths }) {
    const { runWatch } = await import("./watch.js");
    return runWatch({ paths, launchId: values.launch ?? null });
  },

  async statusline({ values, paths, env }) {
    const { statusLine } = await import("./statusline.js");
    const { readLaunch } = await import("./sessions.js");
    const stdinText = readStdin();
    let out = "";
    try {
      out = statusLine({
        launch: values.launch ? readLaunch(paths, values.launch) : null,
        stdinText,
        env,
      });
    } catch {
      // A status line never fails the session.
    }
    process.stdout.write(out);
    return 0;
  },

  async mcp({ values, paths, env }) {
    if (!values.launch)
      throw new UsageError(
        "parley mcp --launch <id> (a `parley` launch runs it)",
      );
    const { runMcp } = await import("./mcp.js");
    runMcp({ paths, launchId: values.launch, env });
    return new Promise(() => {});
  },
};

const OPTIONS = {
  setup: { name: { type: "string" }, "new-keys": { type: "boolean" } },
  create: {
    relay: { type: "string" },
    "relay-key": { type: "string" },
    name: { type: "string" },
  },
  join: { "relay-key": { type: "string" } },
  status: { offline: { type: "boolean" } },
  log: { count: { type: "string", short: "n" }, offline: { type: "boolean" } },
  say: { to: { type: "string" } },
  relay: {
    host: { type: "string" },
    port: { type: "string" },
    data: { type: "string" },
    "tls-cert": { type: "string" },
    "tls-key": { type: "string" },
    "max-rooms": { type: "string" },
  },
  hook: { launch: { type: "string" } },
  mcp: { launch: { type: "string" } },
  watch: { launch: { type: "string" } },
  statusline: { launch: { type: "string" } },
};

const HELP = [
  [
    "Start",
    "",
    [
      ["parley [claude arguments]", "Claude Code with Parley on"],
      ["parley start [arguments]", "the same, starting with a prompt"],
      ["parley view", "the room, live, in a terminal of its own"],
      ['parley say "text" [--to name]', "a message from you, not your agent"],
    ],
  ],
  [
    "Set up",
    "each needs you at a terminal",
    [
      ["parley setup [--name N]", "your keys and the name members see"],
      ["parley create --relay URL", "open a room for this project"],
      ["parley join <invite>", "join a room from an invite"],
      ["parley approve [who]", "let someone in, after comparing fingerprints"],
      ["parley block <who>", "stop writing to and reading from a member"],
      ["parley invite", "print this room's invite again"],
      ["parley leave", "take this folder out of its room"],
    ],
  ],
  [
    "Everyday",
    "",
    [
      ["parley status", "the room, its members, claims and memory"],
      ["parley log [-n 20]", "the room's latest messages, notes, files"],
      [
        "parley autonomy [read|work]",
        "what a turn a member's message starts may do",
      ],
      [
        "parley approvals [on|off]",
        "approve each send yourself (off by default)",
      ],
      ["parley doctor", "check the setup"],
      ["parley update", "update Parley (git pull, npm install)"],
    ],
  ],
  [
    "Host a relay",
    "",
    [
      [
        "parley relay [--port P]",
        "host a relay (PARLEY_RELAY_KEY: who opens rooms)",
      ],
    ],
  ],
];

function printHelp(ui) {
  ui.full();
  ui.lines(
    wrapLine(
      [
        s("parley", "accent bold"),
        s(
          ` on its own starts Claude Code with Parley on, in a folder that is in a room. Version ${VERSION}.`,
          "muted",
        ),
      ],
      ui.width,
    ),
  );
  const nameWidth =
    Math.max(...HELP.flatMap(([, , rows]) => rows.map(([c]) => c.length))) + 3;
  for (const [section, note, rows] of HELP) {
    ui.heading(section, note);
    for (const [command, what] of rows)
      ui.lines(
        wrapLine(
          [s(command.padEnd(nameWidth), "accent bold"), s(what)],
          ui.width,
          nameWidth,
        ),
      );
  }
}

export async function main(
  argv = process.argv.slice(2),
  { env = process.env, cwd = process.cwd(), io = defaultIo(env) } = {},
) {
  const paths = pathsFor(env);
  const [first, ...rest] = argv;
  if (first === "--version" || first === "-v") {
    io.out(version());
    return 0;
  }
  if (first === "help" || first === "--help" || first === "-h") {
    printHelp(io.ui);
    return 0;
  }
  if (first === undefined || first === "start" || first.startsWith("-")) {
    const { launch } = await import("./launch.js");
    return launch({
      paths,
      args: first === "start" ? rest : argv,
      cwd,
      env,
      cliPath: CLI_PATH,
      ui: io.errUi,
    });
  }
  const run = COMMANDS[first];
  if (!run)
    throw new UsageError(
      `Unknown command "${first}". \`parley start ...\` passes arguments to claude.`,
    );
  const { values, positionals } = parseArgs({
    args: rest,
    options: OPTIONS[first] ?? {},
    allowPositionals: true,
    strict: true,
  });
  return run({ values, positionals, paths, io, cwd, env });
}

export function defaultIo(env = process.env) {
  // One document between stdout and stderr: the same terminal.
  const shared = {};
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    env,
    ui: printer(process.stdout, env, shared),
    errUi: printer(process.stderr, env, shared),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

// Errors Parley raises on purpose say what is wrong in their message; any
// other error is a bug, shown with its stack.
const PLAIN_ERRORS = new Set([
  "UsageError",
  "Failure",
  "RoomError",
  "Refusal",
  "RelayError",
  "CryptoError",
  "LaunchRefused",
  "ClaudeNotFound",
]);
const isUsage = (error) =>
  error instanceof UsageError ||
  String(error?.code ?? "").startsWith("ERR_PARSE_ARGS");

export function reportError(io, error) {
  const plain = PLAIN_ERRORS.has(error?.constructor?.name) || isUsage(error);
  if (plain)
    io.errUi.failure(error.message, isUsage(error) ? "parley help" : null);
  else process.stderr.write(`parley: ${error?.stack ?? error}\n`);
  io.errUi.end();
  return isUsage(error) ? 2 : 1;
}

const same = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
if (process.argv[1] && same(CLI_PATH, realpathSync(process.argv[1]))) {
  const io = defaultIo(process.env);
  main(process.argv.slice(2), { io }).then(
    (code) => {
      io.ui.end();
      process.exitCode = code ?? 0;
    },
    (error) => {
      process.exitCode = reportError(io, error);
    },
  );
}
