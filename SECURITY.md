# Security policy

Please report suspected vulnerabilities privately through GitHub's private vulnerability reporting for this repository. Do not open a public issue containing exploit details, credentials, private data, or an unpatched proof of concept.

Include the affected version or commit, impact, reproduction conditions, and the smallest safe evidence needed to investigate. ntanis.dev will validate the report, coordinate a fix, and publish remediation information when users can act on it.

Parley's whole job is to let two agents talk without either one leaking or taking over the other. These are exactly the reports we want:

- anything that leaves a computer other than through Parley's gatekeeper, or that comes from outside the project folder (a path, a link, a junction, a stream name that gets past the checks);
- a secret that the scanner lets through in a message, a note or a diff;
- a member's message that makes the other agent act as if its own user had asked: edit files or run commands in a turn the message started, approve something, or turn Parley on;
- a way to join a room from a folder that is not a copy of the room's repository;
- anything that lets the relay, or someone holding a leaked invite, read a message, forge a member, or replay one;
- a way for an agent to turn Parley on, approve a member, or join a room without its person.

Only the latest code on the default branch is supported during pre-release development.
