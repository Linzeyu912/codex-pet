import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
const releaseRoot = path.join(projectRoot, "release");
const archiveName = `Codex-Pet-${version}-portable.zip`;
const archivePath = path.join(releaseRoot, archiveName);
const checksumPath = `${archivePath}.sha256`;
const manifestPath = path.join(releaseRoot, `Codex-Pet-${version}-portable.build-manifest.json`);

for (const filePath of [archivePath, checksumPath, manifestPath]) {
  if (!(await pathExists(filePath))) throw new Error(`Public release artifact is missing: ${filePath}`);
}

const manifest = await readJson(manifestPath);
const violations = [];
if (manifest.version !== version) violations.push(`manifest version is ${manifest.version}`);
if (manifest.publicSafe !== true) violations.push("manifest publicSafe is not true");
if (manifest.localOnly !== false) violations.push("manifest localOnly is not false");
if (manifest.flavour !== "public-aurora") violations.push(`unexpected flavour: ${manifest.flavour}`);
if (manifest.petId !== "codex-aurora-penguin") violations.push(`unexpected pet id: ${manifest.petId}`);

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  const normalized = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return normalized;
}

const extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pet-release-check-"));
try {
  let extracted = true;
  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:CODEX_PET_RELEASE_ARCHIVE -DestinationPath $env:CODEX_PET_RELEASE_EXTRACT -Force",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: "pipe",
        env: {
          ...process.env,
          CODEX_PET_RELEASE_ARCHIVE: archivePath,
          CODEX_PET_RELEASE_EXTRACT: extractionRoot,
        },
      },
    );
  } catch (error) {
    extracted = false;
    violations.push(`unable to extract public archive: ${error.message}`);
  }

  if (extracted) {
    const unpackedRoot = path.join(extractionRoot, `CodexPet-${version}-public-aurora`);
    const internalManifestPath = path.join(unpackedRoot, "build-manifest.json");
    const petRoot = path.join(unpackedRoot, "public", "local");
    const petManifestPath = path.join(petRoot, "pet.json");

    if (!(await pathExists(internalManifestPath))) {
      violations.push("archive is missing build-manifest.json");
    } else {
      const internalManifest = await readJson(internalManifestPath);
      if (!isDeepStrictEqual(internalManifest, manifest)) {
        violations.push("archive build-manifest.json does not match the release sidecar");
      }
    }

    if (!(await pathExists(petManifestPath))) {
      violations.push("archive is missing public/local/pet.json");
    } else {
      const petManifest = await readJson(petManifestPath);
      if (petManifest.id !== manifest.petId) violations.push("archive pet.json id does not match the build manifest");
      if (petManifest.spriteVersionNumber !== 2) violations.push("archive pet.json is not a Pets V2 manifest");
      const spritePath = safeRelativePath(petManifest.spritesheetPath);
      if (!spritePath) {
        violations.push("archive pet.json has an unsafe or missing spritesheetPath");
      } else if (!(await pathExists(path.join(petRoot, ...spritePath.split("/"))))) {
        violations.push(`archive pet.json references a missing sprite sheet: ${spritePath}`);
      }
    }

    if (!Array.isArray(manifest.files)) {
      violations.push("build manifest files entry is not an array");
    } else {
      const recordedFiles = new Map();
      for (const entry of manifest.files) {
        const relativePath = safeRelativePath(entry?.path);
        if (
          !relativePath ||
          !Number.isSafeInteger(entry?.bytes) ||
          entry.bytes < 0 ||
          !/^[0-9a-f]{64}$/i.test(entry?.sha256 ?? "") ||
          recordedFiles.has(relativePath)
        ) {
          violations.push(`invalid or duplicate build-manifest file entry: ${entry?.path ?? "<missing>"}`);
          continue;
        }
        recordedFiles.set(relativePath, entry);
      }

      const extractedFiles = (await listFilesRecursively(unpackedRoot))
        .map((filePath) => path.relative(unpackedRoot, filePath).replaceAll("\\", "/"))
        .filter((relativePath) => relativePath !== "build-manifest.json");
      for (const relativePath of extractedFiles) {
        if (!recordedFiles.has(relativePath)) violations.push(`archive contains an unrecorded file: ${relativePath}`);
      }
      for (const [relativePath, entry] of recordedFiles) {
        const absolutePath = path.join(unpackedRoot, ...relativePath.split("/"));
        if (!(await pathExists(absolutePath))) {
          violations.push(`archive is missing a recorded file: ${relativePath}`);
          continue;
        }
        const stats = await fs.stat(absolutePath);
        if (!stats.isFile() || stats.size !== entry.bytes) {
          violations.push(`archive file size does not match build manifest: ${relativePath}`);
          continue;
        }
        if ((await sha256File(absolutePath)) !== entry.sha256.toLowerCase()) {
          violations.push(`archive file SHA-256 does not match build manifest: ${relativePath}`);
        }
      }
    }
  }
} finally {
  await fs.rm(extractionRoot, { recursive: true, force: true });
}

const checksumText = (await fs.readFile(checksumPath, "utf8")).trim();
const expectedHash = checksumText.match(/^([0-9a-f]{64})\s{2}(.+)$/i);
if (!expectedHash || expectedHash[2] !== archiveName) {
  violations.push("SHA-256 sidecar has an invalid format or filename");
} else {
  const actualHash = await sha256File(archivePath);
  if (actualHash !== expectedHash[1].toLowerCase()) violations.push("archive SHA-256 does not match its sidecar");
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

const forbiddenTrackedPrefixes = [".local-assets/", "public/local/", "release/"];
for (const file of trackedFiles) {
  if (forbiddenTrackedPrefixes.some((prefix) => file.startsWith(prefix))) {
    violations.push(`local/generated asset is tracked by Git: ${file}`);
  }
  const approvedPublicRaster = file === "public/aurora-penguin.png"
    || file === "public/aurora-penguin-wave.png";
  if (/\.(?:png|webp|gif|jpe?g)$/i.test(file) && !file.startsWith("src-tauri/icons/") && !approvedPublicRaster) {
    violations.push(`unapproved raster asset is tracked by Git: ${file}`);
  }
}

const localClassicArtifacts = (await pathExists(releaseRoot))
  ? (await fs.readdir(releaseRoot)).filter((name) => /local-classic/i.test(name))
  : [];
if (localClassicArtifacts.length > 0) {
  violations.push(`release directory contains local-only classic artifacts: ${localClassicArtifacts.join(", ")}`);
}

const expectedGeneratedArtifacts = new Set([
  `CodexPet-${version}-public-aurora`,
  archiveName,
  path.basename(checksumPath),
  path.basename(manifestPath),
]);
const unexpectedGeneratedArtifacts = (await pathExists(releaseRoot))
  ? (await fs.readdir(releaseRoot)).filter(
      (name) => /^(?:CodexPet-|Codex-Pet-)/i.test(name) && !expectedGeneratedArtifacts.has(name),
    )
  : [];
if (unexpectedGeneratedArtifacts.length > 0) {
  violations.push(`release directory contains stale or unverified artifacts: ${unexpectedGeneratedArtifacts.join(", ")}`);
}

if (violations.length > 0) {
  throw new Error(`PUBLIC RELEASE BLOCKED:\n  - ${violations.join("\n  - ")}`);
}

console.log(`Public release gate passed: ${archiveName}`);
