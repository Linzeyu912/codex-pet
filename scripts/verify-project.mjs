import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { projectRoot } from "./lib/project-utils.mjs";

const argumentsSet = new Set(process.argv.slice(2));
const release = argumentsSet.has("--release");
const ci = argumentsSet.has("--ci") || process.env.CI === "true";
const withTauri = argumentsSet.has("--with-tauri") || ci;
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const safeEnvironment = { ...process.env, CODEX_PET_FORCE_PLACEHOLDER: "1" };

function run(label, command, args, options = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: options.env ?? safeEnvironment,
    stdio: "inherit",
    shell: options.shell ?? false,
    timeout: options.timeout ?? 10 * 60 * 1000,
  });
  if (result.error) {
    if (options.optional && result.error.code === "ENOENT") {
      console.warn(`${label} skipped: ${command} is unavailable.`);
      return false;
    }
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.optional) {
      console.warn(`${label} reported a non-zero status (${result.status}); continuing as best effort.`);
      return false;
    }
    throw new Error(`${label} failed with exit code ${result.status}.`);
  }
  return true;
}

async function listScripts(directory) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await listScripts(filePath)));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) output.push(filePath);
  }
  return output.sort();
}

run("Version consistency", process.execPath, ["scripts/check-version-sync.mjs"]);
for (const filePath of await listScripts(path.join(projectRoot, "scripts"))) {
  run(`Node syntax: ${path.relative(projectRoot, filePath)}`, process.execPath, ["--check", filePath]);
}
run("Quality-gate self-tests", process.execPath, ["scripts/test-quality-gates.mjs"]);
run("State bridge self-tests", process.execPath, ["scripts/test-state-bridge.mjs"]);
run("Install safety self-tests", process.execPath, ["scripts/test-install-safety.mjs"]);
run("TypeScript check", process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]);
run("Web production build", process.execPath, ["node_modules/vite/bin/vite.js", "build"]);
run("Rights-safe placeholder atlas", process.execPath, ["scripts/prepare-local-assets.mjs"]);
run("Animation continuity", process.execPath, ["scripts/check-animation-continuity.mjs"]);

if (process.platform === "win32") {
  run("PowerShell syntax", powershell, ["-NoProfile", "-File", "scripts/Test-PowerShellSyntax.ps1"]);
  run("Official Codex atlas validation when available", powershell, [
    "-NoProfile",
    "-File",
    "scripts/Try-ValidateCodexAtlas.ps1",
  ]);

  if (release && !ci) {
    const actions = [
      "idle",
      "running-right",
      "running-left",
      "waving",
      "jumping",
      "failed",
      "waiting",
      "running",
      "review",
      "looking",
      "rolling",
      "lying",
      "mischief",
    ];
    for (const action of actions) {
      run(`WPF smoke: ${action}`, powershell, [
        "-NoProfile",
        "-File",
        "windows/CodexPet.ps1",
        "-Smoke",
        "-SmokeAction",
        action,
      ], { timeout: 30_000 });
    }
  }
}

if (withTauri) {
  run("Rust/Tauri compile check", "cargo", [
    "check",
    "--locked",
    "--manifest-path",
    "src-tauri/Cargo.toml",
  ], { optional: !ci, timeout: 20 * 60 * 1000 });
  if (ci) {
    run("Rust/Tauri unit tests", "cargo", [
      "test",
      "--locked",
      "--lib",
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ], { timeout: 20 * 60 * 1000 });
  }
}

if (release) {
  if (process.platform !== "win32") throw new Error("Portable public release builds require Windows.");
  run("Public-safe portable package", powershell, ["-NoProfile", "-File", "windows/Build-Portable.ps1"]);
  run("Public release policy", process.execPath, ["scripts/check-public-release.mjs"]);
}

console.log(`\nVerification passed${release ? " with the public release gate" : ""}.`);
