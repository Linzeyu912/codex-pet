import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  listFilesRecursively,
  pathExists,
  projectRoot,
  readPackage,
  sha256File,
} from "./lib/project-utils.mjs";

const packageJson = await readPackage();
const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : "release";
if (!new Set(["debug", "release"]).has(profile)) {
  throw new Error(`Unsupported release metadata profile: ${profile}`);
}

const bundleRoot = path.join(projectRoot, "src-tauri", "target", profile, "bundle", "nsis");
const installers = (await pathExists(bundleRoot))
  ? (await listFilesRecursively(bundleRoot)).filter((file) => file.toLowerCase().endsWith(".exe"))
  : [];
const matching = installers.filter((file) => path.basename(file).includes(packageJson.version));
if (matching.length !== 1) {
  throw new Error(`Expected one ${profile} NSIS installer for ${packageJson.version}, found ${matching.length}.`);
}

const installerPath = matching[0];
const artifact = path.basename(installerPath);
const stats = await fs.stat(installerPath);
const sha256 = await sha256File(installerPath);
const commit = execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceDirty = Boolean(
  execFileSync("git", ["-C", projectRoot, "status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim(),
);
const metadata = {
  schema: "codex-pet-release/v1",
  version: packageJson.version,
  profile,
  artifact,
  bytes: stats.size,
  sha256,
  commit,
  sourceDirty,
  builtAt: new Date().toISOString(),
};

await fs.writeFile(`${installerPath}.sha256`, `${sha256}  ${artifact}\n`, "utf8");
await fs.writeFile(`${installerPath}.release.json`, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
console.log(`Release metadata written (${profile}): ${artifact}`);
