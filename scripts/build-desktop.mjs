import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { projectRoot } from "./lib/project-utils.mjs";

const publicEnvironment = {
  ...process.env,
  CODEX_PET_FORCE_PUBLIC_MASCOT: "1",
};

const forwardedArguments = process.argv.slice(2);
const profile = forwardedArguments.includes("--debug") ? "debug" : "release";
if (profile === "release") {
  const dirtyFiles = execFileSync(
    "git",
    ["-C", projectRoot, "diff", "--name-only", "HEAD", "--"],
    { encoding: "utf8" },
  ).trim();
  if (dirtyFiles) throw new Error(`Formal release builds require a clean worktree:\n${dirtyFiles}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: publicEnvironment,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with exit code ${result.status}.`);
}

run(process.execPath, ["scripts/prepare-local-assets.mjs"]);
run(process.execPath, [
  "node_modules/@tauri-apps/cli/tauri.js",
  "build",
  "--bundles",
  "nsis",
  ...forwardedArguments,
  "--",
  "--locked",
]);
run(process.execPath, [
  "scripts/write-release-metadata.mjs",
  "--profile",
  profile,
]);
