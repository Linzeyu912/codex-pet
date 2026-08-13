import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listFilesRecursively,
  pathExists,
  projectRoot,
  readJson,
  readPackage,
  sha256File,
} from "./lib/project-utils.mjs";

const packageJson = await readPackage();
const version = packageJson.version;
const profile = process.argv.includes("--debug") ? "debug" : "release";
const violations = [];
const tauriConfig = await readJson(path.join(projectRoot, "src-tauri", "tauri.conf.json"));
if (tauriConfig.version !== version) violations.push(`Tauri config version is ${tauriConfig.version}`);
if (tauriConfig.productName !== "Codex Pet") violations.push(`unexpected Tauri product name: ${tauriConfig.productName}`);
if (tauriConfig.identifier !== "io.github.linzeyu912.codex-pet") {
  violations.push(`unexpected Tauri identifier: ${tauriConfig.identifier}`);
}
if (!tauriConfig.bundle?.active || !tauriConfig.bundle?.targets?.includes("nsis")) {
  violations.push("Tauri NSIS bundling is not enabled");
}

const petManifestPath = path.join(projectRoot, "public", "local", "pet.json");
if (!(await pathExists(petManifestPath))) {
  violations.push("generated public pet manifest is missing");
} else {
  const manifest = await readJson(petManifestPath);
  if (manifest.id !== "codex-aurora-penguin") violations.push(`unexpected public pet id: ${manifest.id}`);
  if (manifest.spriteVersionNumber !== 2) violations.push("public pet manifest is not V2");
}

let trackedFiles = [];
try {
  trackedFiles = execFileSync("git", ["-C", projectRoot, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));
} catch (error) {
  violations.push(`unable to inspect Git tracked files: ${error.message}`);
}

const forbiddenTrackedPrefixes = [".local-assets/", "public/local/", "release/", "src-tauri/target/"];
const approvedPublicRasters = new Set([
  "public/aurora-penguin.png",
  "public/aurora-penguin-wave.png",
]);
for (const file of trackedFiles) {
  if (forbiddenTrackedPrefixes.some((prefix) => file.startsWith(prefix))) {
    violations.push(`local/generated asset is tracked by Git: ${file}`);
  }
  if (
    /\.(?:png|webp|gif|jpe?g)$/i.test(file)
    && !file.startsWith("src-tauri/icons/")
    && !approvedPublicRasters.has(file)
  ) {
    violations.push(`unapproved raster asset is tracked by Git: ${file}`);
  }
}

for (const sourceAsset of approvedPublicRasters) {
  if (!trackedFiles.includes(sourceAsset)) violations.push(`approved public mascot source is not tracked: ${sourceAsset}`);
}

const bundleRoot = path.join(projectRoot, "src-tauri", "target", profile, "bundle", "nsis");
const installers = (await pathExists(bundleRoot))
  ? (await listFilesRecursively(bundleRoot)).filter((file) => file.toLowerCase().endsWith(".exe"))
  : [];
