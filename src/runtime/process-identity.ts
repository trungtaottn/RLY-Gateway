import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessIdentity } from "./ownership-record.js";

const execFileAsync = promisify(execFile);

/** Reads a PID plus its OS start time; PID existence alone is never ownership evidence. */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    const value = stdout.trim();
    if (!value) return undefined;
    const startedAt = new Date(value);
    if (Number.isNaN(startedAt.valueOf())) return undefined;
    return { pid, processStartedAt: startedAt.toISOString() };
  } catch {
    return undefined;
  }
}
