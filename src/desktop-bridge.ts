export interface PetStatePayload {
  state:
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
  updatedAt: unknown;
  source: string;
  expiresAt?: unknown;
  sessionId?: unknown;
}

export interface WindowPosition {
  x: number;
  y: number;
}

export async function readPetState(): Promise<PetStatePayload> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<PetStatePayload>("read_pet_state");
}

export async function beginWindowDrag(): Promise<WindowPosition> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WindowPosition>("get_pet_window_position");
}

export async function movePetWindow(x: number, y: number): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("move_pet_window", { x, y });
}

export async function endWindowDrag(): Promise<void> {
  // Manual pointer capture ends in the webview; no native drag session remains.
}

export async function hidePet(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("hide_pet");
}

export async function quitApp(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("quit_app");
}

export async function isAutostartEnabled(): Promise<boolean> {
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}

export async function setAutostart(enabled: boolean): Promise<void> {
  const autostart = await import("@tauri-apps/plugin-autostart");
  if (enabled) await autostart.enable();
  else await autostart.disable();
}
