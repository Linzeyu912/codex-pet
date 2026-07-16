import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BLIND_DIRECTION_PAIRS,
  BLIND_VERDICT_SCHEMA,
  blindVerdictsMatchReport,
  normalizeBlindVerdict,
} from "./lib/atlas-quality.mjs";
import { renderBlindDirectionSheet } from "./lib/blind-sheet.mjs";

const options = { reviewers: [] };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const value = process.argv[index + 1];
  if (["--atlas", "--sheet", "--reviewer", "--output"].includes(argument) && !value) {
    throw new Error(`${argument} requires a path.`);
  }
  if (argument === "--atlas") {
    options.atlas = path.resolve(value);
    index += 1;
  } else if (argument === "--sheet") {
    options.sheet = path.resolve(value);
    index += 1;
  } else if (argument === "--reviewer") {
    options.reviewers.push(path.resolve(value));
    index += 1;
  } else if (argument === "--output") {
    options.output = path.resolve(value);
    index += 1;
  } else throw new Error(`Unknown option: ${argument}`);
}

if (!options.atlas || !options.sheet || !options.output || options.reviewers.length !== 3) {
  throw new Error(
    "Usage: node scripts/compile-blind-direction-review.mjs --atlas <atlas> --sheet <blind-sheet> " +
      "--reviewer <verdict-a> --reviewer <verdict-b> --reviewer <verdict-c> --output <report>",
  );
}

const inputPaths = [options.atlas, options.sheet, ...options.reviewers].map((file) =>
  path.resolve(file).toLocaleLowerCase(),
);
if (inputPaths.includes(options.output.toLocaleLowerCase())) {
  throw new Error("The output report must not overwrite an input artifact.");
}
try {
  const outputStats = await fs.lstat(options.output);
  if (outputStats.isSymbolicLink()) throw new Error("The output report must not be a symbolic link.");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
await fs.mkdir(path.dirname(options.output), { recursive: true });
await fs.writeFile(
  options.output,
  `${JSON.stringify({
    schema: "codex-pet-direction-blind-review/v2",
    ok: false,
    errors: ["Blind-review compilation did not complete."],
    warnings: [],
    unconfirmed: [],
    reviewRequired: true,
  }, null, 2)}\n`,
  "utf8",
);

async function readWithSha256(file) {
  const realPath = await fs.realpath(file);
  const bytes = await fs.readFile(realPath);
  return {
    bytes,
    realPath,
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
  };
}

const atlas = await readWithSha256(options.atlas);
const blindSheet = await readWithSha256(options.sheet);
const errors = [];
const expectedSheet = await renderBlindDirectionSheet(atlas.realPath);
const expectedSheetSha256 = createHash("sha256").update(expectedSheet).digest("hex").toUpperCase();
if (blindSheet.sha256.toUpperCase() !== expectedSheetSha256) {
  errors.push("The blind sheet is not the deterministic rendering of the selected atlas.");
}
const reviewers = [];
const reviewerPairs = [];
const reviewerDocuments = [];

for (const reviewerFile of options.reviewers) {
  const artifact = await readWithSha256(reviewerFile);
  let verdict;
  try {
    verdict = JSON.parse(artifact.bytes.toString("utf8"));
  } catch (error) {
    errors.push(`${reviewerFile} is not valid JSON: ${error.message}`);
    continue;
  }

  const normalized = normalizeBlindVerdict(verdict, {
    atlasSha256: atlas.sha256,
    sheetSha256: blindSheet.sha256,
  });
  if (!normalized) {
    errors.push(`${reviewerFile} does not match ${BLIND_VERDICT_SCHEMA} or this blind sheet.`);
    continue;
  }

  reviewers.push({ id: normalized.id, file: artifact.realPath, sha256: artifact.sha256 });
  reviewerPairs.push(normalized);
  reviewerDocuments.push(verdict);
}

if (new Set(reviewers.map((reviewer) => reviewer.id.toLocaleLowerCase())).size !== 3) {
  errors.push("Exactly three unique independent reviewer IDs are required.");
}
if (new Set(reviewers.map((reviewer) => reviewer.file.toLocaleLowerCase())).size !== 3) {
  errors.push("Exactly three unique reviewer files are required after realpath resolution.");
}

const warnings = [];
const unconfirmed = [];
const pairs = BLIND_DIRECTION_PAIRS.map((expectedPair) => {
  const sides = {};
  for (const side of ["A", "B"]) {
    const expected = expectedPair[side].expected;
    const votes = reviewerPairs.map((reviewer) => ({
      reviewer: reviewer.id,
      observed: reviewer.pairs.get(expectedPair.pair)?.[side]?.observed ?? "missing",
      confidence: reviewer.pairs.get(expectedPair.pair)?.[side]?.confidence ?? "missing",
    }));
    const pass =
      votes.length === 3 &&
      votes.every(
        (vote) => vote.observed === expected && ["medium", "high"].includes(vote.confidence),
      );
    if (!pass) {
      const summary = votes
        .map((vote) => `${vote.reviewer}=${vote.observed}/${vote.confidence}`)
        .join(", ");
      warnings.push(`${expectedPair.pair} ${side} is not unanimous: ${summary}`);
      unconfirmed.push(`${expectedPair.pair} ${side}`);
    }
    sides[side] = {
      observed: pass ? expected : "ambiguous",
      expected,
      source_direction: expectedPair[side].sourceDirection,
      pass,
      votes,
    };
  }
  return {
    pair: expectedPair.pair,
    axis: expectedPair.axis,
    gate: expectedPair.gate,
    ...sides,
  };
});

const reportBase = {
  schema: "codex-pet-direction-blind-review/v2",
  generatedAt: new Date().toISOString(),
  reviewPolicy: "unanimous-three-reviewers",
  atlas: { file: atlas.realPath, sha256: atlas.sha256 },
  blindSheet: { file: blindSheet.realPath, sha256: blindSheet.sha256 },
  reviewers,
  pairs,
};
if (!blindVerdictsMatchReport(reportBase, reviewerDocuments)) {
  errors.push("Compiled votes do not exactly match the three raw reviewer verdicts.");
}
const ok = errors.length === 0 && warnings.length === 0;
const report = {
  ...reportBase,
  ok,
  errors,
  warnings,
  unconfirmed,
  reviewRequired: !ok,
};

await fs.writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Wrote blind-direction review: ${options.output}`);
if (!ok) {
  [...errors, ...warnings].forEach((message) => console.error(`- ${message}`));
  process.exitCode = 1;
}
