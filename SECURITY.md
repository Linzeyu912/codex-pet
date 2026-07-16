# Security policy

## Supported version

Security fixes are made on the latest commit of the `main` branch. Older local
builds and locally modified classic-penguin assets are not supported.

## Reporting a vulnerability

Please use GitHub's private **Security advisories → Report a vulnerability**
flow for this repository. Do not open a public issue for a vulnerability that
could put users or their files at risk.

Include the affected version, Windows version, reproduction steps, expected
impact, and any relevant log excerpts. Remove usernames, home-directory paths,
tokens, repository secrets, and private task content before attaching logs.

The project writes only to its project build directories, the selected
`CODEX_HOME/pets` installation directory, `%LOCALAPPDATA%/Codex Pet`, and the
small state directory documented by the application. Please report any path
escape or unexpected write as a security issue.
