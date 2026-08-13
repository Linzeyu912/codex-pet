import {
  beginWindowDrag,
  endWindowDrag,
  getCodexIntegrationStatus,
  getPetMovementBounds,
  hidePet,
  isAutostartEnabled,
  installCodexIntegration,
  movePetWindow,
  quitApp,
  readPetState,
  setAutostart,
  type PetStatePayload,
  type CodexIntegrationStatus,
  type WindowPosition,
} from "./desktop-bridge";
import {
  animationTickDelay,
  easeAutoRoam,
  nextAutoActionDelay,
  pickAutonomousAction,
  planAutoRoam,
  randomBetween,
  shouldMoveAutoWindow,
  statePollDelay,
} from "./runtime-policy";
import "./style.css";

type PetAction =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review"
  | "looking"
  | "rolling"
  | "lying"
  | "mischief";

interface FrameCell {
  column: number;
  row: number;
  atlas?: "main" | "poses";
}

interface AnimationDefinition {
  row?: number;
  cells?: FrameCell[];
  frames: number;
  durations: number[];
  label: string;
  cycles?: number;
  holdFrame?: number;
}

type LocalActionKind = "demo" | "drag" | "auto" | null;

interface DragSession {
  generation: number;
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  lastScreenX: number;
  latestScreenX: number;
  latestScreenY: number;
  origin?: WindowPosition;
  moved: boolean;
  direction?: "running-right" | "running-left";
}

interface AutoRoamSession {
  origin: WindowPosition;
  target: WindowPosition;
  startedAt: number;
  duration: number;
  lastMovedAt: number;
}

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const ATLAS_WIDTH = 1536;
const ATLAS_HEIGHT = 2288;
const POSE_ATLAS_WIDTH = 768;
const POSE_ATLAS_HEIGHT = 832;
const LEGACY_STATE_TTL_MS = 15 * 60 * 1000;
const AUTO_ROAM_STORAGE_KEY = "codex-pet:auto-roam";
const ONBOARDING_DISMISSED_KEY = "codex-pet:onboarding-dismissed:1";
const ATLAS_URL = new URL("./local/spritesheet.webp", window.location.href).href;
const POSE_ATLAS_URL = new URL("./local/desktop-poses.png", window.location.href).href;

const lookCells = Array.from({ length: 16 }, (_, index) => ({
  column: index % 8,
  row: 9 + Math.floor(index / 8),
}));

const animations: Record<PetAction, AnimationDefinition> = {
  idle: { row: 0, frames: 6, durations: [280, 110, 110, 140, 140, 320], label: "陪着你" },
  "running-right": {
    row: 1,
    frames: 8,
    durations: [120, 120, 120, 120, 120, 120, 120, 220],
    label: "向右散步",
  },
  "running-left": {
    row: 2,
    frames: 8,
    durations: [120, 120, 120, 120, 120, 120, 120, 220],
    label: "向左散步",
  },
  waving: { row: 3, frames: 4, durations: [140, 140, 140, 280], label: "你好呀", cycles: 4 },
  jumping: {
    row: 4,
    frames: 5,
    durations: [140, 140, 140, 140, 280],
    label: "完成啦",
    cycles: 3,
  },
  failed: {
    row: 5,
    frames: 8,
    durations: [140, 140, 140, 140, 140, 140, 140, 240],
    label: "遇到问题了",
    cycles: 1,
    holdFrame: 4,
  },
  waiting: {
    row: 6,
    frames: 6,
    durations: [150, 150, 150, 150, 150, 260],
    label: "等你确认",
  },
  running: {
    row: 7,
    frames: 6,
    durations: [120, 120, 120, 120, 120, 220],
    label: "Codex 正在工作",
  },
  review: {
    row: 8,
    frames: 6,
    durations: [150, 150, 150, 150, 150, 280],
    label: "正在检查",
  },
  looking: {
    cells: lookCells,
    frames: 16,
    durations: Array.from({ length: 16 }, () => 170),
    label: "四处看看",
    cycles: 1,
  },
  rolling: {
    row: 5,
    frames: 8,
    durations: [140, 140, 140, 140, 140, 140, 140, 240],
    label: "摔倒又爬起",
    cycles: 1,
  },
  lying: {
    cells: [0, 1, 2, 3, 4, 4, 4, 3, 2, 1, 0].map((column) => ({ column, row: 5 })),
    frames: 11,
    durations: [180, 160, 160, 180, 420, 900, 420, 180, 160, 160, 240],
    label: "躺一会儿",
    cycles: 1,
  },
  mischief: {
    cells: [0, 1, 2, 3, 2, 1, 0].map((column) => ({ column, row: 5 })),
    frames: 7,
    durations: [180, 150, 150, 360, 150, 150, 240],
    label: "嘿嘿，装摔一下",
    cycles: 1,
  },
};

