import { MANAGEMENT_CSP } from "../security-headers.js";
import { managementUiScript } from "./client.js";
import { managementUiCss } from "./styles.js";

export function managementUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="${MANAGEMENT_CSP}">
  <title>RLY Gateway</title>
  <style>${managementUiCss()}</style>
</head>
<body>
  <a class="skip" href="#main">Skip to main content</a>
  <p id="status" role="status" aria-live="polite">Exchanging management session…</p>
  <p id="gate-message" class="hidden"></p>
  <div id="gate"></div>
  <div id="app" class="hidden">
    <header class="app">
      <h1>RLY Gateway</h1>
      <p class="meta" id="policy-revision">policy</p>
      <button type="button" id="refresh">Refresh</button>
      <button type="button" id="logout" class="danger">Logout</button>
    </header>
    <div class="layout">
      <div class="mobile-nav">
        <label for="view-select"><span>View</span>
          <select id="view-select">
            <option value="providers">Providers</option>
            <option value="accounts">Accounts</option>
            <option value="pools">Pools</option>
            <option value="profiles">Profiles</option>
            <option value="health">Health / quota</option>
            <option value="audit">Audit</option>
            <option value="traces">Route traces</option>
          </select>
        </label>
      </div>
      <nav class="nav" aria-label="Management">
        <button type="button" data-view-btn="providers">Providers</button>
        <button type="button" data-view-btn="accounts">Accounts</button>
        <button type="button" data-view-btn="pools">Pools</button>
        <button type="button" data-view-btn="profiles">Profiles</button>
        <button type="button" data-view-btn="health">Health / quota</button>
        <button type="button" data-view-btn="audit">Audit</button>
        <button type="button" data-view-btn="traces">Route traces</button>
      </nav>
      <main id="main" tabindex="-1">
        <h2 id="view-title">Providers</h2>
        <div id="panel"></div>
      </main>
    </div>
  </div>
  <dialog id="confirm" aria-labelledby="confirm-title">
    <h2 id="confirm-title">Confirm</h2>
    <p id="confirm-text"></p>
    <div class="row">
      <button type="button" id="confirm-cancel">Cancel</button>
      <button type="button" id="confirm-ok" class="danger">Revoke</button>
    </div>
  </dialog>
  <script>${managementUiScript()}</script>
</body>
</html>`;
}
