import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLocalAssets } from "./build-local-assets.mjs";

const result = await buildLocalAssets({ copyToPublic: true });
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const destination = path.join(codexHome, "pets", result.petId);
await fs.mkdir(destination, { recursive: true });
await fs.copyFile(path.join(result.outputRoot, "pet.json"), path.join(destination, "pet.json"));
await fs.copyFile(
  path.join(result.outputRoot, "spritesheet.webp"),
  path.join(destination, "spritesheet.webp"),
);

console.log(`Installed local Codex pet at: ${destination}`);