function configureDesktopPoseAnimations(): void {
  const mainIdle: FrameCell = { column: 0, row: 0, atlas: "main" };
  const pose = (index: number): FrameCell => ({
    column: index % 4,
    row: Math.floor(index / 4),
    atlas: "poses",
  });
  animations.mischief = {
    cells: [mainIdle, pose(9), pose(8), pose(9), pose(10), pose(11), pose(10), pose(9), mainIdle],
    frames: 9,
    durations: [160, 160, 240, 160, 160, 360, 160, 160, 220],
    label: "背过身偷偷调皮",
    cycles: 1,
  };
  animations.lying = {
    cells: [
      mainIdle,
      pose(10), pose(11), pose(13), pose(12), pose(13),
      pose(13), pose(13), pose(12), pose(13), pose(11), pose(15),
      mainIdle,
    ],
    frames: 13,
    durations: [160, 150, 160, 180, 220, 300, 760, 300, 220, 180, 160, 180, 220],
    label: "侧躺一会儿",
    cycles: 1,
  };
  animations.rolling = {
    cells: [
      mainIdle,
      pose(10), pose(11), pose(13), pose(12), pose(13), pose(14),
      pose(13), pose(12), pose(13), pose(11), pose(15),
      mainIdle,
    ],
    frames: 13,
    durations: [150, 140, 150, 160, 170, 170, 260, 170, 170, 160, 150, 180, 220],
    label: "翻身又坐起来",
    cycles: 1,
  };
}

const demoOrder: PetAction[] = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "looking",
  "mischief",
  "rolling",
  "lying",
  "failed",
  "waiting",
  "running",
  "review",
];
const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Codex Pet root element is missing.");

app.innerHTML = `
  <section
    class="pet-shell"
    tabindex="0"
    aria-label="Codex 小企鹅，可拖动移动，按 Enter 挥手，按菜单键打开操作菜单"
    aria-describedby="pet-status"
    aria-keyshortcuts="Enter Space Shift+F10"
    aria-haspopup="menu"
    aria-controls="pet-menu"
    aria-expanded="false"
  >
    <div class="speech-bubble" id="pet-status" role="status" aria-live="polite" aria-atomic="true">
      <span class="bubble-status-dot" aria-hidden="true"></span>
      <span class="bubble-label">陪着你</span>
    </div>
    <div class="sprite-stage">
      <div class="sprite" role="img" aria-label="Codex 小企鹅"></div>
      <img class="fallback-pet" src="./aurora-penguin.png" alt="Aurora 企鹅桌面伙伴" />
    </div>
  </section>
  <div class="context-menu" id="pet-menu" role="menu" aria-label="宠物菜单" hidden>
    <button type="button" role="menuitem" data-command="codex-integration">连接 Codex…</button>
    <div class="menu-separator" role="separator"></div>
    <button type="button" role="menuitemcheckbox" aria-checked="false" data-command="pause">暂停动画</button>
    <button type="button" role="menuitemcheckbox" aria-checked="true" data-command="auto-roam">自动闲逛</button>
    <button type="button" role="menuitem" data-command="demo">换个动作</button>
    <div class="menu-heading" role="presentation">指定动作</div>
    <button type="button" role="menuitem" data-action="waving">挥手</button>
    <button type="button" role="menuitem" data-action="jumping">跳一下</button>
    <button type="button" role="menuitem" data-action="looking">四处看看</button>
    <button type="button" role="menuitem" data-action="mischief">调皮一下</button>
    <button type="button" role="menuitem" data-action="rolling">翻个身</button>
    <button type="button" role="menuitem" data-action="lying">躺一会儿</button>
    <button type="button" role="menuitemcheckbox" aria-checked="false" data-command="autostart">开机自动启动</button>
    <div class="menu-separator" role="separator"></div>
    <button type="button" role="menuitem" data-command="hide">暂时隐藏</button>
    <button type="button" role="menuitem" data-command="quit" class="danger">退出 Codex Pet</button>
  </div>
  <section class="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" hidden>
    <h2 id="onboarding-title">让 Aurora 认识 Codex</h2>
    <p class="onboarding-status">一键安装宠物素材，并在任务完成时让它跳起来。</p>
    <p class="onboarding-path" hidden></p>
    <div class="onboarding-actions">
      <button type="button" class="primary" data-onboarding="install">一键连接</button>
      <button type="button" data-onboarding="dismiss">稍后</button>
    </div>
  </section>
`;

