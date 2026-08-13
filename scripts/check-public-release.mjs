import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  listFilesRecursively,
  pathExists,
  projectRoot,
  readJson,
  readPackage,
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
if (matchingInstallers.length !== 1) {
  violations.push(`expected exactly one versioned NSIS installer, found ${matchingInstallers.length}`);
} else {
  const stats = await stat(matchingInstallers[0]);
  if (stats.size < 1_000_000) violations.push(`NSIS installer is unexpectedly small: ${stats.size} bytes`);
  if (/local-classic|qq-penguin/i.test(path.basename(matchingInstallers[0]))) {
    violations.push(`NSIS installer name suggests local-only assets: ${path.basename(matchingInstallers[0])}`);
  }
}

const desktopBinary = path.join(projectRoot, "src-tauri", "target", profile, "codex-pet.exe");
if (!(await pathExists(desktopBinary))) violations.push(`${profile} desktop binary is missing`);

if (violations.length > 0) {
  throw new Error(`PUBLIC RELEASE BLOCKED:\n  - ${violations.join("\n  - ")}`);
}

console.log(`Tauri public installer gate passed (${profile}): ${path.basename(matchingInstallers[0])}`);
