# Security policy

Please report suspected vulnerabilities privately through GitHub's private vulnerability reporting for this repository. Do not open a public issue containing exploit details, credentials, private data, or an unpatched proof of concept.

Include the affected version or commit, impact, reproduction conditions, and the smallest safe evidence needed to investigate. ntanis.dev will validate the report, coordinate a fix, and publish remediation information when users can act on it.

Parley's whole job is to let agents work together without any of them leaking or taking over another. These are exactly the reports we want:

- anything that leaves a computer other than through Parley's gatekeeper, or that comes from outside the project folder (a path, a link, a junction, a stream name that gets past the checks);
- a secret that the scanner lets through in a message, a note, a file, a diff or a commit;
- a member's message that makes another agent do more than its person's autonomy setting allows in a turn the message started: run commands, edit outside the project or in `.git`, keys or environment files, force-push, commit secrets, approve someone, or reach anything outside Parley's watch and tools;
- a file a member sends that gets written anywhere but where the receiving agent asked, inside the project;
- a way to join a room from a folder that is not a copy of the room's repository;
- anything that lets the relay, or someone holding a leaked invite, read a message, forge a member, or replay one;
- a way for an agent to start Parley outside a `parley` session, approve a member, join a room, or send a message marked as typed by its person (`parley say`, `parley view`) without its person.

Only the latest code on the default branch is supported during pre-release development.
