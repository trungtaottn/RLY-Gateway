#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";

const slackWebhookKey = ["SLACK", "WEBHOOK", "URL"].join("_");
const slackSectionLimit = 3000;

function value(name, fallback = "not available") {
  return process.env[name]?.trim() || fallback;
}

export function splitSlackText(text, limit = slackSectionLimit) {
  const chunks = [];
  for (let index = 0; index < text.length; index += limit) chunks.push(text.slice(index, index + limit));
  return chunks.length > 0 ? chunks : ["Release metadata was unavailable."];
}

export function releaseNotificationPayload({ status, lane, version, branch, sha, releaseUrl, notes, alignmentStatus }) {
  const fields = [
    "*Product:* RLY Gateway", `*Lane:* ${lane}`, `*Status:* ${status}`, `*Version:* ${version}`,
    `*Branch:* ${branch}`, `*Commit SHA:* ${sha}`, `*GitHub Release:* ${releaseUrl}`,
  ];
  if (lane === "stable") fields.push(`*Alignment status:* ${alignmentStatus}`);
  fields.push("*Summary:*");
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: fields.join("\n") } },
    ...splitSlackText(notes).map((text) => ({ type: "section", text: { type: "mrkdwn", text } })),
  ];
  return { text: `RLY Gateway ${lane} release ${status}`, blocks };
}

async function main() {
  const webhook = process.env[slackWebhookKey];
  if (!webhook) {
    process.stderr.write("Slack notification skipped: SLACK_WEBHOOK_URL is not configured.\n");
    return;
  }
  const lane = value("RELEASE_LANE");
  const response = await globalThis.fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(releaseNotificationPayload({
      status: value("RELEASE_STATUS", "failure"), lane, version: value("RELEASE_VERSION"), branch: value("RELEASE_BRANCH"),
      sha: value("RELEASE_SHA"), releaseUrl: value("RELEASE_URL"), notes: value("RELEASE_NOTES", "Release metadata was unavailable."),
      alignmentStatus: value("ALIGNMENT_STATUS"),
    })),
  });
  if (!response.ok) throw new Error(`Slack notification failed (${response.status})`);
  process.stdout.write(`Slack ${lane} notification delivered\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