const sprite = app.querySelector<HTMLElement>(".sprite")!;
const fallbackPet = app.querySelector<HTMLImageElement>(".fallback-pet")!;
const bubbleLabel = app.querySelector<HTMLElement>(".bubble-label")!;
const menu = app.querySelector<HTMLElement>(".context-menu")!;
const pauseButton = app.querySelector<HTMLButtonElement>("[data-command='pause']")!;
const autoRoamButton = app.querySelector<HTMLButtonElement>("[data-command='auto-roam']")!;
const autostartButton = app.querySelector<HTMLButtonElement>("[data-command='autostart']")!;
const shell = app.querySelector<HTMLElement>(".pet-shell")!;
const onboarding = app.querySelector<HTMLElement>(".onboarding")!;
const onboardingStatus = app.querySelector<HTMLElement>(".onboarding-status")!;
const onboardingPath = app.querySelector<HTMLElement>(".onboarding-path")!;
const onboardingInstall = app.querySelector<HTMLButtonElement>("[data-onboarding='install']")!;
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

let action: PetAction = "idle";
let frame = 0;
let completedCycles = 0;
let paused = false;
let reducedMotion = reducedMotionQuery.matches;
let hasAtlas = false;
let lastFrameAt = performance.now();
let localActionKind: LocalActionKind = null;
let localActionEndsAt = 0;
let dragReleasePending = false;
let dragSession: DragSession | null = null;
let dragGeneration = 0;
let deferredRemoteState = false;
let failedHolding = false;
let remoteState: PetAction = "idle";
let remotePlaybackComplete = false;
let remoteSessionId = "";
let remoteExpiresAt = 0;
let lastRemoteStamp = 0;
let queuedWindowPosition: WindowPosition | null = null;
let movingWindow = false;
let noticeTimer = 0;
let autoRoam = window.localStorage.getItem(AUTO_ROAM_STORAGE_KEY) !== "false";
let nextAutoActionAt = performance.now() + nextAutoActionDelay();
let autoRoamSession: AutoRoamSession | null = null;
let autoRoamGeneration = 0;
let autoRoamStopPending = false;

function frameDuration(definition: AnimationDefinition, index: number): number {
  return definition.durations[index % definition.durations.length];
}

function renderFrame(): void {
  if (!hasAtlas) return;
  const definition = animations[action];
  const cell = definition.cells?.[frame % definition.cells.length];
  const column = cell?.column ?? frame % definition.frames;
  const row = cell?.row ?? definition.row ?? 0;
  const usesPoseAtlas = cell?.atlas === "poses";
  sprite.style.backgroundImage = `url("${usesPoseAtlas ? POSE_ATLAS_URL : ATLAS_URL}")`;
  sprite.style.backgroundSize = usesPoseAtlas
    ? `${POSE_ATLAS_WIDTH}px ${POSE_ATLAS_HEIGHT}px`
    : `${ATLAS_WIDTH}px ${ATLAS_HEIGHT}px`;
  sprite.style.backgroundPosition = `${-column * CELL_WIDTH}px ${-row * CELL_HEIGHT}px`;
}

function setAction(next: PetAction, restart = false): void {
  if (!(next in animations)) return;
  if (next !== action || restart) {
    action = next;
    frame = 0;
    completedCycles = 0;
    lastFrameAt = performance.now();
    failedHolding = false;
  }
  const definition = animations[action];
  if (reducedMotion && action === "failed" && remoteState === "failed" && localActionKind === null) {
    frame = definition.holdFrame ?? definition.frames - 1;
    failedHolding = true;
  }
  if (shell.dataset.notice !== "true") bubbleLabel.textContent = definition.label;
  shell.dataset.state = action;
  renderFrame();
}

function showNotice(message: string): void {
  window.clearTimeout(noticeTimer);
  shell.dataset.notice = "true";
  bubbleLabel.textContent = message;
  noticeTimer = window.setTimeout(() => {
    delete shell.dataset.notice;
    bubbleLabel.textContent = animations[action].label;
  }, 2400);
}

