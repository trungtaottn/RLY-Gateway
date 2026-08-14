export const SESSION_COOKIE_NAME = "ag_mgmt_session";

export function bootstrapPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'">
  <title>Agent Gateway</title>
</head>
<body>
  <p id="status">Exchanging management session…</p>
  <script>
    (function () {
      var status = document.getElementById("status");
      var hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
      var params = new URLSearchParams(hash);
      var token = params.get("t");
      history.replaceState(null, "", window.location.pathname + window.location.search);
      if (!token) {
        status.textContent = "Management session token is missing.";
        return;
      }
      fetch("/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        referrerPolicy: "no-referrer",
        body: JSON.stringify({ token: token })
      }).then(function (response) {
        status.textContent = response.ok
          ? "Management session established. The bootstrap token was removed from history."
          : "Management session exchange failed.";
      }).catch(function () {
        status.textContent = "Management session exchange failed.";
      });
    })();
  </script>
</body>
</html>
`;
}