const matchingInstallers = installers.filter((file) => path.basename(file).includes(version));
const installerPath = matchingInstallers[0] ?? null;
if (matchingInstallers.length !== 1) {
  violations.push(`expected exactly one versioned NSIS installer, found ${matchingInstallers.length}`);
} else {
  const stats = await stat(installerPath);
  if (stats.size < 1_000_000) violations.push(`NSIS installer is unexpectedly small: ${stats.size} bytes`);
  if (/local-classic|qq-penguin/i.test(path.basename(installerPath))) {
    violations.push(`NSIS installer name suggests local-only assets: ${path.basename(installerPath)}`);
  }

  const checksumPath = `${installerPath}.sha256`;
  const metadataPath = `${installerPath}.release.json`;
  const actualSha256 = await sha256File(installerPath);
  if (!(await pathExists(checksumPath))) {
    violations.push("installer SHA-256 sidecar is missing");
  } else {
    const checksum = (await readFile(checksumPath, "utf8")).trim();
    if (checksum !== `${actualSha256}  ${path.basename(installerPath)}`) {
      violations.push("installer SHA-256 sidecar does not match the artifact");
    }
  }

  if (!(await pathExists(metadataPath))) {
    violations.push("installer release metadata is missing");
  } else {
    let metadata = null;
    try {
      metadata = await readJson(metadataPath);
    } catch (error) {
      violations.push(`installer release metadata is invalid JSON: ${error.message}`);
    }
    if (metadata) {
      const currentCommit = execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const currentDirtyFiles = execFileSync(
        "git",
        ["-C", projectRoot, "diff", "--name-only", "HEAD", "--"],
        { encoding: "utf8" },
      )
        .split(/\r?\n/)
        .filter(Boolean);
      const builtAt = Date.parse(metadata.builtAt);
      if (metadata.schema !== "codex-pet-release/v1") violations.push(`unexpected release metadata schema: ${metadata.schema}`);
      if (metadata.version !== version) violations.push(`release metadata version is ${metadata.version}`);
      if (metadata.profile !== profile) violations.push(`release metadata profile is ${metadata.profile}`);
      if (metadata.artifact !== path.basename(installerPath)) violations.push("release metadata artifact name differs");
      if (metadata.bytes !== stats.size) violations.push("release metadata artifact size differs");
      if (metadata.sha256 !== actualSha256) violations.push("release metadata SHA-256 differs");
      if (metadata.commit !== currentCommit) violations.push("release metadata was built from a different commit");
      if (!Array.isArray(metadata.dirtyFiles) || metadata.dirtyFiles.some((file) => typeof file !== "string")) {
        violations.push("release metadata dirtyFiles is invalid");
      }
      if (!Number.isFinite(builtAt) || builtAt + 5_000 < stats.mtimeMs || builtAt > Date.now() + 300_000) {
        violations.push("release metadata build time is invalid or older than the installer");
      }
      if (profile === "release" && (metadata.sourceDirty !== false || currentDirtyFiles.length > 0)) {
        const dirtyFiles = [
          ...(Array.isArray(metadata.dirtyFiles) ? metadata.dirtyFiles : []),
          ...currentDirtyFiles,
        ];
        violations.push(
          `formal release artifacts must be built from a clean worktree${dirtyFiles.length ? `: ${[...new Set(dirtyFiles)].join(", ")}` : ""}`,
        );
      }
    }
  }
}

const desktopBinary = path.join(projectRoot, "src-tauri", "target", profile, "codex-pet.exe");
if (!(await pathExists(desktopBinary))) {
  violations.push(`${profile} desktop binary is missing`);
} else {
  const isolatedProfile = await mkdtemp(path.join(os.tmpdir(), "codex-pet-release-e2e-"));
  const statePath = path.join(isolatedProfile, "state.json");
  const payload = JSON.stringify({ type: "agent-turn-complete", "thread-id": "release-e2e" });
  const startedAt = Date.now();
  try {
    const result = spawnSync(desktopBinary, ["--codex-notify", payload], {
      env: { ...process.env, CODEX_PET_STATE_PATH: statePath },
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.error) {
      violations.push(`packaged notification bridge failed to launch: ${result.error.message}`);
    } else if (result.status !== 0) {
      violations.push(`packaged notification bridge exited with ${result.status}: ${result.stderr.trim()}`);
    } else if (!(await pathExists(statePath))) {
      violations.push("packaged notification bridge did not create state.json");
    } else {
      const state = await readJson(statePath);
      if (state.state !== "jumping") violations.push(`packaged notification bridge wrote state ${state.state}`);
      if (state.source !== "codex-notify") violations.push(`packaged notification bridge wrote source ${state.source}`);
      if (state.sessionId !== "release-e2e") violations.push("packaged notification bridge lost the thread id");
      if (!Number.isSafeInteger(state.updatedAt) || state.updatedAt < startedAt || state.updatedAt > Date.now() + 2_000) {
        violations.push("packaged notification bridge wrote an invalid update time");
      }
      if (state.expiresAt !== state.updatedAt + 8_000) {
        violations.push("packaged notification bridge wrote an invalid expiry");
      }
    }
  } finally {
    await rm(isolatedProfile, { recursive: true, force: true });
  }
}

if (violations.length > 0) {
  throw new Error(`PUBLIC RELEASE BLOCKED:\n  - ${violations.join("\n  - ")}`);
}

console.log(`Tauri public installer gate passed (${profile}): ${path.basename(matchingInstallers[0])}`);
