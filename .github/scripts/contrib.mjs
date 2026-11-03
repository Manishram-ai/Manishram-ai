// Draws my GitHub contribution graph in ASCII for the profile README: the same grid of days
// as the real one, each day a shade block (░ ▒ ▓ █) that fills up on busier days, in
// GitHub's greens, with a cursor blinking where tomorrow goes. The four shades split my
// active days into four equal quarters by how much I did, and the line under the grid gives
// the busiest stretches. GitHub Actions runs it every three hours
// (.github/workflows/contrib.yml), so it keeps up with the real graph. It needs no packages.
// It reads the calendar visitors see on my profile, which counts private contributions; the
// GraphQL API with the job's own token leaves those out, so that is only the fallback.
//   node .github/scripts/contrib.mjs                    fetch the calendar and draw it
//   node .github/scripts/contrib.mjs calendar.html      draw a saved copy of that page
//   node .github/scripts/contrib.mjs calendar.json      draw a saved GraphQL answer
import { readFileSync, writeFileSync } from "node:fs";

const LOGIN = process.env.GITHUB_REPOSITORY_OWNER || "Manishram-ai";
const OUT = new URL("../../assets/", import.meta.url);
const PAGE = `https://github.com/users/${LOGIN}/contributions`;
const QUERY = "query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date weekday contributionCount}} months{name totalWeeks}}}}}";

const MONO = `ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace`;
// a shade character has less ink than GitHub's solid square, so each level takes the next
// green up
const THEMES = {
  dark: { card: "#0d1117", edge: "#ffffff17", ink: "#f0f6fc", dim: "#8b949e", cursor: "#ff7b5c", total: "#56d364", glow: 0.45, levels: ["#3d444d", "#196c2e", "#2ea043", "#56d364", "#7ee787"] },
  light: { card: "#fbf8f2", edge: "#1f232822", ink: "#1f2328", dim: "#6e7781", cursor: "#e2553a", total: "#1a7f37", glow: 0, levels: ["#c8d1da", "#4ac26b", "#2da44e", "#1a7f37", "#116329"] },
};
// which of a cell's 4 × 4 pixels each shade lights: an ordered dither, so ░ ▒ ▓ █ light a
// quarter, a half, three quarters and all of it
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const r2 = (v) => Math.round(v * 100) / 100;
const fmt = (n) => n.toLocaleString("en-US");

// the profile's calendar page, turned into the shape the GraphQL API gives: each day cell
// is "contribution-day-component-<weekday>-<week>" and its tooltip says how many. A tooltip
// stops at "100+", so those days share what the heading's total leaves after the others.
function fromPage(html) {
  const days = new Map();
  for (const [td] of html.matchAll(/<td\b[^>]*>/g)) {
    const date = td.match(/data-date="([\d-]+)"/)?.[1], id = td.match(/id="(contribution-day-component-(\d)-(\d+))"/);
    if (date && id) days.set(id[1], { date, weekday: +id[2], week: +id[3], contributionCount: null });
  }
  for (const [, id, text] of html.matchAll(/<tool-tip\b[^>]*\bfor="(contribution-day-component-\d-\d+)"[^>]*>([^<]*)/g)) {
    const day = days.get(id);
    if (day) day.contributionCount = /^\s*No contributions/.test(text) ? 0 : /^\s*100\+/.test(text) ? "100+" : Number(text.match(/^\s*([\d,]+) contributions?/)?.[1].replaceAll(",", ""));
  }
  const all = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const total = Number(html.match(/([\d,]+)\s+contributions?\s+in the last year/)?.[1].replaceAll(",", ""));
  const capped = all.filter((d) => d.contributionCount === "100+");
  const rest = total - all.reduce((s, d) => s + (d.contributionCount === "100+" ? 0 : d.contributionCount), 0);
  capped.forEach((d, i) => (d.contributionCount = Math.floor(rest / capped.length) + (i < rest % capped.length ? 1 : 0)));
  const weeks = [];
  for (const { week, ...day } of all) {
    if (!Number.isFinite(day.contributionCount)) throw new Error(`no count for ${day.date}`);
    (weeks[week] ??= { contributionDays: [] }).contributionDays.push(day);
  }
  const months = [...html.matchAll(/<td class="ContributionCalendar-label" colspan="(\d+)"[\s\S]*?<span aria-hidden="true"[^>]*>(\w+)</g)].map(([, n, name]) => ({ name, totalWeeks: +n }));
  if (!weeks.length || weeks.includes(undefined) || !months.length || !Number.isFinite(total) || rest < 100 * capped.length || (!capped.length && rest !== 0))
    throw new Error(`could not read the calendar page (${days.size} days, ${total - rest} counted, ${total} in the heading)`);
  return { totalContributions: total, weeks, months };
}

