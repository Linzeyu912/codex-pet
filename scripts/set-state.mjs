import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const aliases = {
  ready: "review",
  complete: "jumping",
  blocked: "failed",
  "needs-input": "waiting",
  working: "running",
  thinking: "running",
};
const validStates = new Set([
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
]);

const requested = (process.argv[2] || "idle").trim().toLowerCase();
const state = aliases[requested] || requested;
if (!validStates.has(state)) {
  console.error(`Unknown state: ${requested}`);
  console.error(`Available states: ${[...validStates].join(", ")}`);
  process.exitCode = 1;
} else {
  const directory = path.join(os.homedir(), ".codex-pet");
  const destination = path.join(directory, "state.json");
  const temporary = path.join(directory, "state.tmp.json");
  const payload = {
    state,
    updatedAt: Date.now(),
    source: process.env.CODEX_PET_SOURCE || "cli",
  };
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(temporary, destination);
  console.log(`Codex Pet state: ${state}`);
}
