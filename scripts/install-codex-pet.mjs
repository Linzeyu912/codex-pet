import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLocalAssets } from "./build-local-assets.mjs";
import {
  backupDestination,
  createReceipt,
  finalizeInstallStaging,
  formatConflicts,
  inspectInstallation,
  INSTALLED_FILES,
  parseInstallArguments,
  prepareBackupDestination,
  RECEIPT_FILE,
  rethrowInstallFailure,
} from "./lib/pet-install-utils.mjs";
import {
  assertChildPath,
  pathExists,
  projectRoot,
  readJson,
  readPackage,
  temporarySibling,
} from "./lib/project-utils.mjs";

function printHelp() {
  console.log(`Install the Codex pet with an atomic swap and an ownership receipt.

Usage: node scripts/install-codex-pet.mjs [--dry-run] [--force] [--codex-home PATH]

  --dry-run          Report the selected source and conflicts without writing files.
  --force            Back up and replace an unowned or locally modified installation.
  --codex-home PATH  Override CODEX_HOME for testing or a non-default Codex profile.`);
}

async function inferDryRunSource() {
  const usePublicMascot = process.env.CODEX_PET_FORCE_PUBLIC_MASCOT === "1"
    || process.env.CODEX_PET_FORCE_PLACEHOLDER === "1";
  const coherentValidation = path.join(
    projectRoot,
    ".local-assets",
    "qq-penguin",
    "coherent-v2-run",
    "final",
    "validation-extended.json",
  );
  const classicSource = path.join(projectRoot, ".local-assets", "qq-penguin", "pixel-base.png");
  const classicSelected = !usePublicMascot && ((await pathExists(coherentValidation)) || (await pathExists(classicSource)));
  return classicSelected
    ? {
        petId: "qq-penguin",
        outputRoot: path.join(projectRoot, ".local-assets", "qq-penguin", "codex-pet"),
        label: "local classic-penguin source",
      }
    : {
        petId: "codex-aurora-penguin",
        outputRoot: path.join(projectRoot, ".local-assets", "public-mascot", "codex-pet"),
        label: "redistributable original Aurora Penguin mascot",
      };
}

const options = parseInstallArguments(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const codexHome = options.codexHome ?? path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const petsRoot = path.join(codexHome, "pets");

if (options.dryRun) {
  const source = await inferDryRunSource();
  const destination = assertChildPath(petsRoot, path.join(petsRoot, source.petId), "Pet destination");
  const state = await inspectInstallation(destination);
  console.log(`Dry run: no files were written.\nSource: ${source.label}\nDestination: ${destination}`);
  console.log(
    (await pathExists(path.join(source.outputRoot, "pet.json")))
      ? `Prepared source: ${source.outputRoot}`
      : "Prepared source: not present yet; the real install will generate it before changing Codex files.",
  );
  if (!state.exists) console.log("Destination is free; an atomic install can proceed.");
  else if (state.modified && !options.force) {
    throw new Error(`Installation conflict detected:\n${formatConflicts(state.conflicts)}\nRe-run with --force to back it up and replace it.`);
  } else if (state.modified) {
    console.log(`Conflicts will be preserved in a timestamped backup:\n${formatConflicts(state.conflicts)}`);
  } else {
    console.log("An intact Codex Pet installation will be replaced after it is backed up.");
  }
  process.exit(0);
}

const result = await buildLocalAssets({ copyToPublic: true });
const manifestPath = path.join(result.outputRoot, "pet.json");
const petManifest = await readJson(manifestPath);
if (!petManifest.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(petManifest.id)) {
  throw new Error(`Unsafe or missing pet id in ${manifestPath}`);
}
for (const relativePath of INSTALLED_FILES) {
  if (!(await pathExists(path.join(result.outputRoot, relativePath)))) {
    throw new Error(`Prepared pet is missing ${relativePath}: ${result.outputRoot}`);
  }
}

await fs.mkdir(petsRoot, { recursive: true });
const destination = assertChildPath(petsRoot, path.join(petsRoot, petManifest.id), "Pet destination");
const existing = await inspectInstallation(destination);
if (existing.modified && !options.force) {
  throw new Error(
    `Refusing to overwrite an unowned or modified installation:\n${formatConflicts(existing.conflicts)}\n` +
      "Use --force only if you want that directory preserved as a backup and replaced.",
  );
}

let backupPath = existing.exists ? backupDestination(petsRoot, petManifest.id) : null;
const stagingPath = assertChildPath(petsRoot, temporarySibling(destination, "install"), "Install staging path");
const packageJson = await readPackage();
let destinationMoved = false;
let installFailure = null;

try {
  await fs.mkdir(stagingPath, { recursive: false });
  for (const relativePath of INSTALLED_FILES) {
    await fs.copyFile(path.join(result.outputRoot, relativePath), path.join(stagingPath, relativePath));
  }
  if (backupPath) {
    backupPath = await prepareBackupDestination(petsRoot, petManifest.id, backupPath);
  }
  const receipt = await createReceipt({
    sourceRoot: stagingPath,
    destination,
    petManifest,
    packageVersion: packageJson.version,
    backupPath,
  });
  await fs.writeFile(path.join(stagingPath, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  if (existing.exists) {
    await fs.rename(destination, backupPath);
    destinationMoved = true;
  }
  await fs.rename(stagingPath, destination);
} catch (error) {
  installFailure = error;
  try {
    await rethrowInstallFailure({ destination, backupPath, destinationMoved, installError: error });
  } catch (reportedError) {
    installFailure = reportedError;
  }
}
await finalizeInstallStaging({ stagingPath, primaryError: installFailure });

console.log(`Installed local Codex pet atomically at: ${destination}`);
console.log(`Install receipt: ${path.join(destination, RECEIPT_FILE)}`);
if (backupPath) console.log(`Previous installation backup: ${backupPath}`);
