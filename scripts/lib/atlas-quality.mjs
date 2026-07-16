export const BLIND_DIRECTION_PAIRS = Object.freeze([
  ["horizontal-1", "horizontal", "review", "022.5", "screen-right", "337.5", "screen-left"],
  ["horizontal-2", "horizontal", "review", "045", "screen-right", "315", "screen-left"],
  ["horizontal-3", "horizontal", "review", "292.5", "screen-left", "067.5", "screen-right"],
  ["horizontal-4", "horizontal", "hard", "270", "screen-left", "090", "screen-right"],
  ["horizontal-5", "horizontal", "review", "247.5", "screen-left", "112.5", "screen-right"],
  ["horizontal-6", "horizontal", "review", "225", "screen-left", "135", "screen-right"],
  ["horizontal-7", "horizontal", "review", "202.5", "screen-left", "157.5", "screen-right"],
  ["vertical-1", "vertical", "hard", "000", "up", "180", "down"],
  ["vertical-2", "vertical", "review", "022.5", "up", "157.5", "down"],
  ["vertical-3", "vertical", "review", "045", "up", "135", "down"],
  ["vertical-4", "vertical", "review", "067.5", "up", "112.5", "down"],
  ["vertical-5", "vertical", "review", "202.5", "down", "337.5", "up"],
  ["vertical-6", "vertical", "review", "225", "down", "315", "up"],
  ["vertical-7", "vertical", "review", "292.5", "up", "247.5", "down"],
].map(([pair, axis, gate, aSource, aExpected, bSource, bExpected]) => ({
  pair,
  axis,
  gate,
  A: { sourceDirection: aSource, expected: aExpected },
  B: { sourceDirection: bSource, expected: bExpected },
})));

