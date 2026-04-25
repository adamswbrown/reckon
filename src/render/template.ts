/**
 * HTML shell — embedded design system, fonts, and the on-scroll reveal JS.
 *
 * Produces a SINGLE self-contained file. No external assets, no CDN fetches.
 *
 * Design system (per prompt):
 *   - Background: near-black "paper"
 *   - Accents: "bone" (warm off-white) + "tungsten amber" (burnished metal)
 *   - Display: Fraunces (serif)
 *   - Body:    IBM Plex Sans
 *   - Mono:    JetBrains Mono
 *
 * Font note: until woff2 binaries are embedded into the bundle, fonts fall
 * back through a system-font stack that approximates each face. The Electron
 * main process should later inline base64 woff2 here. The CSS variable layer
 * makes that swap a one-line change.
 */

import type { Audience } from "./html";
import { esc } from "./escape";

export interface ShellOptions {
  customerName: string;
  periodLabel: string;
  audience: Audience;
  /** Inserted between <body> open and validation appendix. */
  body: string;
}

export function renderShell(opts: ShellOptions): string {
  const audClass = `aud-${opts.audience}`;
  const title = `${opts.customerName} — Azure FinOps Health Check (${opts.periodLabel})`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body class="${audClass}">
${opts.body}
<script>${REVEAL_JS}</script>
</body>
</html>
`;
}

/* ---------------------------------------------------------------------- */
/* Design system — CSS                                                    */
/* ---------------------------------------------------------------------- */

const BASE_CSS = `
:root {
  /* Paper / surfaces — near-black with a warm undertone */
  --paper: #0e0d0c;
  --paper-2: #15130f;
  --paper-3: #1c1a16;
  --rule: #2a2620;

  /* Type — bone / tungsten amber */
  --bone: #efe8d8;
  --bone-soft: #c9c2b3;
  --bone-mute: #8a8478;
  --amber: #d6883a;
  --amber-soft: #b87324;
  --amber-glow: rgba(214, 136, 58, 0.16);

  /* Severity */
  --sev-confirmed: #7fbf6a;
  --sev-conditional: #d6883a;
  --sev-investigate: #6fa2c8;

  /* Type stack */
  --serif: "Fraunces", "Iowan Old Style", "Source Serif Pro", "Georgia", serif;
  --sans:  "IBM Plex Sans", -apple-system, "Helvetica Neue", "Segoe UI", sans-serif;
  --mono:  "JetBrains Mono", "SF Mono", "Menlo", "Consolas", monospace;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--paper);
  color: var(--bone);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

main { max-width: 900px; margin: 0 auto; padding: 64px 32px 120px; }

h1, h2, h3 { font-family: var(--serif); font-weight: 500; letter-spacing: -0.01em; margin: 0 0 0.4em; }
h1 { font-size: 48px; line-height: 1.05; }
h2 { font-size: 28px; line-height: 1.15; margin-top: 1.6em; }
h3 { font-size: 19px; line-height: 1.3;  margin-top: 1.2em; color: var(--bone); }

p  { margin: 0 0 0.9em; color: var(--bone-soft); }
strong { color: var(--bone); font-weight: 500; }
em { color: var(--bone-mute); font-style: italic; }

a { color: var(--amber); text-decoration: none; border-bottom: 1px solid rgba(214,136,58,0.3); }
a:hover { color: var(--bone); border-bottom-color: var(--bone); }

.mono, code { font-family: var(--mono); font-feature-settings: "tnum" 1, "ss01" 1; }
code { background: var(--paper-2); padding: 1px 6px; border-radius: 3px; font-size: 13px; color: var(--bone); }

/* Framework / approach section */
.principles-list {
  list-style: none;
  margin: 24px 0 12px;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px 24px;
}
.principles-list li {
  font-size: 14px;
  color: var(--bone-soft);
  padding: 6px 0;
  border-bottom: 1px dashed var(--rule);
  line-height: 1.4;
}
.principles-list li.invoked { color: var(--bone); font-weight: 500; }
.principles-list li.invoked .num { color: var(--amber); }
.principles-list .num {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--bone-mute);
  letter-spacing: 0.5px;
  margin-right: 6px;
  font-weight: 600;
}
.principles-foot {
  font-size: 13px;
  color: var(--bone-mute);
  margin-top: 16px;
  font-style: italic;
}
.principles {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
  margin-top: 20px;
}
.principle {
  background: var(--paper-2);
  border: 1px solid var(--rule);
  border-left: 3px solid var(--amber);
  padding: 18px 20px;
  border-radius: 4px;
}
.principle header {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-bottom: 10px;
}
.principle .num {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--amber);
  letter-spacing: 1px;
  text-transform: uppercase;
  font-weight: 600;
}
.principle h3 {
  margin: 0;
  font-size: 17px;
  color: var(--bone);
  font-family: var(--serif);
  font-weight: 500;
}
.principle .quote {
  font-style: italic;
  color: var(--bone-soft);
  font-size: 14px;
  line-height: 1.55;
  margin: 0 0 10px;
}
.principle .guidance {
  font-size: 13px;
  color: var(--bone-soft);
  line-height: 1.55;
  margin: 0 0 8px;
}
.principle .provenance {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--bone-mute);
  letter-spacing: 0.5px;
  margin: 0;
}
.rule-cite {
  margin-top: 16px;
  padding: 12px 16px;
  font-size: 13px;
  color: var(--bone-soft);
  background: var(--paper-2);
  border-left: 2px solid var(--amber);
  border-radius: 0 4px 4px 0;
  font-style: italic;
}
@media (max-width: 720px) {
  .principles-list { grid-template-columns: 1fr; }
}