async function fromApi() {
  if (!process.env.GITHUB_TOKEN) throw new Error("set GITHUB_TOKEN to fall back on the GraphQL API");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${process.env.GITHUB_TOKEN}`, "content-type": "application/json", "user-agent": `${LOGIN}-profile` },
    body: JSON.stringify({ query: QUERY, variables: { login: LOGIN } }),
  });
  return graphql(await res.json());
}

function graphql(body) {
  const cal = body.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error(`no calendar in the answer: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  return cal;
}

async function calendar() {
  const file = process.argv[2];
  if (file) return file.endsWith(".json") ? graphql(JSON.parse(readFileSync(file, "utf8"))) : fromPage(readFileSync(file, "utf8"));
  try {
    const res = await fetch(PAGE, { headers: { "user-agent": `${LOGIN}-profile`, "x-requested-with": "XMLHttpRequest" } });
    if (!res.ok) throw new Error(`${PAGE} answered ${res.status}`);
    return fromPage(await res.text());
  } catch (err) {
    console.warn(`${err.message}; using the GraphQL API, which leaves out private contributions`);
    return fromApi();
  }
}

// the level of a day: 0 for none, then 1 to 4 by which quarter of my active days it falls in
function leveller(days) {
  const counts = days.map((d) => d.contributionCount).filter((n) => n > 0).sort((x, y) => x - y);
  const cut = [0.25, 0.5, 0.75].map((q) => counts[Math.floor(q * (counts.length - 1))] ?? 0);
  return (n) => (n === 0 ? 0 : 1 + cut.filter((c) => n > c).length);
}

function stats(cal, days) {
  const last90 = days.slice(-90).reduce((s, d) => s + d.contributionCount, 0);
  const week = Math.max(...cal.weeks.map((w) => w.contributionDays.reduce((s, d) => s + d.contributionCount, 0)));
  const day = Math.max(...days.map((d) => d.contributionCount));
  return [[last90, "in the last 90 days"], [week, "in the busiest week"], [day, "on the busiest day"]];
}

