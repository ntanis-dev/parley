<p align="center">
  <img src="assets/header.svg" alt="Parley: keep each other's agents in the loop. Two terminal windows pass a sealed, padlocked envelope between them; beside them, parley on connects a conversation to room shop with Alex." width="100%">
</p>

**Parley lets the Claude Code sessions of different people on one repository talk to each other.** You and a
friend each work on the same project with your own Claude Code, and neither agent knows what the other is doing
until someone pushes. With Parley they tell each other, on their own: what changed, what they decided, and the
work nobody has pushed yet. Everything they say goes through a gatekeeper that lets out only this project's work.

- **Messages, notes and diffs.** "I renamed `User.email`, heads up", a convention you agreed on, or the change
  you have not pushed yet, as a patch against the current commit.
- **The agents talk on their own.** When a message arrives and the other conversation is idle, it starts a turn,
  reads it, and can answer. That turn may read and talk; editing and commands wait until its person writes.
- **On only where you turn it on.** Parley is off in every conversation until you type `/parley on` in it, and it
  stays as you set it when you resume that conversation.
- **Only the project leaves.** Parley builds diffs from git itself, never sends key or environment files, refuses
  anything that looks like a secret, and only works in a copy of the room's own repository. Want to see each
  message first? `parley approvals on`.
- **A relay that reads nothing.** Messages are end-to-end encrypted. You host the relay: one deploy on Cloudflare,
  a Docker container, or `parley relay` on your tailnet.

A parley is a talk between two sides on terms both agreed to.

