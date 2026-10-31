# Security Policy

Hypdriv ships security features (CSP generation, security headers, rate limiting, bot shielding, session encryption, webhook verification, secrets scanning). Bugs in those features can weaken applications that rely on them, so we treat security reports with priority.

## Supported versions

| Version                              | Supported                                              |
| ------------------------------------ | ------------------------------------------------------ |
| 0.1.x (Preview)                      | yes, security fixes land on the latest Preview version |
| latest minor of the current major    | yes (from 1.0)                                         |
| previous major                       | security fixes for 6 months after the next major ships (from 2.0) |
| older                                | no                                                     |

## Reporting a vulnerability

Please **do not** open a public issue. Report the vulnerability privately through GitHub's private vulnerability reporting (the **Report a vulnerability** button on the repository's *Security* tab) with:

- the affected package(s) and version(s),
- a description of the issue and its impact,
- steps or a proof of concept to reproduce it.

You will receive an acknowledgement within 72 hours and a status update at least every 7 days. We aim to release a fix within 30 days of confirmation, coordinated with you on disclosure timing. Credit is given in the release notes unless you prefer otherwise.

## Scope notes

- Hypdriv's CSP and header presets are defaults; the application owner remains responsible for the final policy. Reports about _defaults that are weaker than they should be_ are welcome.
- Reports about third-party dependencies should go to the respective project, but tell us too so we can bump versions quickly.
- The `hypdriv secrets` scanner is heuristic. A pattern it does not detect is a feature request, not a vulnerability, unless documentation claims otherwise.
