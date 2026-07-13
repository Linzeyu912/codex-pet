import {
  beginWindowDrag,
  endWindowDrag,
  hidePet,
  isAutostartEnabled,
  quitApp,
  readPetState,
  setAutostart,
  type PetStatePayload,
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
  | "review";

interface AnimationDefinition {
  row: number;
  frames: number;
  frameMs: number;
  label: string;
  transientMs?: number;
}

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const ATLAS_WIDTH = 1536;
const ATLAS_HEIGHT = 2288;
const ATLAS_URL = new URL("./local/spritesheet.webp", window.location.href).href;

const animations: Record<PetAction, AnimationDefinition> = {
  idle: { row: 0, frames: 6, frameMs: 180, label: "陪着你" },
  "running-right": { row: 1, frames: 8, frameMs: 120, label: "向右散步" },
  "running-left": { row: 2, frames: 8, frameMs: 120, label: "向左散步" },
  waving: { row: 3, frames: 4, frameMs: 140, label: "你好呀", transientMs: 2600 },
  jumping: { row: 4, frames: 5, frameMs: 140, label: "完成啦", transientMs: 2600 },
  failed: { row: 5, frames: 8, frameMs: 140, label: "遇到问题了", transientMs: 4200 },
  waiting: { row: 6, frames: 6, frameMs: 150, label: "等你确认" },
  running: { row: 7, frames: 6, frameMs: 120, label: "Codex 正在工作" },
  review: { row: 8, frames: 6, frameMs: 150, label: "正在检查" },
};

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Codex Pet root element is missing.");
}

app.innerHTML = `
  <section class="pet-shell" aria-live="polite">
    <div class="speech-bubble" role="status">陪着你</div>
    <div class="sprite-stage" data-tauri-drag-region>
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

let action: PetAction = "idle";
let frame = 0;
let paused = false;
let hasAtlas = false;
let lastFrameAt = performance.now();
let transientStartedAt = 0;
let lastRemoteStamp = 0;

const demoOrder: PetAction[] = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];

function setAction(next: PetAction, remoteStamp = Date.now()): void {
  if (!(next in animations)) return;
  if (next !== action) {
    action = next;
    frame = 0;
    transientStartedAt = performance.now();
  }
  lastRemoteStamp = Math.max(lastRemoteStamp, remoteStamp);
  bubble.textContent = animations[action].label;
  shell.dataset.state = action;
  renderFrame();
}

function renderFrame(): void {
  if (!hasAtlas) return;
  const definition = animations[action];
  const x = -(frame % definition.frames) * CELL_WIDTH;
  const y = -definition.row * CELL_HEIGHT;
  sprite.style.backgroundPosition = `${x}px ${y}px`;
}

function tick(now: number): void {
  const definition = animations[action];
  if (!paused && now - lastFrameAt >= definition.frameMs) {
    frame = (frame + 1) % definition.frames;
    lastFrameAt = now;
    renderFrame();
  }

  if (
    definition.transientMs &&
    transientStartedAt > 0 &&
    now - transientStartedAt > definition.transientMs
  ) {
    setAction("idle");
    transientStartedAt = 0;
  }

  requestAnimationFrame(tick);
}

async function detectAtlas(): Promise<void> {
  try {
    const response = await fetch(ATLAS_URL, { method: "HEAD", cache: "no-store" });
    hasAtlas = response.ok;
  } catch {
    hasAtlas = false;
  }

  sprite.hidden = !hasAtlas;
  fallbackPet.hidden = hasAtlas;
  if (hasAtlas) {
    sprite.style.backgroundImage = `url("${ATLAS_URL}")`;
    sprite.style.backgroundSize = `${ATLAS_WIDTH}px ${ATLAS_HEIGHT}px`;
    renderFrame();
  } else {
    bubble.textContent = "等待本地宠物素材";
  }
}

async function pollPetState(): Promise<void> {
  try {
    const state: PetStatePayload = await readPetState();
    if (state.updatedAt > lastRemoteStamp) {
      setAction(state.state, state.updatedAt);
    }
  } catch {
    // Web-only preview has no native state bridge.
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
      break;
    case "demo": {
      const nextIndex = (demoOrder.indexOf(action) + 1) % demoOrder.length;
      setAction(demoOrder[nextIndex]);
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

shell.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  closeMenu();
  void beginWindowDrag().catch(() => undefined);
});

window.addEventListener("pointerup", () => void endWindowDrag());
window.addEventListener("pointercancel", () => void endWindowDrag());
window.addEventListener("blur", () => void endWindowDrag());

shell.addEventListener("dblclick", () => setAction("waving"));

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

void detectAtlas();
void pollPetState();
setInterval(() => void pollPetState(), 600);
requestAnimationFrame(tick);