/* Hero */
.hero { padding-bottom: 32px; border-bottom: 1px solid var(--rule); }
.hero .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--amber); margin-bottom: 24px; }
.hero h1 { color: var(--bone); }
.hero .hero-action-title {
  font-family: var(--serif);
  font-size: 26px;
  line-height: 1.35;
  color: var(--bone-soft);
  margin-top: 20px;
  max-width: 36em;
  font-style: italic;
  letter-spacing: -0.01em;
}
.hero .meta { font-family: var(--mono); font-size: 13px; color: var(--bone-mute); margin-top: 28px; }
.hero .meta span + span::before { content: " · "; padding: 0 8px; }
.hero .headline {
  margin-top: 48px;
  padding: 32px;
  background: linear-gradient(180deg, var(--paper-2), var(--paper-3));
  border: 1px solid var(--rule);
  border-radius: 4px;
  position: relative;
}
.hero .headline::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--amber);
  border-radius: 4px 0 0 4px;
}
.hero .headline .label { font-family: var(--mono); font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--bone-mute); }
.hero .headline .number { font-family: var(--serif); font-size: 56px; line-height: 1; color: var(--bone); margin: 12px 0 6px; font-feature-settings: "lnum" 1; }
.hero .headline .qual { font-size: 14px; color: var(--bone-soft); }

/* Ladder */
.ladder { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 24px; }
.ladder .rung {
  display: grid; grid-template-columns: 1fr auto; align-items: baseline;
  padding: 14px 18px; border: 1px solid var(--rule); border-radius: 3px; background: var(--paper-2);
}
.ladder .rung .label { font-family: var(--mono); font-size: 12px; letter-spacing: 0.1em; color: var(--bone-mute); text-transform: uppercase; }
.ladder .rung .value { font-family: var(--mono); font-size: 18px; color: var(--bone); }
.ladder .rung.confirmed   { border-left: 3px solid var(--sev-confirmed); }
.ladder .rung.conditional { border-left: 3px solid var(--sev-conditional); }
.ladder .rung.investigate { border-left: 3px solid var(--sev-investigate); opacity: 0.7; }

/* Section header */
.section { margin-top: 72px; }
.section > .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--amber); margin-bottom: 8px; }

/* Finding card */
.finding {
  position: relative;
  padding: 24px 24px 20px;
  margin: 16px 0;
  background: var(--paper-2);
  border: 1px solid var(--rule);
  border-radius: 4px;
  opacity: 0; transform: translateY(8px);
  transition: opacity 0.45s ease, transform 0.45s ease;
}
.finding.is-visible { opacity: 1; transform: translateY(0); }
.finding::before {
  content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; border-radius: 4px 0 0 4px;
}
.finding.sev-confirmed::before   { background: var(--sev-confirmed); }
.finding.sev-conditional::before { background: var(--sev-conditional); }
.finding.sev-investigate::before { background: var(--sev-investigate); }

