# Contributing

Thank you for improving Codex Pet. Keep changes focused and verify them on
Windows before requesting review.

## Development checks

1. Install the pinned dependencies with `pnpm install --frozen-lockfile`.
2. Run `pnpm verify` for source, web, PowerShell, atlas, and continuity checks.
3. Run `pnpm release:gate` before publishing a Windows installer.
4. Use `pnpm assets:install -- --dry-run` before changing a Codex profile.

`package.json` is the single source of the project version. Keep
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` synchronized; the
version check rejects mismatches.

## Asset contributions

Do not commit QQ, Tencent, OpenAI, or other third-party character artwork
without a clearly documented redistribution license. Local third-party
references and their generated derivatives must remain inside ignored local
directories. Public pull requests and releases use the original Aurora
Penguin assets documented in `ASSET-LICENSES.md`.

By contributing code or original assets, you confirm that you have the right
to submit them under the repository's MIT license and the terms recorded in
`ASSET-LICENSES.md`.
