export function managementUiCss(): string {
  return `:root{color-scheme:dark;--bg:#14181f;--surface:#1c222c;--elevated:#242c38;--text:#f2f4f7;--muted:#b7c0cc;--line:#5b6778;--accent:#3dd68c;--accent-ink:#0d1a14;--warn:#e3b341;--danger:#ff6b6b;--focus:#7eb6ff;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px;--target:44px;--font-ui:ui-sans-serif,system-ui,"Segoe UI",sans-serif;--font-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:1rem/1.5 var(--font-ui)}
a{color:var(--focus)}
.skip{position:absolute;left:-999px;top:var(--space-2);background:var(--elevated);color:var(--text);padding:var(--space-2) var(--space-3);z-index:20}
.skip:focus{left:var(--space-2)}
header.app{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;justify-content:space-between;padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--line);background:var(--surface);position:sticky;top:0;z-index:10}
h1,h2{margin:0;font-size:1.125rem;font-weight:600}
.meta,.hint{color:var(--muted);font-size:.75rem;letter-spacing:.06em}
button,select,input,textarea{font:inherit;color:var(--text);background:var(--elevated);border:1px solid var(--line);border-radius:4px;min-height:var(--target);padding:0 var(--space-3)}
textarea{min-height:88px;padding:var(--space-2) var(--space-3);width:100%}
button{cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:transparent}
button.danger{background:transparent;color:var(--danger);border-color:var(--danger)}
button:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible,.nav button:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.layout{display:block}
nav.nav{display:none;border-right:1px solid var(--line);padding:var(--space-3);min-width:240px}
nav.nav button{display:block;width:100%;text-align:left;margin-bottom:var(--space-2);background:transparent}
nav.nav button[aria-current="page"]{background:var(--elevated);border-color:var(--accent)}
.mobile-nav{padding:var(--space-3) var(--space-4)}
main{padding:var(--space-4);max-width:1100px}
#status{min-height:1.5em;margin:0;padding:var(--space-2) var(--space-4);color:var(--muted)}
#status[data-kind="alert"]{color:var(--danger)}
.toolbar,.row{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;margin-bottom:var(--space-3)}
form.editor,fieldset{border:1px solid var(--line);border-radius:4px;padding:var(--space-3);margin:0 0 var(--space-4);background:var(--surface)}
label{display:block;margin:0 0 var(--space-3);font-size:.75rem;letter-spacing:.06em;color:var(--muted)}
label>span,legend{display:block;margin-bottom:var(--space-1)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:var(--space-2);border-bottom:1px solid var(--line);vertical-align:top}
.mono{font-family:var(--font-mono);font-size:.875rem;overflow-wrap:anywhere}
.empty{padding:var(--space-5);color:var(--muted);border:1px dashed var(--line)}
.hidden{display:none}
dialog{border:1px solid var(--line);background:var(--surface);color:var(--text);max-width:28rem}
dialog::backdrop{background:#14181f99}
@media (min-width:1024px){
  .layout{display:flex;align-items:flex-start}
  nav.nav{display:block}
  .mobile-nav{display:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;
}
