# Changelog

All notable project changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Original MIT-licensed Aurora Penguin public character sources, including a
  dedicated connected-flipper waving pose.

### Changed

- Clean clones, Codex installation, CI, and public desktop installers now use the
  complete Aurora mascot instead of the geometric placeholder.
- Tauri 2 is now the single public desktop runtime; automatic roaming,
  explicit action controls, tray behavior, autostart, window-state persistence,
  and NSIS packaging no longer compete with a separate WPF implementation.
- The generated public atlas now enforces uniform upright scale, exact
  translated hover-jump frames, semantic gaze direction, detached-component
  rejection, and zero partial-alpha or hidden-RGB edge pixels.

## [0.2.0] - 2026-07-16

### Added

- Atomic Codex pet installation with ownership receipts, conflict detection,
  timestamped backups, dry-run support, and a reversible uninstall command.
- Expiring, session-aware desktop state payloads with backward compatibility
  for the original `state` / `updatedAt` format.
- A local-only `4 × 4` desktop pose atlas for coherent side, back, mischief,
  lying, and rolling sequences in the WPF and Tauri runtimes.
- A unified verification and public release gate for TypeScript, Node,
  PowerShell, animation continuity, atlas validation, WPF smoke tests, and
  Rust/Tauri compilation plus CI unit tests.
- Windows CI, tag release automation, build manifests, and SHA-256 sidecars.
- Explicit software, asset, contribution, and security policies.

### Changed

- Portable archives use the `package.json` version and public-safe placeholder
  assets by default.
- Desktop startup records diagnostics and makes early failures visible.
- Desktop animation uses the official V2 frame timings, directional running
  while dragging, and loop-boundary exits or edge turns instead of mid-gait
  switches; failed states play once and then hold their fallen frame.
- The state bridge now consumes Codex's official hyphenated `thread-id`, safely
  expires malformed non-idle payloads, and keeps new local actions independent
  from an earlier drag-release transition.
- Local classic atlases now require a SHA-bound V2 QA summary with zero-warning
  continuity, unanimous three-reviewer coverage of all 14 blind-direction pairs,
  a zero-residue low-alpha cyan-edge audit, and all final-review checks.

### Security

- Public builds reject locally supplied classic-penguin artwork. A deliberate
  local-only build is visibly marked and blocked in CI; stale or unverified
  generated release artifacts are removed before packaging and rejected by the gate.
- Generated asset, release, install, and backup paths reject symlink/junction
  escapes; install receipts are identity-bound before any backup can be restored.

## [0.1.0] - 2026-07-14

### Added

- Initial Codex-compatible desktop pet prototype and Windows portable runner.
