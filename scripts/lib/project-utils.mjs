import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDir, "..", "..");

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest("hex");
}

export function assertChildPath(parentPath, candidatePath, label = "Path") {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of ${parent}: ${candidate}`);
  }
  return candidate;
}

export async function realFileWithin(parentPath, candidatePath, label = "File") {
  const parent = await fs.realpath(path.resolve(parentPath));
  const candidate = path.resolve(candidatePath);
  const linkStats = await fs.lstat(candidate);
  if (linkStats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${candidate}`);
  const stats = await fs.stat(candidate);
  if (!stats.isFile()) throw new Error(`${label} must be a regular file: ${candidate}`);
  const realCandidate = await fs.realpath(candidate);
  const relative = path.relative(parent, realCandidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped ${parent}: ${realCandidate}`);
  }
  return realCandidate;
}

export function temporarySibling(targetPath, suffix) {
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${suffix}.${randomUUID()}`);
}

function comparablePath(filePath) {
  let resolved = path.resolve(filePath);
  if (process.platform === "win32" && resolved.startsWith("\\\\?\\")) resolved = resolved.slice(4);
  resolved = resolved.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function pathEscapes(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function lstatIfPresent(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertExistingPathChain(anchorPath, candidatePath, leafKind, label) {
  const anchor = path.resolve(anchorPath);
  const candidate = path.resolve(candidatePath);
  if (pathEscapes(anchor, candidate)) {
    throw new Error(`${label} escaped its expected parent root ${anchor}: ${candidate}`);
  }

  const relative = path.relative(anchor, candidate);
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = anchor;
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = path.join(current, components[index]);
    const stats = await lstatIfPresent(current);
    if (!stats) return false;
    const isLeaf = index === components.length - 1;
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} path must not contain a symlink, junction, or reparse point: ${current}`);
    }
    if (!isLeaf || leafKind === "directory") {
      if (!stats.isDirectory()) {
        throw new Error(`${label} path component must be a real directory: ${current}`);
      }
    } else if (leafKind === "file" && !stats.isFile()) {
      throw new Error(`${label} target must be a regular file when it exists: ${current}`);
    }

    const realCurrent = await fs.realpath(current);
    if (!samePath(realCurrent, current)) {
      throw new Error(`${label} path resolved through a junction or reparse point: ${current} -> ${realCurrent}`);
    }
  }
  return true;
}

function safeOutputKey(filePath) {
  return comparablePath(filePath);
}

/**
 * Read-only validation for a fixed output directory and every file it may write
 * or remove. Call this for all output trees before materialising any of them.
 */
export async function preflightSafeOutputTree({
  anchorPath,
  rootPath,
  outputPaths,
  label = "Generated output",
}) {
  const anchor = path.resolve(anchorPath);
  const root = path.resolve(rootPath);
  if (samePath(anchor, root) || pathEscapes(anchor, root)) {
    throw new Error(`${label} root must be a child of ${anchor}: ${root}`);
  }
  if (!(await assertExistingPathChain(anchor, anchor, "directory", `${label} anchor`))) {
    throw new Error(`${label} anchor does not exist: ${anchor}`);
  }
  await assertExistingPathChain(anchor, root, "directory", `${label} root`);

  const outputs = new Map();
  for (const outputPath of outputPaths) {
    const requestedPath = path.resolve(outputPath);
    if (!samePath(path.dirname(requestedPath), root)) {
      throw new Error(`${label} target must be a direct child of ${root}: ${requestedPath}`);
    }
    await assertExistingPathChain(anchor, requestedPath, "file", `${label} target`);
    const key = safeOutputKey(requestedPath);
    if (outputs.has(key)) throw new Error(`${label} contains a duplicate target: ${requestedPath}`);
    outputs.set(key, { requestedPath });
  }
  if (outputs.size === 0) throw new Error(`${label} must declare at least one fixed output target.`);
  return { anchorPath: anchor, rootPath: root, label, outputs, materialized: false };
}

/** Create a previously preflighted output root one component at a time. */
export async function materializeSafeOutputTree(plan) {
  if (!plan || plan.materialized || !(plan.outputs instanceof Map)) {
    throw new Error("Safe output tree was not preflighted or was already materialized.");
  }
  if (!(await assertExistingPathChain(plan.anchorPath, plan.anchorPath, "directory", `${plan.label} anchor`))) {
    throw new Error(`${plan.label} anchor does not exist: ${plan.anchorPath}`);
  }
  const relativeRoot = path.relative(plan.anchorPath, plan.rootPath);
  let current = plan.anchorPath;
  for (const component of relativeRoot.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stats = await lstatIfPresent(current);
    if (!stats) {
      try {
        await fs.mkdir(current);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    await assertExistingPathChain(plan.anchorPath, current, "directory", `${plan.label} root`);
  }

  const refreshed = await preflightSafeOutputTree({
    anchorPath: plan.anchorPath,
    rootPath: plan.rootPath,
    outputPaths: [...plan.outputs.values()].map((output) => output.requestedPath),
    label: plan.label,
  });
  const realRoot = await fs.realpath(refreshed.rootPath);
  refreshed.materialized = true;
  for (const output of refreshed.outputs.values()) {
    output.targetPath = path.join(realRoot, path.basename(output.requestedPath));
    output.anchorPath = refreshed.anchorPath;
    output.rootPath = refreshed.rootPath;
    output.label = refreshed.label;
  }
  return refreshed;
}

export function safeOutputFrom(plan, outputPath) {
  if (!plan?.materialized) throw new Error("Safe output tree has not been materialized.");
  const output = plan.outputs.get(safeOutputKey(outputPath));
  if (!output) throw new Error(`Output was not declared during preflight: ${path.resolve(outputPath)}`);
  return output;
}

async function validateSafeOutput(output) {
  if (!output?.targetPath || !samePath(path.dirname(output.targetPath), output.rootPath)) {
    throw new Error("Generated output descriptor is invalid.");
  }
  await assertExistingPathChain(output.anchorPath, output.rootPath, "directory", `${output.label} root`);
  await assertExistingPathChain(output.anchorPath, output.requestedPath, "file", `${output.label} target`);
  const realRoot = await fs.realpath(output.rootPath);
  if (!samePath(realRoot, output.rootPath) || !samePath(output.targetPath, output.requestedPath)) {
    throw new Error(`${output.label} target no longer resolves to its preflighted parent: ${output.requestedPath}`);
  }
}

/**
 * Stage every file beside its destination, then atomically replace each fixed
 * target. Existing targets remain intact if staging or validation fails.
 */
export async function atomicReplaceSafeOutputs(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const seen = new Set();
  for (const { output } of entries) {
    await validateSafeOutput(output);
    const key = safeOutputKey(output.targetPath);
    if (seen.has(key)) throw new Error(`Duplicate atomic output target: ${output.targetPath}`);
    seen.add(key);
  }

  const staged = [];
  try {
    for (const { output, contents } of entries) {
      await validateSafeOutput(output);
      const temporaryPath = temporarySibling(output.targetPath, "write");
      const handle = await fs.open(temporaryPath, "wx");
      const item = { output, temporaryPath };
      staged.push(item);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }
      const temporaryStats = await fs.lstat(temporaryPath);
      if (temporaryStats.isSymbolicLink() || !temporaryStats.isFile()) {
        throw new Error(`Atomic output temporary path is not a regular file: ${temporaryPath}`);
      }
    }

    for (const { output } of entries) await validateSafeOutput(output);
    for (const item of staged) {
      await fs.rename(item.temporaryPath, item.output.targetPath);
      item.committed = true;
    }
  } finally {
    for (const item of staged) {
      if (item.committed) continue;
      await fs.unlink(item.temporaryPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
}

/** Remove optional stale outputs only after validating every target in the set. */
export async function removeSafeOutputs(outputs) {
  const existing = [];
  for (const output of outputs) {
    await validateSafeOutput(output);
    const stats = await lstatIfPresent(output.targetPath);
    if (stats) existing.push(output);
  }
  for (const output of existing) await validateSafeOutput(output);
  for (const output of existing) await fs.unlink(output.targetPath);
}

export function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function readPackage() {
  return readJson(path.join(projectRoot, "package.json"));
}

export async function listFilesRecursively(rootPath) {
  const output = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) output.push(absolutePath);
    }
  }
  await visit(rootPath);
  return output;
}