function integrationReady(status: CodexIntegrationStatus): boolean {
  return status.petInstalled && status.notifyConfigured;
}

function renderIntegrationStatus(status: CodexIntegrationStatus): void {
  onboardingPath.hidden = true;
  if (integrationReady(status)) {
    onboardingStatus.textContent = "已连接。任务完成时 Aurora 会跳起来；可在 Codex 的 Pets 中选择它。";
    onboardingInstall.textContent = "完成";
    onboardingInstall.disabled = false;
    onboardingInstall.dataset.complete = "true";
  } else if (status.notifyConflict) {
    onboardingStatus.textContent = status.petInstalled
      ? "宠物素材已安装，但检测到已有 notify 配置。为了不覆盖你的命令，通知桥接未改动。"
      : "检测到已有 notify 配置。连接时会保留它，不会静默覆盖。";
    onboardingPath.textContent = `配置文件：${status.configPath}`;
    onboardingPath.hidden = false;
    onboardingInstall.textContent = status.petInstalled ? "重新检查" : "安装宠物素材";
    onboardingInstall.disabled = false;
    delete onboardingInstall.dataset.complete;
  } else {
    onboardingStatus.textContent = "一键安装 Aurora 宠物素材，并在 Codex 任务完成时让它跳起来。";
    onboardingInstall.textContent = "一键连接";
    onboardingInstall.disabled = false;
    delete onboardingInstall.dataset.complete;
  }
}

function openOnboarding(): void {
  closeMenu();
  cancelAutoRoamMovement();
  nextAutoActionAt = Number.POSITIVE_INFINITY;
  onboarding.hidden = false;
  shell.setAttribute("aria-hidden", "true");
  onboardingInstall.focus({ preventScroll: true });
}

function closeOnboarding(): void {
  onboarding.hidden = true;
  shell.removeAttribute("aria-hidden");
  shell.focus({ preventScroll: true });
  scheduleNextAutoAction();
}

async function refreshIntegrationStatus(showWhenIncomplete = false): Promise<void> {
  try {
    const status = await getCodexIntegrationStatus();
    renderIntegrationStatus(status);
    if (showWhenIncomplete && !integrationReady(status)) openOnboarding();
  } catch {
    // Browser-only previews do not expose the native integration bridge.
  }
}

async function connectCodex(): Promise<void> {
  if (onboardingInstall.dataset.complete === "true") {
    window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    closeOnboarding();
    return;
  }
  onboardingInstall.disabled = true;
  onboardingStatus.textContent = "正在安全安装并检查 Codex 配置…";
  onboardingPath.hidden = true;
  try {
    const status = await installCodexIntegration();
    renderIntegrationStatus(status);
    if (integrationReady(status)) {
      window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
      startLocalAction("jumping");
    }
  } catch (error) {
    onboardingStatus.textContent = typeof error === "string" ? error : "连接失败，未覆盖现有配置。";
    onboardingInstall.textContent = "重试";
    onboardingInstall.disabled = false;
  }
}

function scheduleNextAutoAction(minimumMs?: number, maximumMs?: number): void {
  const delay = minimumMs === undefined || maximumMs === undefined
    ? nextAutoActionDelay()
    : randomBetween(minimumMs, maximumMs);
  nextAutoActionAt = performance.now() + delay;
}

function cancelAutoRoamMovement(): void {
  autoRoamGeneration += 1;
  autoRoamSession = null;
  autoRoamStopPending = false;
}

function resumeDesiredAction(): void {
  cancelAutoRoamMovement();
  localActionKind = null;
  localActionEndsAt = 0;
  dragReleasePending = false;
  if (remoteState !== "idle" && !remotePlaybackComplete) {
    setAction(remoteState, true);
  } else {
    setAction("idle", true);
    scheduleNextAutoAction();
  }
}

function startLocalAction(next: PetAction, kind: Exclude<LocalActionKind, "drag" | null> = "demo"): void {
  cancelAutoRoamMovement();
  localActionKind = kind;
  localActionEndsAt = reducedMotion ? performance.now() + 1200 : 0;
  dragReleasePending = false;
  setAction(next, true);
}