function draw(cal, th) {
  const W = 880, X0 = 78, TOP = 88;
  const p = (W - 34 - X0) / cal.weeks.length; // one column a week, one row a weekday
  const s = p - 3.6, px = s / 4;
  const H = Math.round(TOP + 7 * p + 58);
  const x = (w) => r2(X0 + w * p + 1.8), y = (d) => r2(TOP + d * p + 1.8);
  const days = cal.weeks.flatMap((w) => w.contributionDays);
  const level = leveller(days);

  // one path a shade, so the pixels of a block meet without hairline seams between them
  const shade = (k) => {
    if (k === 0) return `<rect x="${r2(s / 2 - 1)}" y="${r2(s / 2 - 1)}" width="2" height="2"/>`;
    if (k === 4) return `<rect width="${r2(s)}" height="${r2(s)}"/>`;
    let d = "";
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (BAYER[j][i] < k * 4) d += `M${r2(i * px)} ${r2(j * px)}h${r2(px)}v${r2(px)}h${r2(-px)}z`;
    return `<path d="${d}"/>`;
  };
  const defs = [0, 1, 2, 3, 4].map((k) => `<g id="s${k}">${shade(k)}</g>`).join("");

  let cells = "", glow = "";
  cal.weeks.forEach((week, w) => week.contributionDays.forEach((day) => {
    const k = level(day.contributionCount);
    const use = `<use href="#s${k}" x="${x(w)}" y="${y(day.weekday)}"/>`;
    cells += k ? use.replace("<use", `<use class="l${k}"`) : use;
    if (k === 4) glow += use;
  }));
  const legendX = W - 34 - 5 * p - 40;
  const legend = [0, 1, 2, 3, 4].map((k) => `<use href="#s${k}" class="l${k}" x="${r2(legendX + k * p + 1.8)}" y="${r2(H - 26 - s / 2)}"/>`).join("");

  const months = [];
  let col = 0;
  for (const m of cal.months) {
    if (m.totalWeeks >= 2) months.push(`<text class="lab" x="${r2(X0 + col * p)}" y="${TOP - 12}">${m.name}</text>`);
    col += m.totalWeeks;
  }
  const last = cal.weeks.at(-1).contributionDays.at(-1);
  const cursor = last.weekday < 6 ? `<rect class="cur" x="${x(cal.weeks.length - 1)}" y="${y(last.weekday + 1)}" width="${r2(s)}" height="${r2(s)}" rx="1"/>` : "";
  const total = cal.totalContributions;
  const title = `${fmt(total)} contribution${total === 1 ? "" : "s"} in the last year`;
  const best = stats(cal, days);

  const css = `.card{fill:${th.card};stroke:${th.edge}}.t{font-family:${MONO};font-size:13px;fill:${th.ink}}.tot{font-weight:700;fill:${th.total}}
.lab{font-family:${MONO};font-size:11px;fill:${th.dim}}.n{font-weight:700;fill:${th.ink}}
.l0{fill:${th.levels[0]}}${th.levels.slice(1).map((c, k) => `.l${k + 1}{fill:${c}}`).join("")}.glow{fill:${th.levels[4]};opacity:${th.glow}}
.cur{fill:${th.cursor}}@media (prefers-reduced-motion:no-preference){.cur{animation:blink 1.2s step-end infinite}}@keyframes blink{0%{opacity:1}50%{opacity:0}}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}, drawn in ASCII shade blocks: ${best.map(([n, what]) => `${fmt(n)} ${what}`).join(", ")}.">
<title>${title}</title><style>${css}</style>
<defs>${defs}<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>
<rect class="card" x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="14"/>
<text class="t" x="34" y="42"><tspan class="tot">${fmt(total)}</tspan>${title.slice(fmt(total).length)}</text>
${months.join("")}
${[["Mon", 1], ["Wed", 3], ["Fri", 5]].map(([label, d]) => `<text class="lab" x="34" y="${r2(TOP + (d + 0.5) * p + 4)}">${label}</text>`).join("")}
${th.glow ? `<g class="glow" filter="url(#b)">${glow}</g>` : ""}<g class="l0">${cells}</g>${cursor}
<text class="lab" x="34" y="${H - 22}">${best.map(([n, what]) => `<tspan class="n">${fmt(n)}</tspan> ${what}`).join(" · ")}</text>
<text class="lab" x="${r2(legendX - 36)}" y="${H - 22}">Less</text>${legend}<text class="lab" x="${r2(legendX + 5 * p + 6)}" y="${H - 22}">More</text>
</svg>
`;
}

const cal = await calendar();
for (const [name, th] of Object.entries(THEMES)) writeFileSync(new URL(`contrib-${name}.svg`, OUT), draw(cal, th));
console.log(`${cal.totalContributions} contributions, ${cal.weeks.length} weeks, last day ${cal.weeks.at(-1).contributionDays.at(-1).date}`);
