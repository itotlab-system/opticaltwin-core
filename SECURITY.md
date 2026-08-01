# Security Policy

## Supported versions

OpticalTwin is research software from a university lab, developed by a small
team. Only the latest release gets fixes; there are no backported patches for
older tags.

| Version | Supported |
|---|---|
| latest release | yes |
| anything older | no |

## Reporting a vulnerability

Please report privately, via GitHub's
[private vulnerability reporting](https://github.com/itotlab-system/opticaltwin-core/security/advisories/new)
on this repository (Security → Report a vulnerability). That keeps the report
between you and the maintainers until there is a fix.

Please do not open a public issue for a security problem.

We will acknowledge a report within about two weeks. We are a small academic
team without an on-call rotation, so please read that as an honest estimate
rather than a service commitment.

## What OpticalTwin does and does not protect

Read this before deploying it anywhere. Several of the following are design
decisions, not oversights, and reporting them as vulnerabilities will only get
you pointed back here.

**The server is designed for a trusted network.** It is intended to run on a
lab LAN among colleagues who already share physical access to the optics room.

- **`OT_PASSWORD` is a shared secret, not an authentication system.** One
  password is shared by everyone. There are no user accounts, no per-user
  permissions, and no audit trail — the server cannot tell who made an edit.
  With `OT_PASSWORD` unset the server is **open to anyone who can reach it**.
- **There is no isolation between projects.** Any authenticated user can read,
  edit, duplicate or delete any project on the server.
- **The server speaks plain HTTP.** Put it behind a reverse proxy terminating
  TLS if it is reachable beyond a trusted LAN. Without that, the shared password
  crosses the network in the clear.
- **Set `OT_SESSION_SECRET`** to a fixed random value in any persistent
  deployment. Otherwise it is regenerated at startup and every session is
  invalidated on restart.
- **Edits write to disk immediately** and undo history is in memory only, so it
  is lost when the server restarts. Back up `projects/` — and keep it in git,
  which is the intended workflow.

**Do not expose this to the public internet.** It has not been reviewed for that
and does not defend against it.

## What we do consider a vulnerability

Within the trusted-LAN model above:

- path traversal or any escape from `projects/` and `components/`
- authentication bypass when `OT_PASSWORD` is set
- remote code execution through a crafted `.usda`, STEP file, or API payload
- a stored XSS reaching another user's browser through project or component names

Reports of these are genuinely welcome.
