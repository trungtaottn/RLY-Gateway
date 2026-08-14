import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore, inspectSchemaColumns } from "../../src/control-plane/store.js";
import { FORBIDDEN_COLUMN_NAMES, SCHEMA_V1_SQL, assertSchemaHasNoSecretColumns } from "../../src/storage/schema-v1.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("control-plane schema", () => {
  it("declares metadata tables without secret or identity columns", async () => {
    expect(() => assertSchemaHasNoSecretColumns(SCHEMA_V1_SQL)).not.toThrow();
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-schema-"));
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    try {
      const columns = inspectSchemaColumns(store.database);
      for (const forbidden of FORBIDDEN_COLUMN_NAMES) {
        expect(columns).not.toContain(forbidden);
      }
      expect(columns).toEqual(expect.arrayContaining([
        "pseudonym",
        "credential_handle",
        "credential_generation",
        "compiled_json",
        "metadata_json",
      ]));
    } finally {
      store.close();
    }
  });
});
