import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore, inspectSchemaColumns } from "../../src/control-plane/store.js";
import { FORBIDDEN_COLUMN_NAMES } from "../../src/storage/schema-v1.js";
import { toAccountDto, toAuditDto, toPolicyDto } from "../../src/management/dtos.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("control-plane privacy", () => {
  it("keeps SQLite metadata and audit DTOs free of secrets and raw identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-gateway-privacy-cp-"));
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    try {
      const provider = store.createProvider({ name: "codex", integrationMode: "oauth" }, "cli");
      const account = store.createAccount({
        pseudonym: "acct-fixture-001",
        providerId: provider.id,
        credentialHandle: "cred-fixture-001",
      }, "cli");
      for (const column of inspectSchemaColumns(store.database)) {
        expect(FORBIDDEN_COLUMN_NAMES).not.toContain(column);
      }
      const accountDto = toAccountDto(account);
      const policy = store.currentPolicy();
      const audit = store.listAudit()[0];
      expect(JSON.stringify(accountDto)).not.toMatch(/sk-|Bearer |accessToken|refreshToken|@/i);
      if (policy) expect(JSON.stringify(toPolicyDto(policy))).not.toMatch(/accessToken|refreshToken|authorization/i);
      if (audit) expect(JSON.stringify(toAuditDto(audit))).not.toMatch(/accessToken|refreshToken|authorization/i);
    } finally {
      store.close();
    }
  });
});
