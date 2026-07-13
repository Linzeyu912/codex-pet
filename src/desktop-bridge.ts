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
    | "review";
  updatedAt: number;
  source: string;
}

export async function readPetState(): Promise<PetStatePayload> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<PetStatePayload>("read_pet_state");
}

export async function beginWindowDrag(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

export async function endWindowDrag(): Promise<void> {
  // Tauri's native drag operation ends automatically on pointer release.
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
