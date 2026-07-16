import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backupDestination,
  createReceipt,
  finalizeInstallStaging,
  inspectInstallation,
  prepareBackupDestination,
  RECEIPT_FILE,
  rethrowInstallFailure,
  resolveRestorableBackup,
} from "./lib/pet-install-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uninstallScript = path.join(scriptDir, "uninstall-codex-pet.mjs");
const temporaryCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pet-install-safety-"));
const petsRoot = path.join(temporaryCodexHome, "pets");
const petId = "qq-penguin";
const destination = path.join(petsRoot, petId);
const manifest = { id: petId };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function writeReceipt(receipt) {
  await fs.writeFile(
    path.join(destination, RECEIPT_FILE),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
}

try {
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "pet.json"), '{"id":"qq-penguin"}\n', "utf8");
  await fs.writeFile(path.join(destination, "spritesheet.webp"), "fixture-atlas", "utf8");

  const originalReceipt = await createReceipt({
    sourceRoot: destination,
    destination,
    petManifest: manifest,
    packageVersion: "0.0.0-test",
    backupPath: null,
  });
  const caseCompatibleReceipt = {
    ...originalReceipt,
    petId: process.platform === "win32" ? petId.toUpperCase() : petId,
    destination: process.platform === "win32" ? destination.toUpperCase() : destination,
  };
  await writeReceipt(caseCompatibleReceipt);
  let state = await inspectInstallation(destination);
  assert(state.owned && !state.modified, "A matching receipt must own its installation.");

  await writeReceipt({ ...originalReceipt, petId: "different-pet" });
  state = await inspectInstallation(destination);
  assert(!state.owned && state.modified, "A receipt for another pet id must not own this installation.");

  await writeReceipt({ ...originalReceipt, destination: path.join(temporaryCodexHome, "elsewhere") });
  state = await inspectInstallation(destination);
  assert(!state.owned && state.modified, "A receipt for another destination must not own this installation.");

  await writeReceipt({ ...originalReceipt, files: {} });
  state = await inspectInstallation(destination);
  assert(!state.owned && state.modified, "A malformed receipt file list must not own this installation.");

  const requestedBackup = backupDestination(petsRoot, petId);
  const safeBackup = await prepareBackupDestination(petsRoot, petId, requestedBackup);
  await fs.mkdir(safeBackup);
  assert(
    path.resolve(await resolveRestorableBackup(petsRoot, petId, safeBackup)) ===
      path.resolve(await fs.realpath(safeBackup)),
    "A real backup under the current pet id must be restorable.",
  );

  await writeReceipt({ ...originalReceipt, owner: "foreign.installer", backupPath: safeBackup });
  const dryRun = spawnSync(
    process.execPath,
    [uninstallScript, "--dry-run", "--force", "--pet-id", petId, "--codex-home", temporaryCodexHome],
    { encoding: "utf8", windowsHide: true },
  );
  assert(dryRun.status === 0, `Forced dry-run for an unowned install failed: ${dryRun.stderr}`);
  assert(
    !dryRun.stdout.includes("Would restore"),
    "An unowned receipt backupPath must be ignored even with --force.",
  );
  await writeReceipt(originalReceipt);

  const petBackupRoot = path.dirname(safeBackup);
  const outsideRoot = path.join(temporaryCodexHome, "outside-backup-target");
  const outsideCandidate = path.join(outsideRoot, "external-install");
  await fs.mkdir(outsideCandidate, { recursive: true });
  const linkedRoot = path.join(petBackupRoot, "linked-root");
  let linkCreated = false;
  try {
    await fs.symlink(outsideRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    linkCreated = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    console.warn(`Backup-link regression safely skipped: ${error.code}`);
  }
  if (linkCreated) {
    let rejected = false;
    try {
      await resolveRestorableBackup(petsRoot, petId, path.join(linkedRoot, "external-install"));
    } catch (error) {
      rejected = /symbolic link|junction/i.test(error.message);
    }
    assert(rejected, "A backup path containing a symlink or junction must be rejected.");
    assert(await fs.stat(outsideCandidate), "Rejecting a linked backup must leave the external target untouched.");
  }

  await fs.writeFile(path.join(safeBackup, "restored-marker.txt"), "restored\n", "utf8");
  await writeReceipt({ ...originalReceipt, backupPath: safeBackup });
  const uninstall = spawnSync(
    process.execPath,
    [uninstallScript, "--pet-id", petId, "--codex-home", temporaryCodexHome],
    { encoding: "utf8", windowsHide: true },
  );
  assert(uninstall.status === 0, `A valid owned backup should restore cleanly: ${uninstall.stderr}`);
  assert(
    await fs.stat(path.join(destination, "restored-marker.txt")),
    "Successful uninstall must commit the restored backup at the destination.",
  );
  let oldBackupStillExists = true;
  try {
    await fs.lstat(safeBackup);
  } catch (error) {
    if (error?.code === "ENOENT") oldBackupStillExists = false;
    else throw error;
  }
  assert(!oldBackupStillExists, "A restored backup must be moved out of the backup tree.");

  const installError = new Error("staging swap failed");
  const rollbackError = new Error("backup restore failed");
  let reportedRollbackFailure = null;
  try {
    await rethrowInstallFailure({
      destination,
      backupPath: safeBackup,
      destinationMoved: true,
      installError,
      pathExistsFn: async (candidate) => candidate === safeBackup,
      renameFn: async () => {
        throw rollbackError;
      },
    });
  } catch (error) {
    reportedRollbackFailure = error;
  }
  assert(reportedRollbackFailure instanceof AggregateError, "A failed install rollback must report both errors.");
  assert(
    reportedRollbackFailure.errors.includes(installError) &&
      reportedRollbackFailure.errors.includes(rollbackError),
    "The rollback failure must preserve both the install and restore errors.",
  );
  assert(
    reportedRollbackFailure.message.includes(safeBackup),
    "The rollback failure must tell the user where the previous installation remains.",
  );

  const stagingPath = path.join(petsRoot, ".qq-penguin-install-test");
  const cleanupError = new Error("staging cleanup failed");
  let reportedCleanupFailure = null;
  try {
    await finalizeInstallStaging({
      stagingPath,
      primaryError: reportedRollbackFailure,
      pathExistsFn: async () => true,
      removeFn: async () => {
        throw cleanupError;
      },
    });
  } catch (error) {
    reportedCleanupFailure = error;
  }
  assert(reportedCleanupFailure instanceof AggregateError, "Staging cleanup must not mask install failures.");
  assert(
    reportedCleanupFailure.errors.includes(installError) &&
      reportedCleanupFailure.errors.includes(rollbackError) &&
      reportedCleanupFailure.errors.includes(cleanupError),
    "The final install error must preserve install, rollback, and staging cleanup failures.",
  );
  assert(
    reportedCleanupFailure.message.includes(safeBackup) &&
      reportedCleanupFailure.message.includes(stagingPath),
    "The final install error must retain both the backup and staging recovery locations.",
  );

  console.log("Install receipt and backup-path safety self-tests passed.");
} finally {
  await fs.rm(temporaryCodexHome, { recursive: true, force: true });
}
