import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./lib/project-utils.mjs";

const sourcePath = path.join(projectRoot, "src", "runtime-policy.ts");
const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-pet-runtime-policy-"));
let policy;
try {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      sourcePath,
      "--ignoreConfig",
      "--pretty", "false",
      "--target", "ES2022",
      "--module", "ES2022",
      "--moduleResolution", "bundler",
      "--outDir", outputDirectory,
    ],
    { cwd: projectRoot, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Runtime policy compilation failed:\n${result.stdout}${result.stderr}`);
  policy = await import(pathToFileURL(path.join(outputDirectory, "runtime-policy.js")).href);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}

assert.equal(policy.pickAutonomousAction(() => 0), "running-right");
assert.equal(policy.pickAutonomousAction(() => 0.999999), "idle");
assert.equal(policy.nextAutoActionDelay(() => 0), 12_000);
assert.ok(policy.nextAutoActionDelay(() => 0.999) < 28_000);

const negativeMonitorBounds = { minX: -1920, minY: 0, maxX: -260, maxY: 754 };
const leftward = policy.planAutoRoam(
  { x: -900, y: 600 },
  negativeMonitorBounds,
  "running-left",
  () => 0.5,
);
assert.equal(leftward.direction, "running-left");
assert.equal(leftward.target.y, 600);
assert.ok(leftward.target.x >= -1908 && leftward.target.x <= -272);

const edgeTurn = policy.planAutoRoam(
  { x: -280, y: 500 },
  negativeMonitorBounds,
  "running-right",
  () => 0,
);
assert.equal(edgeTurn.direction, "running-left");
assert.ok(edgeTurn.target.x < -280);

const noRoom = policy.planAutoRoam(
  { x: 15, y: 0 },
  { minX: 0, minY: 0, maxX: 30, maxY: 100 },
  "running-right",
  () => 0,
);
assert.equal(noRoom, null);

assert.equal(policy.easeAutoRoam(-1), 0);
assert.equal(policy.easeAutoRoam(0.5), 0.5);
assert.equal(policy.easeAutoRoam(2), 1);
assert.equal(policy.shouldMoveAutoWindow(63, 0, 0.5), false);
assert.equal(policy.shouldMoveAutoWindow(64, 0, 0.5), true);
assert.equal(policy.shouldMoveAutoWindow(1, 0, 1), true);

assert.equal(policy.animationTickDelay({ hidden: true, paused: false, reducedMotion: false, idle: false }), 1_000);
assert.equal(policy.animationTickDelay({ hidden: false, paused: true, reducedMotion: false, idle: false }), 400);
assert.equal(policy.animationTickDelay({ hidden: false, paused: false, reducedMotion: false, idle: true }), 96);
assert.equal(policy.animationTickDelay({ hidden: false, paused: false, reducedMotion: false, idle: false }), 40);
assert.equal(policy.statePollDelay({ hidden: true, idle: true }), 3_000);
assert.equal(policy.statePollDelay({ hidden: false, idle: true }), 2_000);
assert.equal(policy.statePollDelay({ hidden: false, idle: false }), 750);

console.log("Runtime policy self-tests passed.");
