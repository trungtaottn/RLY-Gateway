import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/cli/diagnostics.js";

describe("CLI diagnostics", () => {
  it("prints secret-free doctor JSON without creating a control-plane store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-gateway-doctor-"));
    const configPath = join(directory, "gateway.toml");
    await writeFile(configPath, "schemaVersion = 1\n[gateway]\nport = 17871\n", "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runDoctor(configPath)).resolves.toBe(0);
      const printed = String(log.mock.calls[0]?.[0]);
      expect(printed).toContain('"ok":true');
      expect(printed).toContain('"claudeTarget"');
      expect(printed).not.toMatch(/OPENROUTER_API_KEY|accessToken|authorization|prompt/i);
    } finally {
      log.mockRestore();
    }
  });
});
