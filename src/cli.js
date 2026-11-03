#!/usr/bin/env node
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pathsFor } from "./paths.js";
import { VERSION } from "./version.js";

// parley: one command for the person, the hooks and the MCP server. The
// commands that decide who is trusted (setup, create, join, approve, block,
// leave) need a person at a terminal: they ask, and refuse without one, so
// an agent running them through its shell gets nowhere.

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

const interactive = (io) => Boolean(io.stdin.isTTY && io.stdout.isTTY);

async function ask(io, question) {
  if (!interactive(io))
    throw new Failure(
      "This needs a person at a terminal: run it yourself, not through an agent or a pipe.",
    );
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const yes = async (io, question) =>
  /^(y|yes)$/i.test(await ask(io, `${question} [y/N] `));

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

const memberLines = (room) =>
  Object.entries(room.members).map(
    ([, m]) => `  ${m.status.padEnd(8)} ${m.name.padEnd(20)} ${m.fingerprint}`,
  );

// ---- Commands --------------------------------------------------------------

const COMMANDS = {
  async setup({ values, paths, io }) {
    const { loadIdentity, createIdentity } = await import("./rooms.js");
    const { fingerprint } = await import("./crypto.js");
    if (!interactive(io))
      throw new Failure(
        "This needs a person at a terminal: run it yourself, not through an agent or a pipe.",
      );
    const existing = loadIdentity(paths);
    if (existing && !values["new-keys"]) {
      io.out(
        `Parley is set up: you are ${existing.name}, fingerprint ${fingerprint(existing.sign.pub, existing.box.pub)}.`,
      );
      return 0;
    }
    if (
      existing &&
      !(await yes(
        io,
        "Make new keys? Every room will see you as someone new, and members must approve you again.",
      ))
    )
      return 1;
    const name =
      values.name ||
      (await ask(io, "Your name, as the other members will see it: "));
    if (!name) throw new UsageError("A name is needed.");
    const identity = createIdentity(paths, name);
    io.out(
      `You are ${identity.name}. Your fingerprint: ${fingerprint(identity.sign.pub, identity.box.pub)}`,
    );
    io.out(
      "Read it to the people you work with when they join, so each of you knows the keys are right.",
    );
    return 0;
  },

  async create({ values, paths, io, cwd }) {
    const identity = await needIdentity(paths);
    const { createRoom } = await import("./ops.js");
    if (!interactive(io))
      throw new Failure(
        "This needs a person at a terminal: run it yourself, not through an agent or a pipe.",
      );
    const root = await rootOf(cwd);
    const relay =
      values.relay || (await ask(io, "Relay address (wss://...): "));
    const { room, invite, checked } = await createRoom({
      paths,
      identity,
      root,
      relay,
      relayKey: values["relay-key"] ?? "",
      name: values.name || root.split(/[\\/]/).pop(),
    });
    io.out(`Opened room "${room.name}" for ${root}.`);
    if (!checked)
      io.out(
        "This folder has no commits yet, so Parley cannot check that the others join from the same project. Commit once and open the room again to have it checked.",
      );
    io.out(
      `\nGive this invite to the people who should join, over a channel you trust (it lets them ask to join; you still approve each one):\n\n${invite}\n`,
    );
    io.out(
      "When they have joined, run `parley approve` and compare fingerprints with them.",
    );
    return 0;
  },

  async invite({ paths, io, cwd }) {
    const identity = await needIdentity(paths);
    const room = await hereRoom(paths, cwd);
    if (!interactive(io))
      throw new Failure("This needs a person at a terminal.");
    const { inviteFor } = await import("./ops.js");
    io.out(inviteFor(room, identity));
    return 0;
  },

  async join({ positionals, values, paths, io, cwd }) {
    const identity = await needIdentity(paths);
    const { readInvite, joinRoom } = await import("./ops.js");
    const { fingerprint } = await import("./crypto.js");
    const code = positionals[0] || (await ask(io, "Invite: "));
    const invite = readInvite(code, identity);
    const root = await rootOf(cwd);
    io.out(
      `This invite is from ${invite.by.name}, fingerprint ${fingerprint(invite.by.sign, invite.by.box)}.`,
    );
    io.out(
      `It joins ${root} to room "${invite.room}" on ${new URL(invite.relay).host}.`,
    );
    if (
      !(await yes(
        io,
        `Is that ${invite.by.name}'s fingerprint (check it with them)? Join?`,
      ))
    )
      return 1;
    const room = await joinRoom({
      paths,
      identity,
      root,
      invite,
      relayKey: values["relay-key"] ?? "",
    });
    io.out(
      `Joined "${room.name}". ${invite.by.name} now has to approve you; your fingerprint is ${fingerprint(identity.sign.pub, identity.box.pub)}.`,
    );
    io.out(
      "Then start Claude Code with `parley` here and type `/parley on` in the conversation.",
    );
    return 0;
  },

  async approve({ positionals, paths, io, cwd }) {
    const identity = await needIdentity(paths);
    const { syncRoom, setMemberStatus } = await import("./ops.js");
    const { findMember, pendingMembers } = await import("./rooms.js");
    let room = await hereRoom(paths, cwd);
    if (!interactive(io))
      throw new Failure("This needs a person at a terminal.");
    room = await syncRoom(paths, identity, room);
    const pending = positionals[0]
      ? [findMember(room, positionals[0])].filter(Boolean)
      : pendingMembers(room);
    if (!pending.length) {
      io.out(
        positionals[0]
          ? `No member matches "${positionals[0]}".`
          : "Nobody is waiting to be approved.",
      );
      return positionals[0] ? 1 : 0;
    }
    for (const member of pending) {
      io.out(
        `${member.name} wants in, fingerprint ${member.fingerprint} (${member.via}, ${member.since}).`,
      );
      if (
        !(await yes(
          io,
          `Did ${member.name} read you that same fingerprint? Approve?`,
        ))
      )
        continue;
      const { announced, error } = await setMemberStatus({
        paths,
        identity,
        room,
        id: member.id,
        status: "approved",
      });
      io.out(
        `Approved ${member.name}.${announced ? "" : ` (Could not tell the room yet: ${error}. It will learn when you next write.)`}`,
      );
    }
    return 0;
  },

  async block({ positionals, paths, io, cwd }) {
    const identity = await needIdentity(paths);
    const { setMemberStatus } = await import("./ops.js");
    const { findMember } = await import("./rooms.js");
    const room = await hereRoom(paths, cwd);
    const member = findMember(room, positionals[0]);
    if (!member)
      throw new UsageError(`No member matches "${positionals[0] ?? ""}".`);
    if (
      !(await yes(
        io,
        `Block ${member.name} (${member.fingerprint})? Nothing more is sent to or read from them.`,
      ))
    )
      return 1;
    await setMemberStatus({
      paths,
      identity,
      room,
      id: member.id,
      status: "blocked",
    });
    io.out(`Blocked ${member.name}.`);
    return 0;
  },

  async status({ paths, io, cwd, values }) {
    const { loadIdentity, projectFor, loadRoom } = await import("./rooms.js");
    const { fingerprint } = await import("./crypto.js");
    const { readdirSafe, sessionsOn } = helpers;
    const identity = loadIdentity(paths);
    io.out(
      identity
        ? `You are ${identity.name}, fingerprint ${fingerprint(identity.sign.pub, identity.box.pub)}.`
        : "Not set up: run `parley setup`.",
    );
    const project = projectFor(paths, cwd);
    let room = project && loadRoom(paths, project.roomId);
    if (!room) {
      io.out("This folder is not in a room.");
      return 0;
    }
    if (identity && !values.offline) {
      const { syncRoom } = await import("./ops.js");
      try {
        room = await syncRoom(paths, identity, room);
      } catch (error) {
        io.out(`(The relay did not answer: ${error.message})`);
      }
    }
    io.out(`Room "${room.name}" for ${room.project}, relay ${room.relay}.`);
    const lines = memberLines(room);
    io.out(
      lines.length
        ? `Members:\n${lines.join("\n")}`
        : "No members yet: share the invite (`parley invite`).",
    );
    const on = sessionsOn(paths, readdirSafe).filter(
      (s) => s.roomId === room.roomId,
    );
    io.out(
      on.length
        ? `On in ${on.length} conversation${on.length === 1 ? "" : "s"}.`
        : "Off in every conversation (type `/parley on` in one).",
    );
    const { memberVersions, notices } = await import("./compat.js");
    const relay = room.versions?.relay;
    const versions = [
      `you ${VERSION}`,
      `relay ${relay ? (relay.app ?? "older than 0.2.0") : "not seen yet"}`,
      ...memberVersions(room).map(
        (m) => `${m.name} ${m.app ?? "not reported (0.1 or older)"}`,
      ),
    ];
    io.out(`Parley versions: ${versions.join(", ")}.`);
    for (const line of notices(room)) io.out(line);
    return 0;
  },

  async off({ paths, io }) {
    const { updateSession } = await import("./sessions.js");
    const { readdirSafe, sessionsOn } = helpers;
    const on = sessionsOn(paths, readdirSafe);
    for (const s of on)
      updateSession(paths, s.sessionId, (x) => (x.enabled = false));
    io.out(
      on.length
        ? `Turned Parley off in ${on.length} conversation${on.length === 1 ? "" : "s"}.`
        : "Parley was not on anywhere.",
    );
    return 0;
  },

  // Turning approvals on is always allowed; turning them off lets agents send
  // on their own again, so it needs the person.
  async approvals({ positionals, paths, io }) {
    const { readConfig, writeConfig } = await import("./config.js");
    const wanted = positionals[0]?.toLowerCase();
    if (wanted !== undefined && wanted !== "on" && wanted !== "off")
      throw new UsageError("parley approvals [on|off]");
    if (wanted === "off" && readConfig(paths).approvals) {
      if (
        !(await yes(
          io,
          "Let your agents send messages, notes and diffs without asking you (still only through Parley's checks)?",
        ))
      )
        return 1;
    }
    if (wanted) writeConfig(paths, (c) => (c.approvals = wanted === "on"));
    io.out(
      readConfig(paths).approvals
        ? "Approvals are on: each message, note and diff your agent sends waits for your yes in a dialog."
        : "Approvals are off: your agent talks to the room on its own, through Parley's checks (this project only, no secrets).",
    );
    return 0;
  },

  async install({ values, paths, io, env }) {
    const { installedEntry, isCurrent, install, serverEntry } =
      await import("./install.js");
    const wanted = serverEntry({ cliPath: CLI_PATH });
    const current = installedEntry({ env, home: paths.home });
    if (values["dry-run"]) {
      io.out(
        isCurrent(current, wanted)
          ? "Parley's MCP server is already in Claude Code's user configuration; nothing to do."
          : `Would run: claude mcp add-json --scope user parley '${JSON.stringify(wanted)}'`,
      );
      return 0;
    }
    const { action } = install({ env, home: paths.home, cliPath: CLI_PATH });
    io.out(
      action === "same"
        ? "Parley is installed already."
        : `${action === "add" ? "Added" : "Updated"} Parley's MCP server in Claude Code's user configuration (claude mcp list shows it). It does nothing outside a \`parley\` launch; \`parley uninstall\` removes it.`,
    );
    return 0;
  },

  // Parley updates the way it was installed: a git checkout, pulled
  // (fast-forward only) and its dependencies installed again.
  async update({ paths, io, env }) {
    const { spawnSync } = await import("node:child_process");
    const { dirname } = await import("node:path");
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
    if (
      !(await yes(
        io,
        `Update Parley ${VERSION} in ${repo} from ${remote} (git pull --ff-only, then npm install)?`,
      ))
    )
      return 1;
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
    io.out(
      after && after !== VERSION
        ? `Updated Parley ${VERSION} to ${after}. Restart running \`parley\` sessions to use it.`
        : `Parley ${VERSION} is the newest on ${remote}.`,
    );
    const { installedEntry } = await import("./install.js");
    if (installedEntry({ env, home: paths.home }))
      spawnSync(process.execPath, [CLI_PATH, "install"], {
        stdio: "inherit",
        env,
      });
    return 0;
  },

  async uninstall({ paths, io, env }) {
    const { uninstall } = await import("./install.js");
    const { action } = uninstall({ env, home: paths.home });
    io.out(
      action === "remove"
        ? "Removed Parley's MCP server from Claude Code's user configuration. Your keys and rooms stay in ~/.parley."
        : "Parley was not installed.",
    );
    return 0;
  },

  async log({ values, paths, io, cwd }) {
    const { readLog } = await import("./rooms.js");
    const room = await hereRoom(paths, cwd);
    const { cleanLine, clean } = await import("./inbound.js");
    const count = Math.max(1, Math.min(500, Number(values.count ?? 20) || 20));
    for (const e of readLog(paths, room.roomId).slice(-count)) {
      const when = new Date(e.at).toISOString().replace("T", " ").slice(0, 16);
      const who = e.own ? "you" : cleanLine(e.name);
      const what =
        e.kind === "diff"
          ? `diff ${e.id}: ${(e.files ?? []).length} files${e.note ? ` (${cleanLine(e.note, 120)})` : ""}`
          : clean(e.text, 2000);
      io.out(
        `${when}  ${who} ${e.kind === "message" ? "" : `[${e.kind}] `}${what}`,
      );
    }
    return 0;
  },

  async leave({ paths, io, cwd }) {
    const { leaveRoom } = await import("./ops.js");
    const room = await hereRoom(paths, cwd);
    if (
      !(await yes(
        io,
        `Leave room "${room.name}" and delete its keys and messages from this computer?`,
      ))
    )
      return 1;
    leaveRoom(paths, room);
    io.out(`Left "${room.name}".`);
    return 0;
  },

  async relay({ values, io, env }) {
    const { startRelay, RELAY_DEFAULTS } = await import("./relay/server.js");
    const host = values.host ?? env.PARLEY_RELAY_HOST ?? RELAY_DEFAULTS.host;
    const port = Number(
      values.port ?? env.PARLEY_RELAY_PORT ?? RELAY_DEFAULTS.port,
    );
    const relayKey = env.PARLEY_RELAY_KEY ?? "";
    const tlsCert = values["tls-cert"] ?? env.PARLEY_RELAY_TLS_CERT ?? null;
    const tlsKey = values["tls-key"] ?? env.PARLEY_RELAY_TLS_KEY ?? null;
    const relay = await startRelay({
      host,
      port,
      data: values.data ?? env.PARLEY_RELAY_DATA ?? RELAY_DEFAULTS.data,
      relayKey,
      tlsCert,
      tlsKey,
      maxRooms: Number(
        values["max-rooms"] ??
          env.PARLEY_RELAY_MAX_ROOMS ??
          RELAY_DEFAULTS.maxRooms,
      ),
      log: (line) => io.err(line),
    });
    io.out(
      `Parley relay listening on ${relay.tls ? "wss" : "ws"}://${host}:${relay.port}`,
    );
    if (!relayKey)
      io.out(
        "No PARLEY_RELAY_KEY is set, so anyone who can reach this relay can open rooms on it.",
      );
    if (!relay.tls && !["127.0.0.1", "localhost", "::1"].includes(host))
      io.out(
        "No TLS here: put it behind TLS (Caddy, `tailscale serve`) or use it on a tailnet. Parley clients refuse ws:// anywhere else.",
      );
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
    let problems = 0;
    const check = (ok, text, fix = "") => {
      io.out(`${ok ? "ok  " : "FIX "} ${text}${!ok && fix ? `: ${fix}` : ""}`);
      if (!ok) problems++;
    };
    const major = Number(process.versions.node.split(".")[0]);
    check(
      major >= 24,
      `Node ${process.versions.node}`,
      "Parley needs Node 24 or newer",
    );
    try {
      const claude = resolveClaude({ env, home: paths.home });
      const out = spawnSync(claude.command, [...claude.prefix, "--version"], {
        encoding: "utf8",
        windowsHide: true,
      });
      check(
        out.status === 0,
        `Claude Code ${out.stdout?.trim() ?? ""}`,
        "claude --version failed",
      );
    } catch (error) {
      check(false, "Claude Code", error.message);
    }
    check(Boolean(loadIdentity(paths)), "Your keys", "run `parley setup`");
    {
      const { installedEntry, isCurrent, serverEntry } =
        await import("./install.js");
      const entry = installedEntry({ env, home: paths.home });
      check(
        isCurrent(entry, serverEntry({ cliPath: CLI_PATH })),
        "Installed, so messages can wake a session",
        entry
          ? "it points at another copy of Parley; run `parley install` again"
          : "run `parley install`",
      );
    }
    const project = projectFor(paths, cwd);
    const room = project && loadRoom(paths, project.roomId);
    check(
      Boolean(room),
      "This folder is in a room",
      "`parley create` or `parley join <invite>`",
    );
    if (room && loadIdentity(paths)) {
      const { syncRoom } = await import("./ops.js");
      const { notices } = await import("./compat.js");
      try {
        const fresh = await syncRoom(paths, loadIdentity(paths), room);
        check(true, `Relay ${room.relay}`);
        for (const line of notices(fresh)) io.out(`note ${line}`);
      } catch (error) {
        check(false, `Relay ${room.relay}`, error.message);
      }
    }
    if (process.platform === "win32")
      io.out(
        "note Claude Code does not sandbox commands on native Windows: keep Parley sessions out of bypass mode (Parley refuses it) and review what you approve.",
      );
    return problems ? 1 : 0;
  },

  // ---- Claude Code's callers ----------------------------------------------

  async hook({ positionals, values, paths, io }) {
    const input = parseJson(readStdin());
    try {
      const { handleHook } = await import("./hooks.js");
      const output = handleHook(positionals[0], input, {
        paths,
        launchId: values.launch ?? null,
      });
      if (output) io.out(JSON.stringify(output));
    } catch (error) {
      // A hook never fails the session, but a toggle that went wrong still
      // stays away from the model.
      if (
        positionals[0] === "user-prompt" &&
        /^\s*\/?parley\s+(on|off|status)\b/i.test(input?.prompt ?? "")
      )
        io.out(
          JSON.stringify({
            decision: "block",
            reason: `Parley could not do that: ${error?.message ?? error}`,
          }),
        );
    }
    return 0;
  },

  async mcp({ values, paths, env }) {
    const { runMcp } = await import("./mcp.js");
    runMcp({
      paths,
      // The launch passes its id on the command line (--mcp-config) or, to
      // the installed server, in the environment.
      launchId: values.launch ?? env.PARLEY_LAUNCH ?? null,
      env: { ...env, PARLEY_VERSION: version() },
    });
    return new Promise(() => {});
  },
};

const helpers = {
  readdirSafe: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  sessionsOn: (paths, readdirSafe) =>
    readdirSafe(paths.sessions)
      .filter((f) => f.endsWith(".json"))
      .map((f) => parseJson(readFileSync(`${paths.sessions}/${f}`, "utf8")))
      .filter((s) => s?.enabled),
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
  log: { count: { type: "string", short: "n" } },
  install: { "dry-run": { type: "boolean" } },
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
};

const HELP = `parley ${version()}: keep each other's agents in the loop.

Start
  parley [claude arguments]   Claude Code with Parley loaded; type \`/parley on\` in a conversation
  parley start [arguments]    the same, for arguments that look like a command ("parley start fix it")

Set up (each needs you at a terminal)
  parley install              let Claude Code wake a session for new messages (once)
  parley setup [--name N]     your keys and the name members see
  parley create --relay URL   open a room for this project and print its invite
  parley join <invite>        join a room from an invite
  parley approve [who]        let in someone who joined, after comparing fingerprints
  parley block <who>          stop writing to and reading from a member
  parley invite               print this room's invite again
  parley leave                take this folder out of its room
  parley uninstall            undo parley install

Everyday
  parley status               you, this folder's room, its members, where Parley is on
  parley log [-n 20]          the latest messages, notes and diffs
  parley off                  turn Parley off in every conversation
  parley approvals [on|off]   ask you before each message, note and diff your agent sends (off by default)
  parley doctor               check the setup
  parley update               update Parley (git pull, npm install)

Host a relay
  parley relay [--host H] [--port P] [--data FILE] [--tls-cert C --tls-key K]
                              PARLEY_RELAY_KEY limits who can open rooms

In a conversation: \`/parley on\`, \`/parley off\`, \`/parley status\`.`;

export async function main(
  argv = process.argv.slice(2),
  { env = process.env, cwd = process.cwd(), io = defaultIo() } = {},
) {
  const paths = pathsFor(env);
  const [first, ...rest] = argv;
  if (first === "--version" || first === "-v") {
    io.out(version());
    return 0;
  }
  if (first === "help" || first === "--help" || first === "-h") {
    io.out(HELP);
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
    });
  }
  const command = COMMANDS[first];
  if (!command)
    throw new UsageError(
      `Unknown command "${first}". \`parley help\` lists them; \`parley start ...\` passes arguments to claude.`,
    );
  const { values, positionals } = parseArgs({
    args: rest,
    options: OPTIONS[first] ?? {},
    allowPositionals: true,
    strict: true,
  });
  return command({ values, positionals, paths, io, cwd, env });
}

function defaultIo() {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
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
  "InstallError",
]);
const isUsage = (error) =>
  error instanceof UsageError ||
  String(error?.code ?? "").startsWith("ERR_PARSE_ARGS");

const same = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
if (process.argv[1] && same(CLI_PATH, realpathSync(process.argv[1]))) {
  main().then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (error) => {
      const plain =
        PLAIN_ERRORS.has(error?.constructor?.name) || isUsage(error);
      process.stderr.write(
        `parley: ${plain ? error.message : (error?.stack ?? error)}\n`,
      );
      process.exitCode = isUsage(error) ? 2 : 1;
    },
  );
}
