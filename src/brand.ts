/**
 * Anyam's shared visual language.
 *
 * The values here are the executable companion to docs/brand/anyam-brand.md.
 * Keep UI surfaces on these tokens instead of copying a color or font into a
 * Worker template. The mark is the optimized, supplied transparent asset at
 * docs/brand/assets/anyam-mark-black.png.
 */

export const ANYAM_BRAND = {
  name: "Anyam",
  colors: {
    ink: "#0A0A0A",
    slate: "#6B7280",
    mist: "#F2F4F7",
    accentBlue: "#2563EB",
    white: "#FFFFFF",
  },
  typography: {
    sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  },
  clearSpace: "inner-loop-height",
} as const;

/**
 * Shared CSS tokens and primitives. A Worker can inline this string without
 * requiring a separate asset host, which keeps owner and control-room pages
 * usable in a customer-owned Realm.
 */
export const ANYAM_BRAND_CSS = `:root {
  color-scheme: light dark;
  --anyam-color-ink: ${ANYAM_BRAND.colors.ink};
  --anyam-color-slate: ${ANYAM_BRAND.colors.slate};
  --anyam-color-mist: ${ANYAM_BRAND.colors.mist};
  --anyam-color-accent-blue: ${ANYAM_BRAND.colors.accentBlue};
  --anyam-color-white: ${ANYAM_BRAND.colors.white};
  --anyam-font-sans: ${ANYAM_BRAND.typography.sans};
  --anyam-font-mono: ${ANYAM_BRAND.typography.mono};
  --anyam-bg: var(--anyam-color-mist);
  --anyam-surface: var(--anyam-color-white);
  --anyam-text: var(--anyam-color-ink);
  --anyam-muted: var(--anyam-color-slate);
  --anyam-border: #d9dde4;
  --anyam-code-bg: #edf0f4;
  --anyam-focus: var(--anyam-color-accent-blue);
}
@media (prefers-color-scheme: dark) {
  :root {
    --anyam-bg: var(--anyam-color-ink);
    --anyam-surface: #141414;
    --anyam-text: var(--anyam-color-mist);
    --anyam-muted: #b8bec8;
    --anyam-border: #343434;
    --anyam-code-bg: #1d1d1d;
  }
  .anyam-lockup:not(.anyam-lockup-inverse) img {
    filter: invert(1);
  }
}
.anyam-dark-surface {
  --anyam-bg: var(--anyam-color-ink);
  --anyam-surface: #141414;
  --anyam-text: var(--anyam-color-mist);
  --anyam-muted: #b8bec8;
  --anyam-border: #343434;
  --anyam-code-bg: #1d1d1d;
}
.anyam-page {
  min-height: 100vh;
  margin: 0;
  padding: 2rem 1rem;
  background: var(--anyam-bg);
  color: var(--anyam-text);
  font-family: var(--anyam-font-sans);
}
.anyam-shell {
  width: min(100%, 68rem);
  margin: 0 auto;
}
.anyam-card {
  border: 1px solid var(--anyam-border);
  border-radius: 1rem;
  background: var(--anyam-surface);
  padding: 1.5rem;
}
.anyam-lockup {
  display: inline-flex;
  align-items: center;
  gap: .7rem;
  color: inherit;
  text-decoration: none;
}
.anyam-lockup img {
  display: block;
  width: 2.2rem;
  height: 2.2rem;
  object-fit: contain;
}
.anyam-lockup-inverse img {
  filter: invert(1);
}
.anyam-wordmark {
  font-size: 1.35rem;
  font-weight: 600;
  letter-spacing: -.04em;
}
.anyam-eyebrow {
  margin: 0;
  color: var(--anyam-muted);
  font-size: .75rem;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.anyam-muted {
  color: var(--anyam-muted);
}
.anyam-receipt {
  overflow-wrap: anywhere;
  color: var(--anyam-muted);
  font-family: var(--anyam-font-mono);
  font-size: .78rem;
}
.anyam-button {
  border: 0;
  border-radius: .65rem;
  background: var(--anyam-color-accent-blue);
  color: var(--anyam-color-white);
  cursor: pointer;
  font: inherit;
  font-weight: 650;
  padding: .72rem 1rem;
}
.anyam-button:hover {
  background: #1d4ed8;
}
.anyam-button:focus-visible,
.anyam-input:focus-visible,
.anyam-select:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--anyam-focus) 38%, transparent);
  outline-offset: 2px;
}
.anyam-button:disabled {
  cursor: wait;
  opacity: .58;
}
.anyam-input,
.anyam-select {
  border: 1px solid var(--anyam-border);
  border-radius: .55rem;
  background: var(--anyam-surface);
  color: var(--anyam-text);
  font: inherit;
  padding: .68rem .75rem;
}
.anyam-code {
  min-height: 2rem;
  border-radius: .65rem;
  background: var(--anyam-code-bg);
  color: var(--anyam-text);
  font-family: var(--anyam-font-mono);
  padding: 1rem;
  white-space: pre-wrap;
}
`;

/** Optimized supplied transparent mark, kept inline for customer-owned Workers. */
export const ANYAM_BRAND_MARK_DATA_URI = "data:image/png;base64,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";

export function anyamBrandStyleTag(): string {
  return `<style>${ANYAM_BRAND_CSS}</style>`;
}

export function anyamBrandLockup(variant: "light" | "inverse" = "light"): string {
  const inverseClass = variant === "inverse" ? " anyam-lockup-inverse" : "";
  return `<div class="anyam-lockup${inverseClass}" aria-label="Anyam">
  <img src="${ANYAM_BRAND_MARK_DATA_URI}" alt="" width="40" height="40">
  <span class="anyam-wordmark">Anyam</span>
</div>`;
}