export const DIRECTION_LABELS = Object.freeze([
  "000", "022.5", "045", "067.5", "090", "112.5", "135", "157.5",
  "180", "202.5", "225", "247.5", "270", "292.5", "315", "337.5",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const CONFIDENCE_LEVELS = new Set(["low", "medium", "high"]);
const PASSING_CONFIDENCE_LEVELS = new Set(["medium", "high"]);
export const BLIND_VERDICT_SCHEMA = "codex-pet-blind-verdict/v2";

function sameSha256(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toUpperCase() === right.toUpperCase();
}

export function directionContinuityReportPasses(report, atlasSha256) {
  if (
    report?.schema !== "codex-pet-direction-continuity/v2" ||
    report.ok !== true ||
    report.reviewRequired !== false ||
    !sameSha256(report.atlas?.sha256, atlasSha256) ||
    !Array.isArray(report.errors) ||
    report.errors.length > 0 ||
    !Array.isArray(report.warnings) ||
    report.warnings.length > 0 ||
    !Array.isArray(report.labels) ||
    report.labels.length !== DIRECTION_LABELS.length ||
    !report.labels.every((label, index) => label === DIRECTION_LABELS[index]) ||
    !Number.isFinite(report.medianChangedPixels) ||
    report.medianChangedPixels <= 0 ||
    !Array.isArray(report.pairs) ||
    report.pairs.length !== DIRECTION_LABELS.length
  ) {
    return false;
  }
  return report.pairs.every((pair, index) => {
    const from = DIRECTION_LABELS[index];
    const to = DIRECTION_LABELS[(index + 1) % DIRECTION_LABELS.length];
    return (
      pair?.from === from &&
      pair?.to === to &&
      Number.isFinite(pair.iou) &&
      pair.iou > 0 &&
      pair.iou <= 1 &&
      Number.isFinite(pair.center) &&
      pair.center >= 0 &&
      Number.isFinite(pair.baseline) &&
      pair.baseline >= 0 &&
      Number.isFinite(pair.areaRatio) &&
      pair.areaRatio > 0 &&
      Number.isFinite(pair.colorChange) &&
      pair.colorChange >= 0 &&
      Number.isFinite(pair.changedPixels) &&
      pair.changedPixels > 0 &&
      Number.isFinite(pair.localOutlierRatio) &&
      pair.localOutlierRatio >= 0
    );
  });
}

export function directionSemanticsReportPasses(report, atlasSha256) {
  return Boolean(
    report?.schema === "codex-pet-direction-semantics/v2" &&
      report.ok === true &&
      sameSha256(report.atlas?.sha256, atlasSha256) &&
      Array.isArray(report.errors) &&
      report.errors.length === 0 &&
      Array.isArray(report.warnings) &&
      report.warnings.length === 0 &&
      Array.isArray(report.directions) &&
      report.directions.length === DIRECTION_LABELS.length &&
      report.directions.every(
        (entry, index) => entry?.direction === DIRECTION_LABELS[index] && entry.verdict === "pass",
      ),
  );
}

export function normalizeBlindVerdict(verdict, { atlasSha256, sheetSha256 }) {
  if (
    verdict?.schema !== BLIND_VERDICT_SCHEMA ||
    !sameSha256(verdict.atlasSha256, atlasSha256) ||
    !sameSha256(verdict.blindSheetSha256, sheetSha256) ||
    verdict.attestation?.blindSheetOnly !== true ||
    verdict.attestation?.answerKeySeen !== false ||
    verdict.attestation?.independent !== true ||
    typeof verdict.reviewer !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(verdict.reviewer) ||
    !Array.isArray(verdict.pairs) ||
    verdict.pairs.length !== BLIND_DIRECTION_PAIRS.length
  ) {
    return null;
  }

  const byId = new Map(verdict.pairs.map((entry) => [entry?.pair, entry]));
  if (byId.size !== BLIND_DIRECTION_PAIRS.length) return null;
  const pairs = new Map();
  for (const expectedPair of BLIND_DIRECTION_PAIRS) {
    const entry = byId.get(expectedPair.pair);
    const allowed = expectedPair.axis === "horizontal"
      ? new Set(["screen-left", "screen-right", "ambiguous"])
      : new Set(["up", "down", "ambiguous"]);
    if (entry?.axis !== expectedPair.axis) return null;
    const normalizedSides = {};
    for (const side of ["A", "B"]) {
      const observation = entry[side];
      if (
        !observation ||
        typeof observation !== "object" ||
        "expected" in observation ||
        "pass" in observation ||
        "source_direction" in observation ||
        !allowed.has(observation.observed) ||
        !CONFIDENCE_LEVELS.has(observation.confidence)
      ) {
        return null;
      }
      normalizedSides[side] = {
        observed: observation.observed,
        confidence: observation.confidence,
      };
    }
    pairs.set(expectedPair.pair, normalizedSides);
  }
  return { id: verdict.reviewer, pairs };
}

export function blindVerdictsMatchReport(report, verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length !== 3) return false;
  const normalized = verdicts.map((verdict) =>
    normalizeBlindVerdict(verdict, {
      atlasSha256: report?.atlas?.sha256,
      sheetSha256: report?.blindSheet?.sha256,
    }),
  );
  if (normalized.some((verdict) => verdict === null)) return false;
  const reviewerIds = normalized.map((verdict) => verdict.id);
  if (new Set(reviewerIds.map((id) => id.toLocaleLowerCase())).size !== 3) return false;
  if (
    !Array.isArray(report.reviewers) ||
    report.reviewers.length !== 3 ||
    report.reviewers.some((reviewer) => !reviewerIds.includes(reviewer.id))
  ) {
    return false;
  }

  const reportPairs = new Map(report.pairs?.map((pair) => [pair?.pair, pair]) ?? []);
  return BLIND_DIRECTION_PAIRS.every((expectedPair) => {
    const pair = reportPairs.get(expectedPair.pair);
    return ["A", "B"].every((side) => {
      const votes = new Map(pair?.[side]?.votes?.map((vote) => [vote?.reviewer, vote]) ?? []);
      return normalized.every((verdict) => {
        const source = verdict.pairs.get(expectedPair.pair)[side];
        const compiled = votes.get(verdict.id);
        return compiled?.observed === source.observed && compiled?.confidence === source.confidence;
      });
    });
  });
}

export function blindDirectionReportPasses(report, { atlasSha256 } = {}) {
  if (
    report?.schema !== "codex-pet-direction-blind-review/v2" ||
    report.reviewPolicy !== "unanimous-three-reviewers" ||
    report?.ok !== true ||
    !Array.isArray(report.errors) ||
    report.errors.length > 0 ||
    !Array.isArray(report.warnings) ||
    report.warnings.length > 0 ||
    report.reviewRequired !== false ||
    !Array.isArray(report.unconfirmed) ||
    report.unconfirmed.length > 0 ||
    typeof report.atlas?.file !== "string" ||
    !SHA256_PATTERN.test(report.atlas?.sha256 ?? "") ||
    (atlasSha256 && !sameSha256(report.atlas.sha256, atlasSha256)) ||
    typeof report.blindSheet?.file !== "string" ||
    !SHA256_PATTERN.test(report.blindSheet?.sha256 ?? "") ||
    !Array.isArray(report.reviewers) ||
    report.reviewers.length !== 3 ||
    !Array.isArray(report.pairs) ||
    report.pairs.length !== BLIND_DIRECTION_PAIRS.length
  ) {
    return false;
  }

  if (
    report.reviewers.some(
      (reviewer) =>
        typeof reviewer?.id !== "string" ||
        !/^[a-z0-9][a-z0-9._-]*$/i.test(reviewer.id) ||
        typeof reviewer.file !== "string" ||
        !SHA256_PATTERN.test(reviewer.sha256 ?? ""),
    )
  ) {
    return false;
  }
  const reviewerIds = report.reviewers.map((reviewer) => reviewer.id);
  if (
    new Set(reviewerIds.map((id) => id.toLocaleLowerCase())).size !== 3 ||
    new Set(report.reviewers.map((reviewer) => reviewer.file.toLocaleLowerCase())).size !== 3
  ) {
    return false;
  }

  const pairsById = new Map(report.pairs.map((pair) => [pair?.pair, pair]));
  if (pairsById.size !== BLIND_DIRECTION_PAIRS.length) return false;
  const votesPass = (votes, expected) =>
    Array.isArray(votes) &&
    votes.length === 3 &&
    new Set(votes.map((vote) => vote?.reviewer)).size === 3 &&
    reviewerIds.every((reviewer) => votes.some((vote) => vote?.reviewer === reviewer)) &&
    votes.every(
      (vote) => vote?.observed === expected && PASSING_CONFIDENCE_LEVELS.has(vote?.confidence),
    );
  return BLIND_DIRECTION_PAIRS.every((expectedPair) => {
    const pair = pairsById.get(expectedPair.pair);
    return (
      pair?.axis === expectedPair.axis &&
      pair?.gate === expectedPair.gate &&
      pair.A?.source_direction === expectedPair.A.sourceDirection &&
      pair.A?.expected === expectedPair.A.expected &&
      pair.A?.observed === expectedPair.A.expected &&
      pair.A?.pass === true &&
      votesPass(pair.A?.votes, expectedPair.A.expected) &&
      pair.B?.source_direction === expectedPair.B.sourceDirection &&
      pair.B?.expected === expectedPair.B.expected &&
      pair.B?.observed === expectedPair.B.expected &&
      pair.B?.pass === true &&
      votesPass(pair.B?.votes, expectedPair.B.expected)
    );
  });
}
