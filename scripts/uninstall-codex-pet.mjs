import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatConflicts,
  inspectInstallation,
  parseInstallArguments,
  resolveRestorableBackup,
} from "./lib/pet-install-utils.mjs";
import {
  assertChildPath,
  pathExists,
  temporarySibling,
} from "./lib/project-utils.mjs";

function printHelp() {
  console.log(`Uninstall a Codex pet previously installed by this project.

Usage: node scripts/uninstall-codex-pet.mjs [--dry-run] [--force]
       [--pet-id ID] [--no-restore-backup] [--codex-home PATH]

By default, an installation backed up during the last install is restored.`);
}

const options = parseInstallArguments(process.argv.slice(2), { uninstall: true });
if (options.help) {
  printHelp();
  process.exit(0);
}

const codexHome = options.codexHome ?? path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const petsRoot = path.join(codexHome, "pets");
const knownPetIds = options.petId
  ? [options.petId]
  : ["qq-penguin", "codex-aurora-penguin", "codex-penguin-placeholder"];
const installed = [];
for (const petId of knownPetIds) {
  const destination = assertChildPath(petsRoot, path.join(petsRoot, petId), "Pet destination");
  const state = await inspectInstallation(destination);
  if (state.exists) installed.push({ petId, destination, state });
}

if (installed.length === 0) throw new Error("No matching Codex Pet installation was found.");
if (installed.length > 1 && !options.petId) {
  throw new Error("More than one matching installation exists; choose one with --pet-id.");
}

const { petId, destination, state } = installed[0];
if (!state.owned && !options.force) {
  throw new Error(
    `Refusing to remove an installation without this project's ownership receipt:\n${formatConflicts(state.conflicts)}\n` +
      "Use --force only after checking the destination carefully.",
  );
}
if (state.modified && !options.force) {
  throw new Error(
    `Refusing to discard files changed after installation:\n${formatConflicts(state.conflicts)}\n` +
      "Use --force to remove them.",
  );
}

let backupPath = null;
if (options.restoreBackup && state.owned) {
  backupPath = await resolveRestorableBackup(petsRoot, petId, state.receipt?.backupPath);
} else if (options.restoreBackup && state.receipt?.backupPath) {
  console.warn("Ignoring backupPath from a receipt that does not own this installation.");
}

console.log(`${options.dryRun ? "Dry run; would remove" : "Removing"}: ${destination}`);
if (backupPath) console.log(`${options.dryRun ? "Would restore" : "Restoring"} backup: ${backupPath}`);
if (options.dryRun) process.exit(0);

const trashPath = assertChildPath(petsRoot, temporarySibling(destination, "uninstall"), "Uninstall staging path");
let destinationMoved = false;
let backupRestored = false;
let cleanupWarning = null;
try {
  await fs.rename(destination, trashPath);
  destinationMoved = true;
  if (backupPath) {
    await fs.rename(backupPath, destination);
    backupRestored = true;
  }
  try {
    await fs.rm(trashPath, { recursive: true, force: true });
  } catch (error) {
    if (!backupRestored) throw error;
    cleanupWarning =
      `The previous installation was restored successfully, but cleanup could not remove ${trashPath}: ${error.message}`;
    console.warn(cleanupWarning);
  }
} catch (error) {
  if (!backupRestored && destinationMoved && !(await pathExists(destination)) && (await pathExists(trashPath))) {
    try {
      await fs.rename(trashPath, destination);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Backup restore failed and the original installation could not be rolled back. It remains at: ${trashPath}`,
      );
    }
  }
  throw error;
}

console.log(backupPath ? `Uninstalled Codex Pet and restored: ${destination}` : `Uninstalled Codex Pet: ${destination}`);
if (cleanupWarning) console.log(`Cleanup can be retried manually after releasing file locks: ${trashPath}`);
