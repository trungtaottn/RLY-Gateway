import type { ServiceDefinitionInput } from "./types.js";

/**
 * Pure generators for the per-user service definitions. Kept free of I/O and
 * of any environment/credential content so tests can assert exact generated
 * definitions and the definitions never leak secrets.
 */

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildLaunchAgentPlist(
  input: ServiceDefinitionInput
    & Readonly<{ label: string }>
    & Readonly<{ workingDirectory?: string }>,
): string {
  const programArguments = [
    input.executable,
    ...(input.entrypoint === undefined ? [] : [input.entrypoint]),
    "gateway",
    "start",
    "--config",
    input.configPath,
  ].map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const workingBlock = input.workingDirectory === undefined
    ? ""
    : `  <key>WorkingDirectory</key>\n  <string>${xmlEscape(input.workingDirectory)}</string>\n`;
  const logBlock = input.logPath === undefined
    ? ""
    : `  <key>StandardOutPath</key>
  <string>${xmlEscape(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.logPath)}</string>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
${workingBlock}${logBlock}</dict>
</plist>
`;
}

/**
 * Escapes a single systemd ExecStart argument: `%` is a systemd specifier that
 * must be doubled, and arguments containing whitespace or quotes are quoted.
 */
function systemdQuote(value: string): string {
  const escaped = value.replace(/%/g, "%%");
  return /[\s"']/.test(escaped) ? `"${escaped.replace(/"/g, '\\"')}"` : escaped;
}

export function buildSystemdUserUnit(
  input: ServiceDefinitionInput & Readonly<{ workingDirectory?: string; logPath?: string }>,
): string {
  const execStart = [
    input.executable,
    ...(input.entrypoint === undefined ? [] : [input.entrypoint]),
    "gateway",
    "start",
    "--config",
    input.configPath,
  ].map(systemdQuote)
    .join(" ");
  // Paths only. No Environment= and no credentials/account identity ever enter
  // the unit; stdout/stderr go to the durable RLY log directory when a log path
  // is provided, otherwise systemd's journal default applies.
  const workingBlock = input.workingDirectory === undefined
    ? ""
    : `WorkingDirectory=${systemdQuote(input.workingDirectory)}\n`;
  const logBlock = input.logPath === undefined
    ? ""
    : `StandardOutput=append:${systemdQuote(input.logPath)}\nStandardError=append:${systemdQuote(input.logPath)}\n`;
  return `[Unit]
Description=RLY Gateway per-user runtime service
After=default.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=2
${workingBlock}${logBlock}
[Install]
WantedBy=default.target
`;
}
