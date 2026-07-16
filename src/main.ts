import {
  beginWindowDrag,
  endWindowDrag,
  hidePet,
  isAutostartEnabled,
  movePetWindow,
  quitApp,
  readPetState,
  setAutostart,
  type PetStatePayload,
  type WindowPosition,
} from "./desktop-bridge";
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

type LocalActionKind = "demo" | "drag" | null;

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

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const ATLAS_WIDTH = 1536;
const ATLAS_HEIGHT = 2288;
const POSE_ATLAS_WIDTH = 768;
const POSE_ATLAS_HEIGHT = 832;
const LEGACY_STATE_TTL_MS = 15 * 60 * 1000;
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
  <section class="pet-shell" aria-live="polite">
    <div class="speech-bubble" role="status">陪着你</div>
    <div class="sprite-stage">
      <div class="sprite" role="img" aria-label="Codex 小企鹅"></div>
      <img class="fallback-pet" src="./placeholder.svg" alt="Codex Pet 占位角色" />
    </div>
    <div class="state-dot" aria-hidden="true"></div>
  </section>
  <nav class="context-menu" aria-label="宠物菜单" hidden>
    <button type="button" data-command="pause">暂停动画</button>
    <button type="button" data-command="demo">演示下一个动作</button>
    <button type="button" data-command="autostart">开机自动启动</button>
    <div class="menu-separator"></div>
    <button type="button" data-command="hide">暂时隐藏</button>
    <button type="button" data-command="quit" class="danger">退出</button>
  </nav>
`;

const sprite = app.querySelector<HTMLElement>(".sprite")!;
const fallbackPet = app.querySelector<HTMLImageElement>(".fallback-pet")!;
const bubble = app.querySelector<HTMLElement>(".speech-bubble")!;
const menu = app.querySelector<HTMLElement>(".context-menu")!;
const pauseButton = app.querySelector<HTMLButtonElement>("[data-command='pause']")!;
const autostartButton = app.querySelector<HTMLButtonElement>("[data-command='autostart']")!;
const shell = app.querySelector<HTMLElement>(".pet-shell")!;
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

let action: PetAction = "idle";
let frame = 0;
let completedCycles = 0;
let paused = false;
let reducedMotion = reducedMotionQuery.matches;
let hasAtlas = false;
let lastFrameAt = performance.now();
let localActionKind: LocalActionKind = null;
let localDemoEndsAt = 0;
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
  bubble.textContent = definition.label;
  shell.dataset.state = action;
  renderFrame();
}

function resumeDesiredAction(): void {
  localActionKind = null;
  localDemoEndsAt = 0;
  dragReleasePending = false;
  if (remoteState !== "idle" && !remotePlaybackComplete) {
    setAction(remoteState, true);
  } else {
    setAction("idle", true);
  }
}

function startLocalAction(next: PetAction): void {
  localActionKind = "demo";
  localDemoEndsAt = reducedMotion ? performance.now() + 1200 : 0;
  dragReleasePending = false;
  setAction(next, true);
}

function completeFiniteAction(): void {
  const definition = animations[action];
  if (localActionKind === "demo") {
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
  if (finishedCycle && localActionKind === "demo") {
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
  else if (localActionKind === null) setAction("idle", true);
}

function tick(now: number): void {
  expireRemoteStateIfNeeded();
  if (reducedMotion && localActionKind === "demo" && localDemoEndsAt > 0 && now >= localDemoEndsAt) {
    resumeDesiredAction();
  }
  const definition = animations[action];
  if (!paused && !reducedMotion && !failedHolding && now - lastFrameAt >= frameDuration(definition, frame)) {
    advanceFrame(now);
  }
  const delay = reducedMotion || paused ? 200 : action === "idle" ? 80 : 24;
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
    bubble.textContent = "等待本地宠物素材";
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
  if (remoteState === "idle") setAction("idle", true);
  else setAction(remoteState, true);
}

async function pollPetState(): Promise<void> {
  try {
    applyRemoteState(await readPetState());
  } catch {
    // Web-only preview has no native state bridge.
  } finally {
    window.setTimeout(() => void pollPetState(), remoteState === "idle" ? 1500 : 600);
  }
}

function closeMenu(): void {
  menu.hidden = true;
}

function openMenu(x: number, y: number): void {
  const menuWidth = 184;
  const menuHeight = 220;
  menu.style.left = `${Math.min(x, window.innerWidth - menuWidth - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - menuHeight - 8)}px`;
  menu.hidden = false;
}

async function refreshAutostartLabel(): Promise<void> {
  try {
    const enabled = await isAutostartEnabled();
    autostartButton.textContent = enabled ? "关闭开机启动" : "开启开机启动";
  } catch {
    autostartButton.textContent = "开机启动（桌面版）";
  }
}

async function runCommand(command: string): Promise<void> {
  switch (command) {
    case "pause":
      paused = !paused;
      pauseButton.textContent = paused ? "继续动画" : "暂停动画";
      shell.dataset.motion = paused || reducedMotion ? "reduced" : "full";
      break;
    case "demo": {
      const nextIndex = (demoOrder.indexOf(action) + 1) % demoOrder.length;
      startLocalAction(demoOrder[nextIndex]);
      break;
    }
    case "autostart":
      try {
        await setAutostart(!(await isAutostartEnabled()));
        await refreshAutostartLabel();
      } catch {
        bubble.textContent = "请在桌面版中设置自启";
      }
      break;
    case "hide":
      await hidePet().catch(() => undefined);
      break;
    case "quit":
      await quitApp().catch(() => undefined);
      break;
  }
  closeMenu();
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

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  openMenu(event.clientX, event.clientY);
  void refreshAutostartLabel();
});

window.addEventListener("pointerdown", (event) => {
  if (!menu.contains(event.target as Node) && event.button !== 2) closeMenu();
});

menu.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-command]");
  if (button) void runCommand(button.dataset.command ?? "");
});

reducedMotionQuery.addEventListener("change", (event) => {
  reducedMotion = event.matches;
  shell.dataset.motion = paused || reducedMotion ? "reduced" : "full";
  if (action === "failed" && remoteState === "failed" && localActionKind === null) {
    setAction("failed", true);
  } else {
    failedHolding = false;
    lastFrameAt = performance.now();
  }
});

shell.dataset.motion = reducedMotion ? "reduced" : "full";
void detectAtlas();
void pollPetState();
requestAnimationFrame(tick);
