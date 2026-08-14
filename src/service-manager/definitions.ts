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
  const programArguments = [input.executable, input.entrypoint, "gateway", "start", "--config", input.configPath]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
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

/** Quotes a single systemd ExecStart argument only when it needs quoting. */
function systemdQuote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function buildSystemdUserUnit(input: ServiceDefinitionInput): string {
  const execStart = [input.executable, input.entrypoint, "gateway", "start", "--config", input.configPath]
    .map(systemdQuote)
    .join(" ");
  return `[Unit]
Description=RLY Gateway per-user runtime service
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}