.finding header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.finding .title { font-family: var(--serif); font-size: 20px; line-height: 1.3; color: var(--bone); margin: 0; }
.finding .saving { font-family: var(--mono); font-size: 16px; color: var(--bone); white-space: nowrap; }
.finding .saving.range { color: var(--amber); }

.pill { display: inline-block; font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; padding: 3px 8px; border-radius: 999px; vertical-align: middle; }
.pill.sev-confirmed   { background: rgba(127,191,106,0.12); color: var(--sev-confirmed); }
.pill.sev-conditional { background: rgba(214,136,58,0.12);  color: var(--sev-conditional); }
.pill.sev-investigate { background: rgba(111,162,200,0.12); color: var(--sev-investigate); }
.pill.frame { background: rgba(239,232,216,0.06); color: var(--bone-mute); margin-left: 8px; }

.finding .body { color: var(--bone-soft); }
.finding .body p { margin: 0 0 0.7em; }

.discovery { margin-top: 14px; padding: 14px 16px; background: var(--paper-3); border-radius: 3px; border-left: 2px solid var(--amber); }
.discovery .label { font-family: var(--mono); font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--amber); margin-bottom: 6px; }
.discovery ul { margin: 0; padding-left: 18px; color: var(--bone); }
.discovery li { margin: 3px 0; }

.evidence { margin-top: 14px; }
.evidence summary { cursor: pointer; font-family: var(--mono); font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--bone-mute); }
.evidence summary:hover { color: var(--bone); }
.evidence table { width: 100%; border-collapse: collapse; margin-top: 10px; font-family: var(--mono); font-size: 12px; }
.evidence th, .evidence td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--rule); color: var(--bone-soft); }
.evidence th { color: var(--bone-mute); font-weight: 400; text-transform: uppercase; letter-spacing: 0.1em; font-size: 10px; }
.evidence td.num { text-align: right; color: var(--bone); }

.frame-callout {
  margin-top: 14px;
  padding: 12px 16px;
  background: var(--paper-3);
  border-left: 2px solid var(--bone-mute);
  font-family: var(--serif);
  font-style: italic;
  color: var(--bone-soft);
  font-size: 14px;
  line-height: 1.5;
}
.frame-callout .src { display: block; margin-top: 6px; font-style: normal; font-family: var(--mono); font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--bone-mute); }

/* Limits section */
.limits { margin-top: 72px; padding: 28px 28px 22px; border: 1px dashed var(--rule); border-radius: 4px; }
.limits h2 { margin-top: 0; }
.limits ul { margin: 0; padding-left: 20px; color: var(--bone-soft); }
.limits li { margin: 4px 0; }

/* Validation appendix */
.appendix { margin-top: 72px; padding-top: 24px; border-top: 1px solid var(--rule); }
.appendix details summary { cursor: pointer; font-family: var(--mono); font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--amber); }
.appendix .issues { margin-top: 12px; font-family: var(--mono); font-size: 12px; color: var(--bone-soft); }
.appendix .issues .row { padding: 6px 0; border-bottom: 1px solid var(--rule); }
.appendix .issues .row.error   { color: #c98373; }
.appendix .issues .row.warning { color: var(--amber); }
.appendix .issues .row.info    { color: var(--bone-mute); }
.appendix .issues .code { display: inline-block; min-width: 220px; }

/* Audience-specific visibility */
body.aud-customer .evidence { display: none; }
body.aud-customer .frame-callout { display: none; }
body.aud-customer .pill.frame { display: none; }
body.aud-customer .for-consultant { display: none; }
body.aud-customer .for-informational { display: none; }

body.aud-consultant .for-customer { display: none; }
body.aud-consultant .for-informational { display: none; }

body.aud-informational .for-customer { display: none; }
body.aud-informational .for-consultant { display: none; }
body.aud-informational .appendix details { open: true; }

footer { margin-top: 96px; color: var(--bone-mute); font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-align: center; }
footer .gen { color: var(--bone-mute); }
`;

/* ---------------------------------------------------------------------- */
/* Reveal-on-scroll JS                                                    */
/* ---------------------------------------------------------------------- */

const REVEAL_JS = `
(function(){
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.finding').forEach(function(el){ el.classList.add('is-visible'); });
    return;
  }
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting) {
        e.target.classList.add('is-visible');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.08 });
  document.querySelectorAll('.finding').forEach(function(el){ io.observe(el); });
})();
`;
