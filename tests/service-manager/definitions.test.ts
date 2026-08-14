import { describe, expect, it } from "vitest";
import { buildLaunchAgentPlist, buildSystemdUserUnit } from "../../src/service-manager/definitions.js";

const input = {
  serviceName: "rly-gateway",
  executable: "/usr/local/bin/node",
  entrypoint: "/opt/rly-gateway/dist/cli/main.js",
  configPath: "/Users/alice/work/gateway.config.toml",
};

describe("service definition builders", () => {
  it("generates a launchd plist with absolute paths and restart-on-failure", () => {
    const plist = buildLaunchAgentPlist({ ...input, label: "com.rly.gateway" });
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>com.rly.gateway</string>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/rly-gateway/dist/cli/main.js</string>");
    expect(plist).toContain("<string>gateway</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<string>--config</string>");
    expect(plist).toContain("<string>/Users/alice/work/gateway.config.toml</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).toContain("<key>ProcessType</key>");
  });

  it("escapes XML and records the log path when provided", () => {
    const plist = buildLaunchAgentPlist({
      ...input,
      label: "com.rly.gateway",
      configPath: "/Users/a&b/work/gateway<1>.toml",
      logPath: "/Users/alice/.rly/logs/service.log",
      workingDirectory: "/Users/alice/.rly",
    });
    expect(plist).toContain("/Users/a&amp;b/work/gateway&lt;1&gt;.toml");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<string>/Users/alice/.rly/logs/service.log</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("<string>/Users/alice/.rly</string>");
  });

  it("bounds crash-restart with an explicit ThrottleInterval", () => {
    const plist = buildLaunchAgentPlist({ ...input, label: "com.rly.gateway" });
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<integer>10</integer>");
    // WorkingDirectory stays absent unless the caller provides it.
    expect(plist).not.toContain("WorkingDirectory");
  });

  it("contains no credentials, environment values, or account identity", () => {
    const plist = buildLaunchAgentPlist({ ...input, label: "com.rly.gateway" });
    const unit = buildSystemdUserUnit(input);
    for (const definition of [plist, unit]) {
      expect(definition).not.toMatch(/Bearer/i);
      expect(definition).not.toMatch(/api[_-]?key/i);
      expect(definition).not.toMatch(/token/i);
      expect(definition).not.toMatch(/@/);
      expect(definition).not.toMatch(/Environment=/);
    }
  });

  it("generates a systemd user unit with restart on failure", () => {
    const unit = buildSystemdUserUnit(input);
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("ExecStart=/usr/local/bin/node /opt/rly-gateway/dist/cli/main.js gateway start --config /Users/alice/work/gateway.config.toml");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=2");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("quotes systemd ExecStart arguments that contain whitespace", () => {
    const unit = buildSystemdUserUnit({
      ...input,
      executable: "/Applications/Node JS/bin/node",
      configPath: "/Users/alice/work dir/gateway.config.toml",
    });
    expect(unit).toContain("ExecStart=\"/Applications/Node JS/bin/node\" /opt/rly-gateway/dist/cli/main.js gateway start --config \"/Users/alice/work dir/gateway.config.toml\"");
  });
});
