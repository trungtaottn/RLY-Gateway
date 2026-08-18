import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const sha = "a".repeat(40);

function runModule(module: string, expression: string): string {
  const program = `import * as subject from ${JSON.stringify(module)}; ${expression}`;
  return execFileSync("node", ["--input-type=module", "--eval", program], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

describe("stable release branch alignment", () => {
  it("allows only a validated fast-forward to the released main SHA", () => {
    const output = runModule("./scripts/align-stable-release.mjs", `console.log(JSON.stringify(subject.evaluateAlignment({ targetSha: ${JSON.stringify(sha)}, mainSha: ${JSON.stringify(sha)}, devIsAncestor: true, treesIdentical: true })))`);
    expect(output).toBe(JSON.stringify({ branch: "dev", sha, force: false }));
  });

  it("refuses a stale main, non-fast-forward dev, and divergent tree content", () => {
    for (const argumentsSource of [
      `{ targetSha: ${JSON.stringify(sha)}, mainSha: ${JSON.stringify("b".repeat(40))}, devIsAncestor: true, treesIdentical: true }`,
      `{ targetSha: ${JSON.stringify(sha)}, mainSha: ${JSON.stringify(sha)}, devIsAncestor: false, treesIdentical: true }`,
      `{ targetSha: ${JSON.stringify(sha)}, mainSha: ${JSON.stringify(sha)}, devIsAncestor: true, treesIdentical: false }`,
    ]) {
      expect(() => runModule("./scripts/align-stable-release.mjs", `subject.evaluateAlignment(${argumentsSource})`)).toThrow();
    }
  });

  it("does not create a merge commit or PR because it patches only the dev ref with force false", () => {
    const source = readFileSync(join(root, "scripts/align-stable-release.mjs"), "utf8");
    expect(source).toContain("method: \"PATCH\"");
    expect(source).toContain("git/refs/heads/${update.branch}");
    expect(source).toContain("force: update.force");
    expect(source).not.toMatch(/git\s+merge|pulls|createPullRequest/u);
  });
});

describe("Slack release notification", () => {
  it("uses semantic-release metadata for a stable success message", () => {
    const rendered = runModule("./scripts/send-release-slack-notification.mjs", `console.log(JSON.stringify(subject.releaseNotificationPayload({ status: "success", lane: "stable", version: "v1.2.3", branch: "main", sha: ${JSON.stringify(sha)}, releaseUrl: "https://github.com/trungtaottn/RLY-Gateway/releases/tag/v1.2.3", notes: "- stable change", alignmentStatus: "aligned" })))`);
    expect(rendered).toContain("RLY Gateway");
    expect(rendered).toContain("v1.2.3");
    expect(rendered).toContain("- stable change");
    expect(rendered).toContain("Alignment status");
  });

  it("splits long semantic-release notes without changing their text", () => {
    const notes = "release-note\n".repeat(900);
    const output = runModule("./scripts/send-release-slack-notification.mjs", `console.log(JSON.stringify(subject.splitSlackText(${JSON.stringify(notes)})))`);
    const chunks = JSON.parse(output) as string[];
    expect(chunks.join("")).toBe(notes);
    expect(chunks.every((chunk) => chunk.length <= 3000)).toBe(true);
  });

  it("only obtains the webhook from the environment", () => {
    const source = readFileSync(join(root, "scripts/send-release-slack-notification.mjs"), "utf8");
    expect(source).toContain("process.env[slackWebhookKey]");
    expect(source).not.toContain("hooks.slack.com");
  });
});

describe("release workflow contracts", () => {
  const beta = readFileSync(join(root, ".github/workflows/release-beta.yml"), "utf8");
  const stable = readFileSync(join(root, ".github/workflows/release-stable.yml"), "utf8");

  it("keeps full CI PR-only and prevents workflow event loops", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).not.toMatch(/^\s*push:/mu);
    expect(beta).toContain("branches: [dev]");
    expect(stable).toContain("branches: [main]");
    expect(beta).toContain("github.actor != format('{0}[bot]', vars.RLY_RELEASE_ALIGNMENT_APP_SLUG)");
    expect(stable).toContain("actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1");
    expect(stable).toContain("GITHUB_TOKEN: ${{ steps.alignment-token.outputs.token }}");
  });

  it("notifies beta and stable release outcomes without making Slack delivery transactional", () => {
    for (const workflow of [beta, stable]) {
      expect(workflow).toContain("needs.release.result == 'failure'");
      expect(workflow).toContain("needs.release.outputs.released == 'true'");
      expect(workflow).toContain("SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}");
      expect(workflow).toContain("continue-on-error: true");
    }
  });

  it("uses Slack instead of semantic-release issue comments that can fail after release publication", () => {
    const config = readFileSync(join(root, "release.config.mjs"), "utf8");
    expect(config).toContain("successComment: false");
    expect(config).toContain("failComment: false");
  });
});