async function startAutoRoamMovement(preferredDirection: "running-right" | "running-left"): Promise<void> {
  const generation = ++autoRoamGeneration;
  nextAutoActionAt = performance.now() + 60_000;
  try {
    const [origin, bounds] = await Promise.all([beginWindowDrag(), getPetMovementBounds()]);
    if (
      generation !== autoRoamGeneration ||
      !autoRoam ||
      paused ||
      reducedMotion ||
      dragSession ||
      remoteState !== "idle" ||
      localActionKind !== null
    ) return;

    const plan = planAutoRoam(origin, bounds, preferredDirection);
    if (!plan) {
      scheduleNextAutoAction(3_000, 7_000);
      return;
    }

    autoRoamSession = {
      origin,
      target: plan.target,
      startedAt: performance.now(),
      duration: plan.duration,
      lastMovedAt: Number.NEGATIVE_INFINITY,
    };
    autoRoamStopPending = false;
    localActionKind = "auto";
    localActionEndsAt = 0;
    setAction(plan.direction, true);
  } catch {
    if (generation === autoRoamGeneration) scheduleNextAutoAction(4_000, 8_000);
  }
}

function startAutonomousAction(): void {
  if (!autoRoam || paused || reducedMotion || dragSession || remoteState !== "idle" || localActionKind !== null) {
    scheduleNextAutoAction();
    return;
  }
  const next = pickAutonomousAction();
  if (next === "idle") {
    scheduleNextAutoAction(4_000, 9_000);
  } else if (next === "running-right" || next === "running-left") {
    void startAutoRoamMovement(next);
  } else {
    startLocalAction(next, "auto");
  }
}

function updateAutoRoam(now: number): void {
  if (!autoRoamSession) return;
  const progress = Math.min(1, Math.max(0, (now - autoRoamSession.startedAt) / autoRoamSession.duration));
  if (shouldMoveAutoWindow(now, autoRoamSession.lastMovedAt, progress)) {
    const eased = easeAutoRoam(progress);
    queueWindowMove({
      x: autoRoamSession.origin.x + (autoRoamSession.target.x - autoRoamSession.origin.x) * eased,
      y: autoRoamSession.origin.y,
    });
    autoRoamSession.lastMovedAt = now;
  }
  if (progress >= 1) {
    autoRoamSession = null;
    autoRoamStopPending = true;
  }
}

function completeFiniteAction(): void {
  const definition = animations[action];
  if (localActionKind === "demo" || localActionKind === "auto") {
    resumeDesiredAction();
    return;
  }
  if (action === "failed" && remoteState === "failed") {
    frame = definition.holdFrame ?? definition.frames - 1;
    failedHolding = true;
    renderFrame();
    return;
  }
  if (remoteState === action) remotePlaybackComplete = true;
  resumeDesiredAction();
}

function advanceFrame(now: number): void {
  const definition = animations[action];
  const nextFrame = (frame + 1) % definition.frames;
  const finishedCycle = nextFrame === 0;
  if (finishedCycle) completedCycles += 1;

  if (finishedCycle && dragReleasePending) {
    resumeDesiredAction();
    return;
  }
  if (finishedCycle && autoRoamStopPending && localActionKind === "auto") {
    resumeDesiredAction();
    return;
  }
  if (finishedCycle && (localActionKind === "demo" || localActionKind === "auto")) {
    const requiredCycles = definition.cycles ?? 1;
    if (completedCycles >= requiredCycles) {
      completeFiniteAction();
      return;
    }
  }
  if (finishedCycle && definition.cycles && completedCycles >= definition.cycles) {
    completeFiniteAction();
    return;
  }

  frame = nextFrame;
  lastFrameAt = now;
  renderFrame();
}

function expireRemoteStateIfNeeded(): void {
  if (remoteState === "idle" || remoteExpiresAt <= 0 || Date.now() < remoteExpiresAt) return;
  remoteState = "idle";
  remoteExpiresAt = 0;
  remotePlaybackComplete = false;
  if (dragSession) deferredRemoteState = true;
  else if (localActionKind === null) {
    setAction("idle", true);
    scheduleNextAutoAction();
  }
}

function tick(now: number): void {
  expireRemoteStateIfNeeded();
  updateAutoRoam(now);
  if (reducedMotion && localActionKind === "demo" && localActionEndsAt > 0 && now >= localActionEndsAt) {
    resumeDesiredAction();
  }
  const definition = animations[action];
  if (!paused && !reducedMotion && !failedHolding && now - lastFrameAt >= frameDuration(definition, frame)) {
    advanceFrame(now);
  }
  if (now >= nextAutoActionAt && action === "idle" && localActionKind === null) startAutonomousAction();
  const delay = animationTickDelay({
    hidden: document.hidden,
    paused,
    reducedMotion,
    idle: action === "idle" && !autoRoamSession,
  });
  window.setTimeout(() => requestAnimationFrame(tick), delay);
}

