// Generate the animated SVGs in assets/ for the README. Run: node scripts/assets.mjs
// The demo numbers come from a real Claude Code run (20,501 -> 747 chars, 0.75 s).
import { mkdirSync, writeFileSync } from "node:fs";

const C = {
  bg: "#0b0f14",
  panel: "#11161d",
  line: "#1f2733",
  text: "#e6edf3",
  dim: "#8b949e",
  faint: "#4b5563",
  s1: "#34d399", // System 1: compactio
  s2: "#f59e0b", // System 2: the LLM
  red: "#f87171",
};
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const svg = (w, h, title, css, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>
text { font-family: ${SANS}; }
.mono { font-family: ${MONO}; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
${css}
</style>
${body}
</svg>
`;

// ---------- hero ----------
function hero() {
  const W = 1280, H = 400, T = 4.8;
  const lanes = [178, 214, 250, 286];
  let blocks = "";
  // 16 token blocks. Every 4th one passes the gate; the others are dropped.
  for (let i = 0; i < 16; i++) {
    const keep = i % 4 === 1;
    const y = lanes[i % 4];
    const w = 22 + ((i * 37) % 30);
    const delay = -((i * T) / 16).toFixed(2);
    blocks += `<rect class="${keep ? "keep" : "drop"}" x="660" y="${y}" width="${w}" height="14" rx="4" style="animation-delay:${delay}s"/>\n`;
  }
  const css = `
.drop, .keep { animation: ${T}s linear infinite; }
.drop { fill: ${C.s2}; animation-name: drop; }
.keep { fill: ${C.s2}; animation-name: keep; }
@keyframes drop {
  0% { transform: translateX(0); opacity: 0; }
  8% { opacity: .9; }
  52% { transform: translateX(250px); opacity: .9; }
  62% { transform: translateX(262px) translateY(24px); opacity: 0; }
  100% { transform: translateX(262px) translateY(24px); opacity: 0; }
}
@keyframes keep {
  0% { transform: translateX(0); opacity: 0; fill: ${C.s2}; }
  8% { opacity: .9; }
  52% { transform: translateX(250px); fill: ${C.s2}; }
  56% { fill: ${C.s1}; }
  92% { transform: translateX(470px); opacity: 1; fill: ${C.s1}; }
  100% { transform: translateX(490px); opacity: 0; fill: ${C.s1}; }
}
.gate { animation: glow 2.4s ease-in-out infinite; }
@keyframes glow { 0%,100% { opacity: .55; } 50% { opacity: 1; } }`;
  const body = `
<defs>
  <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
    <path d="M32 0H0V32" fill="none" stroke="${C.line}" stroke-width="1"/>
  </pattern>
  <linearGradient id="fade" x1="0" x2="1">
    <stop offset="0" stop-color="${C.bg}" stop-opacity="1"/>
    <stop offset=".45" stop-color="${C.bg}" stop-opacity=".6"/>
    <stop offset="1" stop-color="${C.bg}" stop-opacity=".2"/>
  </linearGradient>
</defs>
<rect width="${W}" height="${H}" rx="18" fill="${C.bg}"/>
<rect width="${W}" height="${H}" rx="18" fill="url(#grid)"/>
<rect width="${W}" height="${H}" rx="18" fill="url(#fade)"/>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="18" fill="none" stroke="${C.line}"/>

<text x="72" y="150" font-size="72" font-weight="700" fill="${C.text}" letter-spacing="-2">compactio</text>
<text x="74" y="200" font-size="28" fill="${C.text}">System 1 for your coding agent.</text>
<text x="74" y="244" font-size="19" fill="${C.dim}">The LLM thinks. compactio decides. Code executes.</text>
<g class="mono" font-size="15">
  <rect x="74" y="284" width="186" height="34" rx="8" fill="${C.panel}" stroke="${C.line}"/>
  <text x="92" y="306" fill="${C.dim}" class="mono">20,501 → <tspan fill="${C.s1}">747</tspan> chars</text>
  <rect x="272" y="284" width="112" height="34" rx="8" fill="${C.panel}" stroke="${C.line}"/>
  <text x="290" y="306" fill="${C.dim}" class="mono">0.75 s</text>
  <rect x="396" y="284" width="130" height="34" rx="8" fill="${C.panel}" stroke="${C.line}"/>
  <text x="414" y="306" fill="${C.dim}" class="mono">$0.00005</text>
</g>

<text x="660" y="140" font-size="14" fill="${C.dim}" class="mono">tool output</text>
<text x="1206" y="140" font-size="14" fill="${C.dim}" class="mono" text-anchor="end">context</text>
${blocks}
<g class="gate">
  <rect x="930" y="160" width="4" height="150" rx="2" fill="${C.s1}"/>
  <rect x="918" y="160" width="28" height="150" rx="8" fill="${C.s1}" opacity=".08"/>
</g>
<text x="932" y="338" font-size="14" fill="${C.s1}" text-anchor="middle" class="mono">System 1 · Jev</text>
<rect x="1150" y="160" width="56" height="150" rx="10" fill="${C.panel}" stroke="${C.s2}" stroke-opacity=".6"/>
<text x="1178" y="240" font-size="14" fill="${C.s2}" text-anchor="middle" class="mono">LLM</text>
<text x="1178" y="338" font-size="14" fill="${C.dim}" text-anchor="middle" class="mono">System 2</text>`;
  return svg(W, H, "compactio: System 1 for your coding agent", css, body);
}

// ---------- terminal demo ----------
function demo() {
  const W = 960, H = 440, T = 16, X = 32, LH = 24;
  const items = []; // [tIn, tOut, svg]
  const line = (y, tIn, tOut, content, fill = C.text) =>
    items.push([tIn, tOut, `<text x="${X}" y="${y}" class="mono" font-size="15" fill="${fill}" xml:space="preserve">${content}</text>`]);
  let y = 84;
  line(y, 0.3, T, `<tspan fill="${C.dim}">›</tspan> Run the tests and tell me why they fail.`);
  y += LH * 1.6;
  line(y, 1.2, T, `<tspan fill="${C.s2}">●</tspan> Bash(<tspan fill="${C.dim}">npm test</tspan>)`);
  y += LH;
  const raw0 = y;
  // Stage A: the raw output the agent would read.
  for (let i = 0; i < 9; i++) line(raw0 + i * LH * 0.86, 1.6 + i * 0.16, 5.3, esc(`  PASS test/unit/module${i + 1}.spec.ts (12 ms)`), C.faint);
  line(raw0 + 9 * LH * 0.86, 3.1, 5.3, esc("  … 492 more PASS lines …"), C.faint);
  line(raw0 + 10 * LH * 0.86, 3.3, 5.3, esc("  FAIL test/db/pool.spec.ts"), C.faint);
  line(raw0 + 11.3 * LH * 0.86, 3.8, 5.3, `  <tspan fill="${C.s2}">⎿ 503 lines · 20,501 chars</tspan>`);
  // The decision.
  const dy = raw0 + 12.8 * LH * 0.86;
  items.push([4.4, 5.3, `<g><rect x="${X - 8}" y="${dy - 18}" width="${W - 2 * X + 16}" height="28" rx="6" fill="${C.s1}" opacity=".10"/>
<text x="${X}" y="${dy}" class="mono" font-size="15" fill="${C.s1}" xml:space="preserve">◆ compactio · Jev decides → <tspan font-weight="700">errors</tspan>   <tspan fill="${C.dim}">0.75 s · $0.00005</tspan></text></g>`]);
  // Stage B: what the agent actually sees.
  const b = raw0;
  line(b, 5.6, T, esc("  FAIL test/db/pool.spec.ts"), C.red);
  line(b + LH, 5.8, T, esc("    Error: connect ECONNREFUSED 127.0.0.1:5432"), C.text);
  line(b + 2 * LH, 6.0, T, esc("  Tests: 1 failed, 500 passed, 501 total"), C.text);
  line(b + 3 * LH, 6.2, T, esc(`  [compactio: kept "errors" view of 503 lines. Full output: … show f0c58b38]`), C.dim);
  line(b + 4.4 * LH, 6.9, T, `  <tspan fill="${C.s1}">⎿ agent reads 747 chars  (−96%)</tspan>`);
  line(b + 6.2 * LH, 8.2, T, `<tspan fill="${C.s2}">●</tspan> The pool test fails because Postgres is not running on 127.0.0.1:5432.`);
  line(b + 7.2 * LH, 8.5, T, `  <tspan fill="${C.dim}">Start it with docker compose up -d db, then run the tests again.</tspan>`);

  const pct = (t) => ((t / T) * 100).toFixed(2);
  let css = "";
  let body = `
<rect width="${W}" height="${H}" rx="14" fill="${C.bg}"/>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="${C.line}"/>
<rect x="1" y="1" width="${W - 2}" height="40" rx="13" fill="${C.panel}"/>
<rect x="1" y="28" width="${W - 2}" height="13" fill="${C.panel}"/>
<line x1="0" y1="41" x2="${W}" y2="41" stroke="${C.line}"/>
<circle cx="26" cy="21" r="6" fill="#ff5f57"/><circle cx="46" cy="21" r="6" fill="#febc2e"/><circle cx="66" cy="21" r="6" fill="#28c840"/>
<text x="${W / 2}" y="26" font-size="13" fill="${C.dim}" text-anchor="middle" class="mono">claude code · with compactio</text>
`;
  items.forEach(([tIn, tOut, el], i) => {
    const a = pct(tIn), b2 = Math.min(+pct(tIn) + 1.2, 99).toFixed(2);
    const c = tOut >= T ? "97" : pct(tOut), d = tOut >= T ? "99.5" : Math.min(+pct(tOut) + 1.2, 99.5).toFixed(2);
    css += `.e${i}{animation:k${i} ${T}s linear infinite}@keyframes k${i}{0%,${a}%{opacity:0}${b2}%,${c}%{opacity:1}${d}%,100%{opacity:0}}\n`;
    body += `<g class="e${i}">${el}</g>\n`;
  });
  return svg(W, H, "Terminal demo: compactio cuts a 20,501-character test log to 747 characters", css, body);
}

// ---------- how it works ----------
function how() {
  const W = 1280, H = 380, T = 8;
  const steps = [
    ["Tool", "output arrives", C.dim, "Bash · Grep · Web · MCP"],
    ["Code", "skip small output", C.dim, "and unchanged re-reads"],
    ["Code", "lossless clean", C.dim, "ANSI · repeats · blanks"],
    ["Jev", "chooses the view", C.s1, "~0.5 s · no generation"],
    ["Code", "apply + store", C.dim, "original stays on disk"],
    ["LLM", "reads only this", C.s2, "System 2"],
  ];
  const bw = 188, gap = 16, x0 = (W - (steps.length * bw + (steps.length - 1) * gap)) / 2, y0 = 84, bh = 118;
  let body = `
<rect width="${W}" height="${H}" rx="18" fill="${C.bg}"/>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="18" fill="none" stroke="${C.line}"/>
<text x="${W / 2}" y="50" font-size="20" font-weight="600" fill="${C.text}" text-anchor="middle">After every tool call, before the model sees the result</text>
`;
  steps.forEach(([k, a, color, b], i) => {
    const x = x0 + i * (bw + gap);
    const hi = color !== C.dim;
    body += `<rect x="${x}" y="${y0}" width="${bw}" height="${bh}" rx="12" fill="${C.panel}" stroke="${hi ? color : C.line}" stroke-opacity="${hi ? 0.8 : 1}"/>
<text x="${x + 18}" y="${y0 + 32}" font-size="13" fill="${hi ? color : C.dim}" class="mono">${String(i + 1).padStart(2, "0")} · ${esc(k)}</text>
<text x="${x + 18}" y="${y0 + 66}" font-size="17" font-weight="600" fill="${C.text}">${esc(a)}</text>
<text x="${x + 18}" y="${y0 + 92}" font-size="12.5" fill="${C.dim}">${esc(b)}</text>
`;
    if (i < steps.length - 1) body += `<path d="M${x + bw + 4} ${y0 + bh / 2}h${gap - 8}" stroke="${C.faint}" stroke-width="2" marker-end="url(#arr)"/>`;
  });
  // A pulse travels through the pipeline.
  const x1 = x0 + bw / 2, x2 = x0 + (steps.length - 1) * (bw + gap) + bw / 2, py = y0 + bh + 26;
  body += `<line x1="${x1}" y1="${py}" x2="${x2}" y2="${py}" stroke="${C.line}" stroke-width="2"/>
<circle class="pulse" cx="${x1}" cy="${py}" r="6" fill="${C.s1}"/>`;
  // The four views Jev chooses from, cycling.
  const views = [["full", "all of it"], ["errors", "errors + tail"], ["headtail", "start + end"], ["stub", "one line"]];
  const vw = 150, vx0 = (W - (views.length * vw + 3 * 14)) / 2, vy = 292;
  body += `<text x="${W / 2}" y="${vy - 14}" font-size="13" fill="${C.dim}" text-anchor="middle" class="mono">the four views</text>`;
  let css = `.pulse{animation:move ${T}s cubic-bezier(.5,0,.5,1) infinite}@keyframes move{0%{transform:translateX(0);opacity:0}6%{opacity:1}90%{transform:translateX(${x2 - x1}px);opacity:1}100%{transform:translateX(${x2 - x1}px);opacity:0}}\n`;
  views.forEach(([n, d], i) => {
    const x = vx0 + i * (vw + 14);
    const s = (i * 25).toFixed(0), e = (i * 25 + 25).toFixed(0);
    css += `.v${i}{animation:v${i} ${T}s steps(1) infinite}@keyframes v${i}{0%{opacity:.35}${s}%{opacity:1}${e}%{opacity:.35}}\n`;
    body += `<g class="v${i}"><rect x="${x}" y="${vy}" width="${vw}" height="52" rx="10" fill="${C.panel}" stroke="${C.s1}" stroke-opacity=".7"/>
<text x="${x + vw / 2}" y="${vy + 23}" font-size="15" font-weight="700" fill="${C.s1}" text-anchor="middle" class="mono">${n}</text>
<text x="${x + vw / 2}" y="${vy + 42}" font-size="12" fill="${C.dim}" text-anchor="middle">${d}</text></g>`;
  });
  body = `<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${C.faint}"/></marker></defs>` + body;
  return svg(W, H, "How compactio works: after each tool call, code and Jev decide how much output the LLM reads", css, body);
}

mkdirSync("assets", { recursive: true });
writeFileSync("assets/hero.svg", hero());
writeFileSync("assets/demo.svg", demo());
writeFileSync("assets/how-it-works.svg", how());
console.log("wrote assets/hero.svg, assets/demo.svg, assets/how-it-works.svg");