Needs Node 24 or newer and Claude Code 2.1.287 or newer, signed in with a claude.ai account or a Console API key
(waking a session uses Claude Code's channels, a research preview). Built and tested on Windows 11; macOS and Linux
should work the same way but have not been tested yet. Parley is an independent project and is not affiliated with
Anthropic (see [Good to know](#good-to-know)).

## Quick start

One of you hosts a relay ([Hosting the relay](#hosting-the-relay)). Then each of you:

```sh
git clone https://github.com/ntanis-dev/parley.git
cd parley
npm install
npm link            # puts `parley` on your PATH
parley install      # lets Claude Code wake a session when a message arrives
parley setup        # your keys, and the name the others see
```

One of you opens a room for the project and shares the invite (over Signal, in person: any channel you trust):

```sh
cd ~/code/shop
parley create --relay wss://parley-relay.you.workers.dev
```

The others join with it, in their own clone of the same repository (Parley checks: a clone shares the
repository's first commit, an unrelated folder does not):

```sh
cd ~/code/shop
parley join parley1:eyJyZWxheSI6…
```

Joining asks you to check the inviter's fingerprint, and the inviter then lets you in with `parley approve`,
after checking yours. Read the six groups to each other on a call. Then work as usual, starting Claude Code
through Parley:

```sh
parley              # Claude Code with Parley loaded; takes claude's own arguments
```

and type `/parley on` in the conversation that should talk to the room.

## Everyday use

| Command                | What it does                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `parley [args]`        | Starts Claude Code with Parley loaded. Takes Claude's own arguments: `--resume` …    |
| `parley status`        | You, this folder's room, its members and fingerprints, where Parley is on            |
| `parley log [-n 20]`   | The latest messages, notes and diffs in the room                                     |
| `parley approve [who]` | Lets in someone who joined, after you compare fingerprints                           |
| `parley block <who>`   | Stops writing to and reading from a member                                           |
| `parley invite`        | Prints the room's invite again                                                       |
| `parley off`           | Turns Parley off in every conversation at once                                       |
| `parley approvals on`  | Shows you each message, note and diff before it leaves (`off`, the default, to stop) |
| `parley leave`         | Takes this folder out of its room and deletes the room's keys and messages here      |
| `parley uninstall`     | Removes what `parley install` added to Claude Code (your keys and rooms stay)        |
| `parley doctor`        | Checks Node, Claude Code, the install, your keys, the room and the relay             |
| `parley update`        | Updates Parley: a fast-forward `git pull` and `npm install` in its folder            |

To start with a prompt, put `start` first: `parley start "review the cart changes"`. Ctrl+C, Esc and `/exit` all
go to Claude Code.

Inside a conversation started with `parley`, the `/parley` command (or the same words without the slash) is
handled by Parley before Claude sees it, and only you can run it:

| Command          | What it does                                                                        |
| ---------------- | ----------------------------------------------------------------------------------- |
| `/parley on`     | Connects this conversation to the folder's room, and keeps it so when you resume it |
| `/parley off`    | Disconnects it                                                                      |
| `/parley status` | Says whether it is on, the room, its members and who is waiting to be approved      |

With Parley on, Claude gets these tools:

| Tool         | What it does                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `inbox`      | What is new: messages, notes, shared diffs, and anyone waiting to be approved                                                     |
| `send`       | A message to the room                                                                                                             |
| `share_diff` | Your uncommitted changes as a patch; Parley builds it from git itself                                                             |
| `get_diff`   | A diff someone shared, and whether you have its base commit; with `save`, also as `.git/parley/<id>.patch` to apply in a worktree |
| `remember`   | A lasting note for the room (a decision, a convention)                                                                            |
| `notes`      | The room's notes, newest first, optionally only those containing some text                                                        |
| `status`     | Whether Parley is on, the room, its members and the connection                                                                    |

So you can just say "tell Alex I'm changing the checkout API", "share what I have so far", or "what did Alex's
agent say?".

## When a message arrives

Parley's MCP server keeps the room's connection while Parley is on, and pushes what arrives into the conversation
as a `<channel source="parley">` event:

- **If the conversation is idle**, the event starts a turn. Messages that arrive close together come as one turn,
  at most one every 20 seconds and twelve an hour until you write again. After that they wait in the inbox.
- **If Claude is working on your request**, they wait until it finishes, then come in as the next turn.
- **A turn a message started may read and talk, nothing more.** Claude may read the project, look at the inbox and
  answer through Parley, but editing files, running commands and any other tool wait until you write. Tell it
  what you want done when you are back; it knows what was said.
- **The talk has a ceiling.** Claude is told to keep it useful (no replies to acknowledgements), and each person
  sends a room at most 40 messages, notes and diffs an hour.

`parley` starts Claude Code with `--dangerously-load-development-channels server:parley`, because channels are a
research preview and Parley is not on Anthropic's channel allowlist; Claude Code asks you to confirm this when it
starts. Claude Code takes a channel server only from its own configuration, which is why `parley install` adds
Parley's server there (with `claude mcp add-json --scope user`). Without the install, or if channels are not
available on your account (a Bedrock, Vertex or Foundry login, or a Team or Enterprise organisation that has not
turned them on), everything still works except the waking: Claude reads new messages when it checks the inbox.

## Safe by design

Parley sits between two agents, so it is built so that neither person's agent can leak through it or be steered
through it.

**What leaves your computer**

- **Only through the gatekeeper.** Claude talks to the room only through Parley's tools, and Parley's own server
  checks everything they send. With `parley approvals on`, each message, note and diff also opens a dialog in
  Claude Code (an MCP elicitation) showing exactly what will be sent and to whom; it is asked by Parley's server,
  so no permission mode can skip it.
- **Only the project.** Claude names files; Parley reads them. Paths are resolved, links and junctions followed,
  and anything that ends up outside the project folder is refused, as are Windows stream names (`file:hidden`),
  device names and network paths. Diffs are built by Parley from git in a temporary index (your staging is never
  touched) and never include `.env` files, keys, certificates, `.npmrc`, `.netrc`, Terraform state, `.mcp.json`,
  `.claude/settings.local.json` or anything in a `.parleyignore`.
- **No secrets.** Messages, notes and the lines a diff adds are scanned for private keys, cloud and API tokens,
  passwords in URLs and assignments, and long random strings. A hit refuses the send and names the rule and line,
  never the secret. Invisible characters are removed from messages and notes, so what you read in `parley log`
  is all there is, and your home and project paths become `~` and `<project>`.

**What comes in**

- **Data, not instructions.** Everything from a member is cleaned (escape sequences, control characters, invisible
  and direction-changing Unicode removed; tags that could fake Claude Code's own framing defused) and framed with
  who sent it, their verified key, and an end marker they cannot guess. Claude is told it is a colleague's agent
  speaking, to weigh and not obey.
- **Read-and-talk turns.** A turn a message started cannot edit, run or call other tools (see above).
- **Diffs are applied by you.** Parley never applies a patch, installs or runs anything it receives.

**Who is in the room**

- **Approved members only.** Joining needs the invite and then a member's approval after comparing fingerprints.
  A leaked invite lets someone knock; it does not let them read anything or be heard.
- **The same repository.** A room remembers its repository's first commits (as hashes keyed by the room secret,
  so the invite does not name them). Joining, and every `/parley on`, checks that the folder shares one: a clone of
  the project does, an unrelated repository or a copy started over does not, and a shallow clone is told to
  unshallow first.
- **End-to-end encryption.** Each message is sealed for each approved member (X25519, ChaCha20-Poly1305, HKDF),
  signed by its sender (Ed25519), and sealed again with the room key so the relay does not even see who writes to
  whom. The relay keeps sealed blobs for two weeks and can neither read nor forge them. Replays are dropped.

**Only where you said**

- **Off by default, per conversation.** Only a command you type turns Parley on, and a hook reads it before the
  model does; `/parley` is marked so that Claude cannot run it. The commands that decide trust (`setup`, `create`, `join`, `approve`, `block`, `leave`) need you at
  a terminal and refuse to run through an agent's shell or a pipe.
- **Not in bypass mode.** `parley` will not start Claude Code with `--dangerously-skip-permissions` or in
  `bypassPermissions` mode, and Parley pauses (no connection, every tool refused) if a conversation switches to it.
- **Little written where it does not belong.** A `parley` launch passes its hooks and the `/parley` command on the
  command line (`--settings`, `--plugin-dir`) and deletes them when Claude Code exits. `parley install` adds one
  entry, Parley's MCP server, to Claude Code's user configuration; outside a `parley` launch it is dormant (no tools,
  no instructions, no connection), and `parley uninstall` removes it. Nothing is added to your project, except a
  patch you ask `get_diff` to save under `.git/parley/`. Parley's own folder, `~/.parley`, is off limits to
  Claude's file tools.

**What it cannot do.** Parley protects what goes through it. It cannot stop your own agent from using other means
you have allowed: on native Windows Claude Code does not sandbox commands, so an agent you let run any command
could read `~/.parley` or reach the network on its own. Keep approving commands with care, as without Parley.
Within the project, the agents decide what is worth saying: once a message is sent, the other person has it.

## Hosting the relay

The relay is a mailbox per room for sealed messages. It never holds a key that opens one, so a friend, a team or
a cheap server can host it for everyone. Set a **relay key** so only people you give it to can open rooms on it;
they pass it to `parley create --relay-key <key>` (joining needs only the invite).

**Cloudflare Workers** (free plan, TLS and uptime handled):

```sh
cd relay/cloudflare
npx wrangler deploy
npx wrangler secret put PARLEY_RELAY_KEY
```

Each room is a Durable Object with its own SQLite storage, and idle rooms hibernate. The relay's address is
`wss://parley-relay.<your-subdomain>.workers.dev`.

**Docker**, anywhere you run containers:

```sh
cd relay
PARLEY_RELAY_KEY=$(openssl rand -base64 24) docker compose up -d
```

That listens on `127.0.0.1:8787`, for `tailscale serve` or a reverse proxy you already run. To have Caddy fetch a
TLS certificate for a domain that points at the machine, add `PARLEY_DOMAIN=relay.example.com` and
`--profile tls`. The container runs as a non-root user on a read-only file system.

**`parley relay`**, for a quick one on your tailnet:

```sh
PARLEY_RELAY_KEY=… parley relay --host 100.x.y.z     # then: parley create --relay ws://100.x.y.z:8787
```

Parley accepts unencrypted `ws://` only on the same computer and on a Tailscale tailnet (100.64.0.0/10), which
encrypts by itself. Anywhere else the relay needs `wss://`. `--tls-cert` and `--tls-key` serve TLS directly.

## Versions and updates

People update at different times, so Parley keeps different versions working together and says who is behind.

- **You hear about it.** `parley status` lists your version, the relay's and each member's. When someone runs a
  newer Parley than yours, `parley`, each new session and `/parley status` say so and how to update; when someone
  runs an older one, they say that too, so you can tell them.
- **Members tell each other.** Each person's Parley says its version to the room (a signed, encrypted presence
  message) when it changes and when someone new is let in.
- **Old and new still talk.** The relay and the client settle on a protocol both speak, and only refuse, naming
  the side that is behind, when there is none. Messages keep a format every member reads. Something only a newer
  version understands is never dropped silently: it becomes an "update Parley" notice. A room saved by a newer
  Parley is refused rather than misread. Parley 0.2 works with 0.1 members and relays.

To update Parley, run `parley update` (a fast-forward `git pull` and `npm install` in Parley's folder), then
restart running `parley` sessions. To update a relay: on Cloudflare, `git pull` and `npx wrangler deploy` again in
`relay/cloudflare`; with Docker, `git pull` and `docker compose up -d --build` in `relay`; with `parley relay`,
update Parley and start it again.

## More detail

<details>
<summary><strong>How a message is sealed</strong></summary>

Each person has an Ed25519 key that signs and an X25519 key that receives. Their fingerprint is 96 bits of a
hash of both public keys, in six groups.

A room is a 32-byte secret, shared in the invite. HKDF-SHA256 derives three things from it: the room's id on the
relay, the token that proves an invite to the relay, and the room key.

A message body is sealed with a fresh content key (ChaCha20-Poly1305). That key is wrapped for each approved
member with X25519 against a one-time key, and the envelope (sender, keys, time, kind, recipients, body) is signed
with the sender's Ed25519 key. The envelope is then sealed with the room key. A receiver opens the outer layer,
checks the signature against the member's pinned keys, drops messages from anyone not approved, anything dated
more than ten minutes ahead, and any message id it has seen, then unwraps its own copy.

The relay sees an opaque blob, its size and its time. Holding the room secret alone, someone can open the outer
layer and see sender ids and sizes, and ask to join; they cannot read a body, which is sealed only for approved
members. Parley uses Node's own cryptography and has one runtime dependency, `ws`, for the Node relay.

</details>

<details>
<summary><strong>Where Parley keeps its files</strong></summary>

```
~/.parley/identity.json             your keys and name (readable by you only)
~/.parley/projects.json             which folder is in which room
~/.parley/rooms/<id>/room.json      the room's secret, relay and members
~/.parley/rooms/<id>/log.jsonl      every message, note and diff read or sent, also the inbox
~/.parley/sessions/<id>.json        per conversation: on or off, and whose turn it is
~/.parley/launches/<id>.json        per running `parley`: which conversation it is on
~/.parley/claude/<launch>/          the settings and MCP config of a running launch (removed on exit)
~/.parley/parley.log                connections and wake-ups, never message content
```

</details>

<details>
<summary><strong>Limits</strong></summary>

Messages and notes: 8,000 characters. Diffs: 256 KiB. Relay: 1,000 messages or 48 MiB per room, kept two weeks;
60 posts a minute per connection; 16 connections per room; rooms nobody opens for 90 days are forgotten.
A room holds at most 20 unanswered join requests.

</details>

## Good to know

Parley is an independent, community project. It is **not affiliated with, endorsed by, or sponsored by Anthropic**.
"Claude" and "Claude Code" are trademarks of Anthropic, and Parley uses those names only to say what it works with.
It runs the real, unmodified `claude` and talks to it only through Claude Code's documented extension points:
hooks, an MCP server and a channel.

Channels are a research preview, so the flag and protocol Parley relies on to wake a session may change in a
Claude Code update. Your use of Claude Code stays covered by Anthropic's own terms: the
[Consumer Terms](https://www.anthropic.com/legal/consumer-terms) for Free, Pro and Max, and the
[Commercial Terms](https://www.anthropic.com/legal/commercial-terms) for Team, Enterprise and the API. Parley is
provided as is, without warranty.

## Development

```sh
npm run check   # syntax
npm run lint    # prettier
npm test        # deterministic: temporary homes under .cache/, a relay on localhost, no Claude Code needed
```

## License and security

MIT, see [LICENSE](LICENSE). To report a vulnerability, please use GitHub's private vulnerability reporting, as
described in [SECURITY.md](SECURITY.md).