function imageHasDimensions(url: string, width: number, height: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = new Image();
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      probe.onload = null;
      probe.onerror = null;
      resolve(result);
    };
    const timeout = window.setTimeout(() => finish(false), 5000);
    probe.onload = () => finish(probe.naturalWidth === width && probe.naturalHeight === height);
    probe.onerror = () => finish(false);
    probe.src = url;
  });
}

async function detectAtlas(): Promise<void> {
  const [mainAtlasAvailable, hasPoseAtlas] = await Promise.all([
    imageHasDimensions(ATLAS_URL, ATLAS_WIDTH, ATLAS_HEIGHT),
    imageHasDimensions(POSE_ATLAS_URL, POSE_ATLAS_WIDTH, POSE_ATLAS_HEIGHT),
  ]);
  hasAtlas = mainAtlasAvailable;

  sprite.hidden = !hasAtlas;
  fallbackPet.hidden = hasAtlas;
  if (hasAtlas) {
    if (hasPoseAtlas) configureDesktopPoseAnimations();
    renderFrame();
  } else {
    window.clearTimeout(noticeTimer);
    shell.dataset.notice = "true";
    bubbleLabel.textContent = "等待本地宠物素材";
  }
}

function payloadExpiry(payload: PetStatePayload): number {
  let parsedExpiry = Number.NaN;
  if (typeof payload.expiresAt === "number") {
    parsedExpiry = payload.expiresAt;
  } else if (typeof payload.expiresAt === "string" && payload.expiresAt.trim()) {
    const numeric = Number(payload.expiresAt);
    parsedExpiry = Number.isFinite(numeric) ? numeric : Date.parse(payload.expiresAt);
  }
  if (Number.isFinite(parsedExpiry) && parsedExpiry > 0) return parsedExpiry;
  const updatedAt = isValidExternalUpdatedAt(payload.updatedAt) ? payload.updatedAt : 0;
  return payload.state === "idle" ? 0 : updatedAt + LEGACY_STATE_TTL_MS;
}

function normalizeSessionId(sessionId: unknown): string {
  if (typeof sessionId !== "string") return "legacy";
  return sessionId.trim() || "legacy";
}

function isValidExternalUpdatedAt(updatedAt: unknown): updatedAt is number {
  return typeof updatedAt === "number" && Number.isSafeInteger(updatedAt) && updatedAt > 0;
}

function applyRemoteState(payload: PetStatePayload): void {
  const updatedAt = payload.updatedAt;
  if (!(payload.state in animations) || !isValidExternalUpdatedAt(updatedAt)) return;
  const sessionId = normalizeSessionId(payload.sessionId);
  const newSession = sessionId !== remoteSessionId;
  if (!newSession && updatedAt <= lastRemoteStamp) {
    expireRemoteStateIfNeeded();
    return;
  }

  remoteSessionId = sessionId;
  lastRemoteStamp = updatedAt;
  cancelAutoRoamMovement();
  remoteState = payload.state;
  remoteExpiresAt = payloadExpiry(payload);
  remotePlaybackComplete = false;
  expireRemoteStateIfNeeded();
  if (dragSession) {
    deferredRemoteState = true;
    return;
  }

  deferredRemoteState = false;
  localActionKind = null;
  if (remoteState === "idle") {
    setAction("idle", true);
    scheduleNextAutoAction();
  } else {
    setAction(remoteState, true);
    nextAutoActionAt = Number.POSITIVE_INFINITY;
  }
}

async function pollPetState(): Promise<void> {
  try {
    applyRemoteState(await readPetState());
  } catch {
    // Web-only preview has no native state bridge.
  } finally {
    window.setTimeout(
      () => void pollPetState(),
      statePollDelay({ hidden: document.hidden, idle: remoteState === "idle" }),
    );
  }
}

function closeMenu(restoreFocus = false): void {
  if (menu.hidden) return;
  const hadMenuFocus = menu.contains(document.activeElement);
  menu.hidden = true;
  shell.setAttribute("aria-expanded", "false");
  menu.style.removeProperty("visibility");
  if (restoreFocus || hadMenuFocus) shell.focus({ preventScroll: true });
}

