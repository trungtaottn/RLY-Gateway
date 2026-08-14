# RLY Gateway Management UI Design Guidelines

Local loopback admin+diagnostics surface. Vanilla HTML/CSS/JS. No React, no new deps, no webfonts (CSP `default-src 'none'`).

Authority for IA, states, DTO mapping: `plans/reports/260814-ui-management-ia-interaction-spec.md`.

## Register

Dense industrial cockpit for one local owner. Dark, high contrast, system fonts. Escalate density; keep color and motion quiet.

## Tokens

```css
:root {
  color-scheme: dark;
  --bg: #14181f;
  --surface: #1c222c;
  --elevated: #242c38;
  --text: #f2f4f7;
  --muted: #b7c0cc;
  --line: #5b6778;
  --accent: #3dd68c;
  --accent-ink: #0d1a14;
  --warn: #e3b341;
  --danger: #ff6b6b;
  --focus: #7eb6ff;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --radius: 4px;
  --target: 44px;
  --font-ui: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --fs-label: 0.75rem;
  --fs-body: 1rem;
  --fs-title: 1.125rem;
  --lh: 1.5;
  --ease: cubic-bezier(0.25, 1, 0.5, 1);
  --dur: 160ms;
}
```

Contrast: `--text` on `--bg`/`--surface` >= 7:1. `--muted` on `--surface` >= 4.5:1. Never raw `#000`/`#FFF`. Never color-only status.

## Layout

- 375: sticky header (title, view select, Logout). One column. No horizontal scroll.
- 1024: 240px left nav + main. Sticky header with policy revision + Logout.
- Hairline dividers, not cards-in-cards. Tabular nums for ids, versions, times.
- Touch targets >= 44px. 8px gap between controls.

## Motion

State-only 150-250ms `opacity`/`color`. Honor `prefers-reduced-motion: reduce` (instant). No page-load choreography.

## Icons

Inline 16-20px stroke SVG or text. No emoji. Every control has a visible text label.

## Persistence

Memory only for `csrfToken`/`expiresAt`. Never `localStorage`/`sessionStorage`. Cookie is HttpOnly. No-store.
