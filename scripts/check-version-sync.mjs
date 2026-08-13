import { promises as fs } from "node:fs";
import path from "node:path";
import { projectRoot, readJson, readPackage } from "./lib/project-utils.mjs";

const packageJson = await readPackage();
const version = packageJson.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json contains an invalid SemVer version: ${version}`);
}

const tauriConfigPath = path.join(projectRoot, "src-tauri", "tauri.conf.json");
const tauriConfig = await readJson(tauriConfigPath);
const cargoTomlPath = path.join(projectRoot, "src-tauri", "Cargo.toml");
const cargoToml = await fs.readFile(cargoTomlPath, "utf8");
const packageSection = cargoToml.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
const cargoVersion = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
const cargoLock = await fs.readFile(path.join(projectRoot, "src-tauri", "Cargo.lock"), "utf8");
const cargoLockVersion = cargoLock.match(/\[\[package\]\]\s*\nname = "codex-pet"\s*\nversion = "([^"]+)"/)?.[1];
const readme = await fs.readFile(path.join(projectRoot, "README.md"), "utf8");
const readmeVersion = readme.match(/当前版本：`([^`]+)`/)?.[1];
const contract = await fs.readFile(path.join(projectRoot, "docs", "codex-pet-contract.md"), "utf8");
const contractVersion = contract.match(/Codex Pet `([^`]+)`/)?.[1];
const changelog = await fs.readFile(path.join(projectRoot, "CHANGELOG.md"), "utf8");

const mismatches = [];
if (tauriConfig.version !== version) mismatches.push(`src-tauri/tauri.conf.json: ${tauriConfig.version}`);
if (cargoVersion !== version) mismatches.push(`src-tauri/Cargo.toml: ${cargoVersion ?? "missing"}`);
if (cargoLockVersion !== version) mismatches.push(`src-tauri/Cargo.lock: ${cargoLockVersion ?? "missing"}`);
if (readmeVersion !== version) mismatches.push(`README.md: ${readmeVersion ?? "missing"}`);
if (contractVersion !== version) mismatches.push(`docs/codex-pet-contract.md: ${contractVersion ?? "missing"}`);
if (!changelog.includes(`## [${version}]`)) mismatches.push(`CHANGELOG.md: missing ${version} release heading`);
if (mismatches.length > 0) {
  throw new Error(
    `package.json is the version source (${version}), but these files differ:\n  - ${mismatches.join("\n  - ")}`,
  );
}

const tagArgumentIndex = process.argv.indexOf("--tag");
const explicitTag = tagArgumentIndex >= 0 ? process.argv[tagArgumentIndex + 1] : null;
const githubTag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : null;
const tag = explicitTag ?? githubTag;
if (tag && tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match package.json version v${version}.`);
}

console.log(`Version sync passed: ${version}${tag ? ` (${tag})` : ""}`);
