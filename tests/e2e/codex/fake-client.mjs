#!/usr/bin/env node
import process from "node:process";
const baseUrl = process.env.OPENAI_BASE_URL;
const token = process.env.OPENAI_API_KEY;
if (!baseUrl || !token) {
  process.stderr.write("missing gateway environment\n");
  process.exit(2);
}
const response = await globalThis.fetch(`${baseUrl.replace(/\/$/, "")}/v1/responses`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "primary",
    input: "redacted fixture",
    stream: false,
  }),
});
const payload = await response.json();
const text = JSON.stringify(payload);
if (!response.ok || !text.includes("synthetic response")) {
  process.stderr.write(`codex fake client failed: ${response.status}\n`);
  process.exit(1);
}
process.stdout.write("FAKE_CODEX_E2E_OK\n");
