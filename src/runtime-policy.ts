export type AutonomousAction =
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "looking"
  | "mischief"
  | "rolling"
  | "lying"
  | "idle";

export type RoamDirection = "running-right" | "running-left";

export interface Point {
  x: number;
  y: number;
}

export interface MovementBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface AutoRoamPlan {
  direction: RoamDirection;
  target: Point;
  distance: number;
  duration: number;
}

export const AUTO_MOVE_INTERVAL_MS = 64;

export const AUTONOMOUS_ACTION_WEIGHTS: ReadonlyArray<readonly [AutonomousAction, number]> = [
  ["running-right", 2],
  ["running-left", 2],
  ["waving", 2],
  ["jumping", 1],
  ["looking", 3],
  ["mischief", 1],
  ["rolling", 1],
  ["lying", 2],
  ["idle", 4],
];

function unitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1 - Number.EPSILON, Math.max(0, value));
}

export function randomBetween(minimum: number, maximum: number, random = Math.random): number {
  return minimum + unitInterval(random()) * Math.max(0, maximum - minimum);
}

export function nextAutoActionDelay(random = Math.random): number {
  return randomBetween(12_000, 28_000, random);
}

export function pickAutonomousAction(random = Math.random): AutonomousAction {
  const totalWeight = AUTONOMOUS_ACTION_WEIGHTS.reduce((total, [, weight]) => total + weight, 0);
  let cursor = unitInterval(random()) * totalWeight;
  for (const [action, weight] of AUTONOMOUS_ACTION_WEIGHTS) {
    if (cursor < weight) return action;
    cursor -= weight;
  }
  return AUTONOMOUS_ACTION_WEIGHTS[AUTONOMOUS_ACTION_WEIGHTS.length - 1][0];
}

export function planAutoRoam(
  origin: Point,
  bounds: MovementBounds,
  preferredDirection: RoamDirection,
  random = Math.random,
): AutoRoamPlan | null {
  const edge = 12;
  const minX = Math.min(bounds.maxX, bounds.minX + edge);
  const maxX = Math.max(minX, bounds.maxX - edge);
  const roomLeft = Math.max(0, origin.x - minX);
  const roomRight = Math.max(0, maxX - origin.x);
  let direction = preferredDirection;
  if (direction === "running-right" && roomRight < 48 && roomLeft > roomRight) direction = "running-left";
  if (direction === "running-left" && roomLeft < 48 && roomRight > roomLeft) direction = "running-right";

  const available = direction === "running-right" ? roomRight : roomLeft;
  if (available < 24) return null;

  const distance = randomBetween(Math.min(72, available), Math.min(220, available), random);
  const signedDistance = direction === "running-right" ? distance : -distance;
  return {
    direction,
    target: {
      x: Math.max(minX, Math.min(maxX, origin.x + signedDistance)),
      y: origin.y,
    },
    distance,
    duration: Math.max(1_400, distance * 12),
  };
}

export function easeAutoRoam(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped < 0.5
    ? 2 * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 2) / 2;
}

export function shouldMoveAutoWindow(now: number, lastMovedAt: number, progress: number): boolean {
  return progress >= 1 || now - lastMovedAt >= AUTO_MOVE_INTERVAL_MS;
}

export function animationTickDelay(options: {
  hidden: boolean;
  paused: boolean;
  reducedMotion: boolean;
  idle: boolean;
}): number {
  if (options.hidden) return 1_000;
  if (options.paused || options.reducedMotion) return 400;
  return options.idle ? 96 : 40;
}

export function statePollDelay(options: { hidden: boolean; idle: boolean }): number {
  if (options.hidden) return 3_000;
  return options.idle ? 2_000 : 750;
}