function openMenu(x: number, y: number): void {
  const edge = 8;
  menu.hidden = false;
  shell.setAttribute("aria-expanded", "true");
  menu.style.visibility = "hidden";
  menu.style.left = "0";
  menu.style.top = "0";

  const bounds = menu.getBoundingClientRect();
  const maxLeft = Math.max(edge, window.innerWidth - bounds.width - edge);
  const maxTop = Math.max(edge, window.innerHeight - bounds.height - edge);
  menu.style.left = `${Math.max(edge, Math.min(x, maxLeft))}px`;
  menu.style.top = `${Math.max(edge, Math.min(y, maxTop))}px`;
  menu.style.removeProperty("visibility");

  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
}

async function refreshAutostartLabel(): Promise<void> {
  try {
    const enabled = await isAutostartEnabled();
    autostartButton.textContent = "开机自动启动";
    autostartButton.disabled = false;
    autostartButton.setAttribute("aria-checked", String(enabled));
  } catch {
    autostartButton.textContent = "开机启动（仅桌面版）";
    autostartButton.disabled = true;
    autostartButton.setAttribute("aria-checked", "false");
  }
}

function syncMotionControl(): void {
  pauseButton.disabled = reducedMotion;
  pauseButton.textContent = reducedMotion ? "系统已减少动画" : paused ? "继续动画" : "暂停动画";
  pauseButton.setAttribute("aria-checked", String(paused || reducedMotion));
  shell.dataset.motion = paused || reducedMotion ? "reduced" : "full";
  autoRoamButton.disabled = reducedMotion;
  autoRoamButton.setAttribute("aria-checked", String(autoRoam && !reducedMotion));
}

async function runCommand(command: string): Promise<void> {
  switch (command) {
    case "pause":
      paused = !paused;
      if (paused && localActionKind === "auto") resumeDesiredAction();
      if (!paused && autoRoam) scheduleNextAutoAction(1_000, 3_000);
      syncMotionControl();
      showNotice(paused ? "动画已暂停" : "动画已继续");
      break;
    case "auto-roam":
      autoRoam = !autoRoam;
      window.localStorage.setItem(AUTO_ROAM_STORAGE_KEY, String(autoRoam));
      autoRoamButton.setAttribute("aria-checked", String(autoRoam));
      if (autoRoam) {
        scheduleNextAutoAction(600, 1_600);
        showNotice("已开启自动闲逛");
      } else {
        if (localActionKind === "auto") resumeDesiredAction();
        else cancelAutoRoamMovement();
        showNotice("已关闭自动闲逛");
      }
      break;
    case "demo": {
      const nextIndex = (demoOrder.indexOf(action) + 1) % demoOrder.length;
      startLocalAction(demoOrder[nextIndex]);
      break;
    }
    case "codex-integration":
      await refreshIntegrationStatus();
      openOnboarding();
      break;
    case "autostart":
      try {
        const enabled = !(await isAutostartEnabled());
        await setAutostart(enabled);
        await refreshAutostartLabel();
        showNotice(enabled ? "已开启开机启动" : "已关闭开机启动");
      } catch {
        showNotice("无法更改开机启动设置");
      }
      break;
    case "hide":
      await hidePet().catch(() => undefined);
      break;
    case "quit":
      await quitApp().catch(() => undefined);
      break;
  }
  closeMenu(true);
}

async function flushWindowMoves(): Promise<void> {
  if (movingWindow) return;
  movingWindow = true;
  try {
    while (queuedWindowPosition) {
      const position = queuedWindowPosition;
      queuedWindowPosition = null;
      await movePetWindow(position.x, position.y);
    }
  } catch {
    queuedWindowPosition = null;
  } finally {
    movingWindow = false;
  }
}

function queueWindowMove(position: WindowPosition): void {
  queuedWindowPosition = position;
  void flushWindowMoves();
}

function finishDrag(pointerId?: number): void {
  if (!dragSession || (pointerId !== undefined && pointerId !== dragSession.pointerId)) return;
  const session = dragSession;
  dragSession = null;
  shell.dataset.dragging = "false";
  if (shell.hasPointerCapture(session.pointerId)) shell.releasePointerCapture(session.pointerId);
  void endWindowDrag();
  if (deferredRemoteState) {
    deferredRemoteState = false;
    resumeDesiredAction();
    return;
  }
  if (!session.moved || localActionKind !== "drag") return;
  if (!session.direction || paused || reducedMotion || frame === 0) resumeDesiredAction();
  else dragReleasePending = true;
}

