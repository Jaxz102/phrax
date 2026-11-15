import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { config } from "./config.ts";

/** Everything Phrax remembers about one Slack thread. */
export interface ThreadState {
  channel: string;
  threadTs: string;
  /** Agent SDK session to resume on the next message. */
  sessionId?: string;
  /** Repositories cloned into this thread's workspace, keyed by owner/repo. */
  repositories?: Record<string, ClonedRepository>;
}

export interface ClonedRepository {
  /** Subdirectory of the workspace that holds the clone. */
  directory: string;
  baseBranch: string;
}

export interface ThreadPaths {
  root: string;
  /** The agent's working directory; each repository is cloned into a subdirectory. */
  workspace: string;
  /** Host-only directory where clones are prepared before moving into the workspace. */
  staging: string;
  tmp: string;
  cache: string;
}

const statePath = join(config.dataDir, "state.json");
const threads = new Map<string, ThreadState>();
let writeChain = Promise.resolve();

export function threadKey(teamId: string, channel: string, threadTs: string) {
  return `${teamId}:${channel}:${threadTs}`;
}

export function threadPaths(key: string): ThreadPaths {
  const id = createHash("sha256").update(key).digest("hex").slice(0, 24);
  const root = join(config.dataDir, "threads", id);
  return {
    root,
    workspace: join(root, "workspace"),
    staging: join(root, "staging"),
    tmp: join(root, "tmp"),
    cache: join(root, "cache"),
  };
}

export async function loadThreads() {
  try {
    const saved = JSON.parse(await readFile(statePath, "utf8")) as Record<string, ThreadState>;
    for (const [key, state] of Object.entries(saved)) threads.set(key, state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function getThread(key: string) {
  return threads.get(key);
}

export function saveThread(key: string, state: ThreadState) {
  threads.set(key, state);
  const snapshot = JSON.stringify(Object.fromEntries(threads), null, 2);
  writeChain = writeChain.then(async () => {
    await mkdir(config.dataDir, { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${snapshot}\n`, "utf8");
    await rename(temporary, statePath);
  });
  return writeChain;
}
