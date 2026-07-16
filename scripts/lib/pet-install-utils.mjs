import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertChildPath,
  pathExists,
  readJson,
  sha256File,
  timestampForPath,
} from "./project-utils.mjs";

export const RECEIPT_FILE = ".codex-pet-install-receipt.json";
export const RECEIPT_OWNER = "io.github.linzeyu912.codex-pet";
export const RECEIPT_SCHEMA = 1;
export const INSTALLED_FILES = ["pet.json", "spritesheet.webp"];

function pathComparisonKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function identifierComparisonKey(value) {
  const normalized = String(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isOutside(parentPath, candidatePath, { allowSame = false } = {}) {
  const relative = path.relative(parentPath, candidatePath);
  if (!relative) return !allowSame;
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function inspectRealDirectoryChain(rootPath, candidatePath, { allowMissing = false, label = "Directory" } = {}) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (isOutside(root, candidate, { allowSame: true })) {
    throw new Error(`${label} escaped ${root}: ${candidate}`);
  }

  const relative = path.relative(root, candidate);
  const components = [root];
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    components.push(current);
  }

  for (const component of components) {
    let stats;
    try {
      stats = await fs.lstat(component);
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissing) return null;
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} path must not contain a symbolic link or junction: ${component}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${label} path component must be a directory: ${component}`);
    }
  }

  const realRoot = await fs.realpath(root);
  const realCandidate = await fs.realpath(candidate);
  if (isOutside(realRoot, realCandidate, { allowSame: true })) {
    throw new Error(`${label} escaped its real root ${realRoot}: ${realCandidate}`);
  }
  return { realRoot, realCandidate };
}

function backupLayout(petsRoot, petId, backupPath = null) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(petId)) {
    throw new Error(`Unsafe pet id for backup path: ${petId}`);
  }
  const resolvedPetsRoot = path.resolve(petsRoot);
  const backupRoot = assertChildPath(
    resolvedPetsRoot,
    path.join(resolvedPetsRoot, ".codex-pet-backups"),
    "Backup root",
  );
  const petBackupRoot = assertChildPath(
    backupRoot,
    path.join(backupRoot, petId),
    "Pet backup root",
  );
  const candidate = backupPath === null
    ? null
    : assertChildPath(petBackupRoot, path.resolve(backupPath), "Receipt backup path");
  return { resolvedPetsRoot, backupRoot, petBackupRoot, candidate };
}

export function installPathsMatch(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    path.isAbsolute(left) &&
    path.isAbsolute(right) &&
    pathComparisonKey(left) === pathComparisonKey(right)
  );
}

export function parseInstallArguments(argv, { uninstall = false } = {}) {
  const options = {
    dryRun: false,
    force: false,
    codexHome: null,
    petId: null,
    restoreBackup: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--codex-home") {
      const value = argv[++index];
      if (!value) throw new Error("--codex-home requires a directory path.");
      options.codexHome = path.resolve(value);
    } else if (uninstall && argument === "--pet-id") {
      const value = argv[++index];
      if (!value || !/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
        throw new Error("--pet-id requires a safe pet identifier.");
      }
      options.petId = value;
    } else if (uninstall && argument === "--no-restore-backup") options.restoreBackup = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

export async function inspectInstallation(destination) {
  if (!(await pathExists(destination))) {
    return { exists: false, owned: false, modified: false, conflicts: [], receipt: null };
  }

  const receiptPath = path.join(destination, RECEIPT_FILE);
  if (!(await pathExists(receiptPath))) {
    return {
      exists: true,
      owned: false,
      modified: true,
      conflicts: [`Existing directory has no ${RECEIPT_FILE} ownership receipt.`],
      receipt: null,
    };
  }

  let receipt;
  try {
    receipt = await readJson(receiptPath);
  } catch (error) {
    return {
      exists: true,
      owned: false,
      modified: true,
      conflicts: [`Install receipt cannot be read: ${error.message}`],
      receipt: null,
    };
  }

  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return {
      exists: true,
      owned: false,
      modified: true,
      conflicts: ["Install receipt must be a JSON object."],
      receipt,
    };
  }

  const expectedPetId = path.basename(path.resolve(destination));
  const receiptPetIdMatches =
    typeof receipt.petId === "string" &&
    identifierComparisonKey(receipt.petId) === identifierComparisonKey(expectedPetId);
  const receiptDestinationMatches = installPathsMatch(receipt.destination, destination);
  const receiptFilesValid =
    Array.isArray(receipt.files) &&
    receipt.files.length === INSTALLED_FILES.length &&
    new Set(receipt.files.map((file) => file?.path)).size === INSTALLED_FILES.length &&
    receipt.files.every(
      (file) =>
        file &&
        typeof file === "object" &&
        INSTALLED_FILES.includes(file.path) &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 &&
        typeof file.sha256 === "string" &&
        /^[0-9a-f]{64}$/i.test(file.sha256),
    );
  const owned =
    receipt.owner === RECEIPT_OWNER &&
    receipt.schemaVersion === RECEIPT_SCHEMA &&
    receiptPetIdMatches &&
    receiptDestinationMatches &&
    receiptFilesValid;
  if (!owned) {
    const conflicts = [];
    if (receipt.owner !== RECEIPT_OWNER || receipt.schemaVersion !== RECEIPT_SCHEMA) {
      conflicts.push("Existing receipt belongs to a different installer or schema.");
    }
    if (!receiptPetIdMatches) {
      conflicts.push(`Receipt petId does not match destination directory: ${expectedPetId}`);
    }
    if (!receiptDestinationMatches) {
      conflicts.push(`Receipt destination does not match the actual installation: ${path.resolve(destination)}`);
    }
    if (!receiptFilesValid) conflicts.push("Receipt files entry must be an array.");
    return {
      exists: true,
      owned: false,
      modified: true,
      conflicts,
      receipt,
    };
  }

  const conflicts = [];
  const recorded = new Map((receipt.files ?? []).map((file) => [file.path, file]));
  for (const relativePath of INSTALLED_FILES) {
    const expected = recorded.get(relativePath);
    const absolutePath = path.join(destination, relativePath);
    if (!expected || !(await pathExists(absolutePath))) {
      conflicts.push(`${relativePath} is missing from the installation or receipt.`);
      continue;
    }
    const actualHash = await sha256File(absolutePath);
    if (actualHash.toUpperCase() !== String(expected.sha256).toUpperCase()) {
      conflicts.push(`${relativePath} was modified after installation.`);
    }
  }

  const allowedEntries = new Set([...INSTALLED_FILES, RECEIPT_FILE]);
  for (const entry of await fs.readdir(destination, { withFileTypes: true })) {
    if (!allowedEntries.has(entry.name)) conflicts.push(`Unexpected entry in installation: ${entry.name}`);
  }

  return {
    exists: true,
    owned,
    modified: conflicts.length > 0,
    conflicts,
    receipt,
  };
}

export async function createReceipt({ sourceRoot, destination, petManifest, packageVersion, backupPath }) {
  const files = [];
  for (const relativePath of INSTALLED_FILES) {
    const filePath = path.join(sourceRoot, relativePath);
    const stats = await fs.stat(filePath);
    files.push({
      path: relativePath,
      bytes: stats.size,
      sha256: await sha256File(filePath),
    });
  }
  return {
    schemaVersion: RECEIPT_SCHEMA,
    owner: RECEIPT_OWNER,
    packageVersion,
    petId: petManifest.id,
    installedAt: new Date().toISOString(),
    destination: path.resolve(destination),
    backupPath: backupPath ? path.resolve(backupPath) : null,
    files,
  };
}

export function backupDestination(petsRoot, petId) {
  const { petBackupRoot } = backupLayout(petsRoot, petId);
  return assertChildPath(
    petBackupRoot,
    path.join(petBackupRoot, timestampForPath()),
    "Backup path",
  );
}

export async function prepareBackupDestination(petsRoot, petId, backupPath) {
  const { resolvedPetsRoot, petBackupRoot, candidate } = backupLayout(petsRoot, petId, backupPath);
  const parent = path.dirname(candidate);

  await inspectRealDirectoryChain(resolvedPetsRoot, parent, {
    allowMissing: true,
    label: "Backup destination",
  });
  await fs.mkdir(parent, { recursive: true });
  const checkedParent = await inspectRealDirectoryChain(resolvedPetsRoot, parent, {
    label: "Backup destination",
  });
  const realPetBackupRoot = await fs.realpath(petBackupRoot);
  if (isOutside(realPetBackupRoot, checkedParent.realCandidate, { allowSame: true })) {
    throw new Error(`Backup destination escaped the current pet backup root: ${checkedParent.realCandidate}`);
  }
  const realCandidate = path.join(checkedParent.realCandidate, path.basename(candidate));
  try {
    const candidateStats = await fs.lstat(realCandidate);
    const kind = candidateStats.isSymbolicLink() ? "symbolic link or junction" : "existing entry";
    throw new Error(`Backup destination must be new, but found ${kind}: ${realCandidate}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return realCandidate;
}

export async function resolveRestorableBackup(petsRoot, petId, backupPath) {
  if (backupPath === null || backupPath === undefined || backupPath === "") return null;
  if (typeof backupPath !== "string" || !path.isAbsolute(backupPath)) {
    throw new Error("Receipt backup path must be an absolute directory path.");
  }
  const { resolvedPetsRoot, petBackupRoot, candidate } = backupLayout(petsRoot, petId, backupPath);
  const checked = await inspectRealDirectoryChain(resolvedPetsRoot, candidate, {
    label: "Receipt backup",
  });
  if (!checked) return null;

  const realPetBackupRoot = await fs.realpath(petBackupRoot);
  if (isOutside(realPetBackupRoot, checked.realCandidate)) {
    throw new Error(`Receipt backup escaped the current pet backup root: ${checked.realCandidate}`);
  }
  return checked.realCandidate;
}

export async function rethrowInstallFailure({
  destination,
  backupPath,
  destinationMoved,
  installError,
  pathExistsFn = pathExists,
  renameFn = fs.rename,
}) {
  let canRestore = false;
  if (destinationMoved && typeof backupPath === "string") {
    try {
      canRestore = !(await pathExistsFn(destination)) && (await pathExistsFn(backupPath));
    } catch (assessmentError) {
      throw new AggregateError(
        [installError, assessmentError],
        `Install failed and recovery could not be assessed. Check the previous installation at: ${backupPath}`,
      );
    }
  }
  if (canRestore) {
    try {
      await renameFn(backupPath, destination);
    } catch (rollbackError) {
      throw new AggregateError(
        [installError, rollbackError],
        `Install failed and the previous installation could not be restored. It remains at: ${backupPath}`,
      );
    }
  }
  throw installError;
}

export async function finalizeInstallStaging({
  stagingPath,
  primaryError = null,
  pathExistsFn = pathExists,
  removeFn = (target) => fs.rm(target, { recursive: true, force: true }),
}) {
  try {
    if (await pathExistsFn(stagingPath)) await removeFn(stagingPath);
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError;
    const priorErrors = primaryError instanceof AggregateError ? primaryError.errors : [primaryError];
    throw new AggregateError(
      [...priorErrors, cleanupError],
      `${primaryError.message}\nStaging cleanup also failed at: ${stagingPath}`,
    );
  }
  if (primaryError) throw primaryError;
}

export function formatConflicts(conflicts) {
  return conflicts.map((conflict) => `  - ${conflict}`).join("\n");
}