shell.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.detail > 1) return;
  if (localActionKind === "auto") resumeDesiredAction();
  else cancelAutoRoamMovement();
  closeMenu();
  const session: DragSession = {
    generation: ++dragGeneration,
    pointerId: event.pointerId,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    lastScreenX: event.screenX,
    latestScreenX: event.screenX,
    latestScreenY: event.screenY,
    moved: false,
  };
  dragSession = session;
  shell.dataset.dragging = "true";
  shell.setPointerCapture(event.pointerId);
  void beginWindowDrag()
    .then((origin) => {
      if (session.generation !== dragGeneration) return;
      session.origin = origin;
      if (session.moved) {
        queueWindowMove({
          x: origin.x + session.latestScreenX - session.startScreenX,
          y: origin.y + session.latestScreenY - session.startScreenY,
        });
      }
    })
    .catch(() => undefined);
});

shell.addEventListener("pointermove", (event) => {
  const session = dragSession;
  if (!session || event.pointerId !== session.pointerId) return;
  session.latestScreenX = event.screenX;
  session.latestScreenY = event.screenY;
  const deltaX = event.screenX - session.startScreenX;
  const deltaY = event.screenY - session.startScreenY;
  if (!session.moved && Math.hypot(deltaX, deltaY) < 4) return;
  session.moved = true;
  localActionKind = "drag";

  if (session.origin) {
    queueWindowMove({ x: session.origin.x + deltaX, y: session.origin.y + deltaY });
  }
  const stepX = event.screenX - session.lastScreenX;
  if (Math.abs(stepX) >= 1.5) {
    const direction = stepX > 0 ? "running-right" : "running-left";
    if (session.direction !== direction) {
      session.direction = direction;
      localActionKind = "drag";
      dragReleasePending = false;
      setAction(direction, true);
    }
    session.lastScreenX = event.screenX;
  }
});

shell.addEventListener("pointerup", (event) => finishDrag(event.pointerId));
shell.addEventListener("pointercancel", (event) => finishDrag(event.pointerId));
window.addEventListener("blur", () => finishDrag());
shell.addEventListener("dblclick", () => startLocalAction("waving"));

shell.addEventListener("keydown", (event) => {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    const stageBounds = shell.querySelector<HTMLElement>(".sprite-stage")!.getBoundingClientRect();
    openMenu(stageBounds.left + stageBounds.width / 2, stageBounds.top + 48);
    void refreshAutostartLabel();
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    startLocalAction("waving");
  }
});

shell.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  openMenu(event.clientX, event.clientY);
  void refreshAutostartLabel();
});

menu.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("pointerdown", (event) => {
  if (!menu.contains(event.target as Node) && event.button !== 2) closeMenu();
});

menu.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!target) return;
  if (target.dataset.action && target.dataset.action in animations) {
    startLocalAction(target.dataset.action as PetAction);
    closeMenu(true);
  } else if (target.dataset.command) {
    void runCommand(target.dataset.command);
  }
});

menu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu(true);
    return;
  }

  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  if (!items.length) return;
  const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
  let nextIndex: number | undefined;
  if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
    nextIndex = (currentIndex + 1) % items.length;
  } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
    nextIndex = (currentIndex - 1 + items.length) % items.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = items.length - 1;
  }
  if (nextIndex !== undefined) {
    event.preventDefault();
    items[nextIndex].focus({ preventScroll: true });
  }
});

window.addEventListener("resize", () => closeMenu());

onboarding.addEventListener("click", (event) => {
  const command = (event.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.onboarding;
  if (command === "install") void connectCodex();
  if (command === "dismiss") {
    window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    closeOnboarding();
  }
});

onboarding.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
    closeOnboarding();
  }
});

reducedMotionQuery.addEventListener("change", (event) => {
  reducedMotion = event.matches;
  if (reducedMotion && localActionKind === "auto") resumeDesiredAction();
  syncMotionControl();
  if (action === "failed" && remoteState === "failed" && localActionKind === null) {
    setAction("failed", true);
  } else {
    failedHolding = false;
    lastFrameAt = performance.now();
  }
});

syncMotionControl();
void detectAtlas();
void pollPetState();
void refreshIntegrationStatus(window.localStorage.getItem(ONBOARDING_DISMISSED_KEY) !== "true");
requestAnimationFrame(tick);
