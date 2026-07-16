import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  blindDirectionReportPasses,
  blindVerdictsMatchReport,
  directionContinuityReportPasses,
  directionSemanticsReportPasses,
} from "./lib/atlas-quality.mjs";
import { renderBlindDirectionSheet } from "./lib/blind-sheet.mjs";
import { realFileWithin } from "./lib/project-utils.mjs";
import { auditChromaFringeFile } from "./remove-chroma-fringe.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const projectRoot = path.resolve(scriptDir, "..");
const runRoot = path.join(projectRoot, ".local-assets", "qq-penguin", "coherent-v2-run");
const atlasPath = path.join(runRoot, "final", "spritesheet-extended.webp");
const summaryPath = path.join(runRoot, "qa", "run-summary.json");
const artifactPaths = {
  officialValidation: path.join(runRoot, "final", "validation-extended.json"),
  continuity: path.join(runRoot, "qa", "continuity-audit-v2.json"),
  blindDirections: path.join(runRoot, "qa", "direction-blind-validation.json"),
  directionSemantics: path.join(runRoot, "qa", "direction-semantics.json"),
  directionContinuity: path.join(runRoot, "qa", "look-continuity.json"),
  finalReview: path.join(runRoot, "qa", "final-frame-review.json"),
};
const strictChromaFringeOptions = Object.freeze({
  distanceThreshold: 160,
  alphaMinimum: 1,
});

const fixedOutputPaths = [
  summaryPath,
  artifactPaths.continuity,
  artifactPaths.directionContinuity,
  artifactPaths.directionSemantics,
];
let preparedOutputs = null;

function outputKey(file) {
  return path.resolve(file).toLocaleLowerCase();
}

function isOutside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export async function prepareAtomicOutputs(rootPath, outputPaths) {
  const realRoot = await fs.realpath(path.resolve(rootPath));
  const prepared = new Map();
  for (const outputPath of outputPaths) {
    const requestedPath = path.resolve(outputPath);
    const parentPath = path.dirname(requestedPath);
    const parentStats = await fs.lstat(parentPath);
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new Error(`QA output parent must be a real directory: ${parentPath}`);
    }
    const realParent = await fs.realpath(parentPath);
    if (isOutside(realRoot, realParent)) {
      throw new Error(`QA output parent escaped the run directory: ${realParent}`);
    }

    try {
      const targetStats = await fs.lstat(requestedPath);
      if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
        throw new Error(`QA output must be a regular file, not a link or special entry: ${requestedPath}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const key = outputKey(requestedPath);
    if (prepared.has(key)) throw new Error(`Duplicate QA output path: ${requestedPath}`);
    prepared.set(key, {
      requestedPath,
      targetPath: path.join(realParent, path.basename(requestedPath)),
      realParent,
    });
  }
  return prepared;
}

function preparedOutput(file) {
  const output = preparedOutputs?.get(outputKey(file));
  if (!output) throw new Error(`QA output was not preflighted: ${path.resolve(file)}`);
  return output;
}

function temporaryOutputPath(output) {
  return path.join(
    output.realParent,
    `.${path.basename(output.targetPath)}.${randomUUID()}.tmp`,
  );
}

export async function atomicWritePrepared(output, contents) {
  const temporaryPath = temporaryOutputPath(output);
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporaryPath, output.targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function atomicWriteOutput(file, contents) {
  await atomicWritePrepared(preparedOutput(file), contents);
}

function runContinuityAudit() {
  return new Promise((resolve, reject) => {
    const output = preparedOutput(artifactPaths.continuity);
    const temporaryReportPath = temporaryOutputPath(output);
    const child = spawn(
      process.execPath,
      [path.join(scriptDir, "check-animation-continuity.mjs"), atlasPath, "--report", temporaryReportPath],
      { cwd: projectRoot, stdio: "inherit" },
    );
    child.once("error", async (error) => {
      await fs.rm(temporaryReportPath, { force: true }).catch(() => {});
      reject(error);
    });
    child.once("exit", async (code) => {
      try {
        const reportStats = await fs.lstat(temporaryReportPath);
        if (reportStats.isSymbolicLink() || !reportStats.isFile()) {
          throw new Error("Continuity audit did not produce a regular report file.");
        }
        await fs.rename(temporaryReportPath, output.targetPath);
        resolve(code ?? 1);
      } catch (error) {
        reject(error);
      } finally {
        await fs.rm(temporaryReportPath, { force: true }).catch(() => {});
      }
    });
  });
}

async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex").toUpperCase();
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeDirectionContinuityReport(atlasSha256) {
  const continuity = await readJson(artifactPaths.continuity);
  const reportErrors = [];
  const reportWarnings = Array.isArray(continuity.warnings)
    ? [...continuity.warnings]
    : ["continuity report has no warnings array"];
  if (continuity.ok !== true) reportErrors.push("source continuity audit did not pass");
  if (continuity.atlas?.sha256?.toUpperCase() !== atlasSha256) {
    reportErrors.push("source continuity audit is not bound to the final atlas");
  }
  const report = {
    schema: "codex-pet-direction-continuity/v2",
    generatedAt: new Date().toISOString(),
    atlas: { file: path.resolve(atlasPath), sha256: atlasSha256 },
    ok: reportErrors.length === 0 && reportWarnings.length === 0,
    errors: reportErrors,
    warnings: reportWarnings,
    reviewRequired: reportErrors.length > 0 || reportWarnings.length > 0,
    labels: continuity.directions?.labels,
    medianChangedPixels: continuity.directions?.medianChangedPixels,
    pairs: continuity.directions?.pairs,
  };
  if (report.ok && !directionContinuityReportPasses(report, atlasSha256)) {
    report.errors.push("direction continuity structure is incomplete or invalid");
    report.ok = false;
    report.reviewRequired = true;
  }
  await atomicWriteOutput(artifactPaths.directionContinuity, `${JSON.stringify(report, null, 2)}\n`);
  return report.ok;
}

async function blindEvidencePasses(report, atlasSha256) {
  if (
    !blindDirectionReportPasses(report, { atlasSha256 }) ||
    path.resolve(report.atlas.file).toLocaleLowerCase() !== path.resolve(atlasPath).toLocaleLowerCase()
  ) {
    return false;
  }
  const deterministicSheetSha256 = createHash("sha256")
    .update(await renderBlindDirectionSheet(atlasPath))
    .digest("hex")
    .toUpperCase();
  if (deterministicSheetSha256 !== report.blindSheet.sha256.toUpperCase()) return false;
  const realEvidencePaths = [];
  const verdicts = [];
  for (const evidence of [report.blindSheet, ...report.reviewers]) {
    try {
      const evidencePath = await realFileWithin(runRoot, evidence.file, "Blind-review evidence");
      realEvidencePaths.push(evidencePath.toLocaleLowerCase());
      if ((await sha256(evidencePath)).toUpperCase() !== evidence.sha256.toUpperCase()) return false;
      if (evidence !== report.blindSheet) verdicts.push(await readJson(evidencePath));
    } catch {
      return false;
    }
  }
  return (
    new Set(realEvidencePaths).size === realEvidencePaths.length &&
    blindVerdictsMatchReport(report, verdicts)
  );
}

async function writeDirectionSemanticsReport(atlasSha256) {
  const reportErrors = [];
  let blindReport;
  try {
    blindReport = await readJson(artifactPaths.blindDirections);
    if (!(await blindEvidencePasses(blindReport, atlasSha256))) {
      reportErrors.push("strict blind-direction evidence did not pass");
    }
  } catch (error) {
    reportErrors.push(`blind-direction evidence is unreadable: ${error.message}`);
  }
  const report = {
    schema: "codex-pet-direction-semantics/v2",
    generatedAt: new Date().toISOString(),
    atlas: { file: path.resolve(atlasPath), sha256: atlasSha256 },
    ok: reportErrors.length === 0,
    errors: reportErrors,
    warnings: [],
    directions: Array.from({ length: 16 }, (_, index) => {
      const value = index * 22.5;
      const direction = Number.isInteger(value)
        ? String(value).padStart(3, "0")
        : String(value).padStart(5, "0");
      return { direction, verdict: reportErrors.length === 0 ? "pass" : "fail" };
    }),
  };
  if (report.ok && !directionSemanticsReportPasses(report, atlasSha256)) {
    report.errors.push("direction semantics structure is incomplete or invalid");
    report.ok = false;
  }
  await atomicWriteOutput(artifactPaths.directionSemantics, `${JSON.stringify(report, null, 2)}\n`);
  return report.ok;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
await fs.mkdir(path.dirname(summaryPath), { recursive: true });
preparedOutputs = await prepareAtomicOutputs(runRoot, fixedOutputPaths);
await atomicWriteOutput(
  summaryPath,
  `${JSON.stringify({
    schema: "codex-pet-authoritative-run/v2",
    generatedAt: new Date().toISOString(),
    ok: false,
    qualityGates: {},
    artifacts: {},
    errors: ["Authoritative QA generation did not complete."],
  }, null, 2)}\n`,
);

const continuityAuditExitCode = await runContinuityAudit();
await realFileWithin(runRoot, atlasPath, "Final atlas");
const atlasStats = await fs.stat(atlasPath);
const atlasSha256 = await sha256(atlasPath);
const errors = [];
let chromaFringeAudit = null;
try {
  chromaFringeAudit = await auditChromaFringeFile(atlasPath, strictChromaFringeOptions);
  if (chromaFringeAudit.total !== 0) {
    errors.push(
      `strict cyan edge-fringe audit found ${chromaFringeAudit.total} contaminated pixels`,
    );
  }
} catch (error) {
  errors.push(`strict cyan edge-fringe audit failed: ${error.message}`);
}
if (continuityAuditExitCode !== 0) {
  errors.push(`continuity audit exited with code ${continuityAuditExitCode}`);
}
try {
  if (!(await writeDirectionContinuityReport(atlasSha256))) {
    errors.push("direction continuity report generation did not pass");
  }
} catch (error) {
  errors.push(`direction continuity report generation failed: ${error.message}`);
}
try {
  if (!(await writeDirectionSemanticsReport(atlasSha256))) {
    errors.push("direction semantics report generation did not pass");
  }
} catch (error) {
  errors.push(`direction semantics report generation failed: ${error.message}`);
}
const qualityGates = {};
const artifacts = {};
const reports = {};

for (const [name, file] of Object.entries(artifactPaths)) {
  try {
    await realFileWithin(runRoot, file, `${name} QA artifact`);
    const stats = await fs.stat(file);
    reports[name] = await readJson(file);
    artifacts[name] = { file: path.resolve(file), sha256: await sha256(file), mtimeMs: stats.mtimeMs };
    if (stats.mtimeMs < atlasStats.mtimeMs) errors.push(`${name} report predates the final atlas`);
  } catch (error) {
    errors.push(`${name} report is missing or unreadable: ${error.message}`);
  }
}

const official = reports.officialValidation;
qualityGates.officialValidation = Boolean(
  official?.ok === true &&
    path.resolve(official.file ?? "").toLocaleLowerCase() === path.resolve(atlasPath).toLocaleLowerCase() &&
    official.sprite_version_number === 2 &&
    official.width === 1536 &&
    official.height === 2288 &&
    Array.isArray(official.errors) &&
    official.errors.length === 0 &&
    Array.isArray(official.warnings) &&
    official.warnings.length === 0,
);
qualityGates.chromaClean = chromaFringeAudit?.total === 0;

const continuity = reports.continuity;
qualityGates.continuity = Boolean(
    continuity?.schema === "codex-pet-continuity-audit/v2" &&
    continuity.ok === true &&
    continuity.atlas?.sha256?.toUpperCase() === atlasSha256 &&
    Array.isArray(continuity.errors) &&
    continuity.errors.length === 0 &&
    Array.isArray(continuity.warnings) &&
    continuity.warnings.length === 0 &&
    Array.isArray(continuity.components?.rejected) &&
    continuity.components.rejected.length === 0 &&
    continuity.sharedLandmarks?.states?.every((state) => state.failedChecks?.length === 0),
);

const blind = reports.blindDirections;
qualityGates.blindDirections = await blindEvidencePasses(blind, atlasSha256);

const semantics = reports.directionSemantics;
qualityGates.directionSemantics = directionSemanticsReportPasses(semantics, atlasSha256);

const directionContinuity = reports.directionContinuity;
qualityGates.directionContinuity = directionContinuityReportPasses(
  directionContinuity,
  atlasSha256,
);

const review = reports.finalReview;
qualityGates.finalReview = Boolean(
  review?.ok === true &&
    review.atlas?.sha256?.toUpperCase() === atlasSha256 &&
    Array.isArray(review.errors) &&
    review.errors.length === 0 &&
    Array.isArray(review.warnings) &&
    review.warnings.length === 0 &&
    review.checks &&
    Object.keys(review.checks).length > 0 &&
    Object.values(review.checks).every((passed) => passed === true),
);

for (const [gate, passed] of Object.entries(qualityGates)) {
  if (!passed) errors.push(`${gate} quality gate did not pass`);
}

const summary = {
  schema: "codex-pet-authoritative-run/v2",
  generatedAt: new Date().toISOString(),
  ok: errors.length === 0,
  atlas: {
    file: path.resolve(atlasPath),
    sha256: atlasSha256,
    mtimeMs: atlasStats.mtimeMs,
    width: 1536,
    height: 2288,
    spriteVersionNumber: 2,
  },
  qualityGates,
  chromaFringeAudit: chromaFringeAudit
    ? {
        total: chromaFringeAudit.total,
        options: {
          chromaKey: chromaFringeAudit.options.chromaKey,
          distanceThreshold: chromaFringeAudit.options.distanceThreshold,
          edgeRadius: chromaFringeAudit.options.edgeRadius,
          alphaMinimum: chromaFringeAudit.options.alphaMinimum,
        },
        affectedCells: chromaFringeAudit.cells.filter((cell) => cell.count > 0),
      }
    : null,
  artifacts,
  errors,
};

await atomicWriteOutput(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`Wrote authoritative QA run: ${summaryPath}`);
if (!summary.ok) {
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
}
}
