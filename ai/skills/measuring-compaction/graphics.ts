import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CompactionReport } from "./report.ts";

const WIDTH = 1600;
const HEIGHT = 900;
const fontsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fonts");

function page(body: string, defs: string): string {
  const fontUrl = (file: string) => pathToFileURL(path.join(fontsDirectory, file)).href;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@font-face{font-family:CM;src:url(${fontUrl("CommitMono-400-Regular.otf")});font-weight:400}
@font-face{font-family:CM;src:url(${fontUrl("CommitMono-700-Regular.otf")});font-weight:700}
html,body{margin:0;background:#002438}svg{display:block}
text{font-family:CM;fill:#7fa3b5;font-size:24px}.grid{stroke:#12455e;stroke-width:1}
.lab{font-size:26px;font-weight:700}.big{font-size:140px;font-weight:700;fill:#fff;letter-spacing:-4px}.mid{font-size:32px;fill:#fff;font-weight:700}
</style></head><body><svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<defs><linearGradient id="stroke" x1="0" x2="1"><stop offset="0" stop-color="#ff0005"/><stop offset="1" stop-color="#ff0092"/></linearGradient>${defs}</defs>
${body}
</svg></body></html>`;
}

const FADING_FILL = `<linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ff0092" stop-opacity=".32"/><stop offset="1" stop-color="#ff0092" stop-opacity=".04"/></linearGradient>`;

function shareBar(top: number, share: number, label: string, valueText: string): string {
  const left = 150;
  const right = 1450;
  const split = left + share * (right - left);
  const isLabelInside = share >= 0.5;
  return `<text x="${left}" y="${top - 22}" class="lab">${label}</text>
<rect x="${left}" y="${top}" width="${right - left}" height="80" rx="6" fill="#12455e"/>
<rect x="${left}" y="${top}" width="${Math.max(split - left, 12).toFixed(1)}" height="80" rx="6" fill="url(#stroke)"/>
<text x="${(isLabelInside ? split - 22 : split + 22).toFixed(1)}" y="${top + 54}" text-anchor="${isLabelInside ? "end" : "start"}" class="mid">${valueText}</text>`;
}

function rereadCard(report: CompactionReport): string {
  const points = report.reread.series;
  const startMs = Date.parse(points[0]![0].slice(0, 10));
  const endMs = Date.parse(points.at(-1)![0]);
  const [, finalActual, finalWithoutCap] = points.at(-1)!;
  const left = 170;
  const right = 1510;
  const top = 90;
  const bottom = 810;
  const gridStepTokens = Math.ceil(finalWithoutCap / 4 / 1e9) * 1e9;
  const yMaxTokens = gridStepTokens * 4;
  const xFor = (timestamp: string) => left + ((Date.parse(timestamp) - startMs) / (endMs - startMs)) * (right - left);
  const yFor = (tokens: number) => bottom - (tokens / yMaxTokens) * (bottom - top);
  const lineThrough = (pick: (point: [string, number, number]) => number, ordered = points) =>
    ordered.map((point) => `${xFor(point[0]).toFixed(1)},${yFor(pick(point)).toFixed(1)}`).join(" L");
  const actualLine = lineThrough((point) => point[1]);
  const withoutCapLine = lineThrough((point) => point[2]);
  const gap = `M${withoutCapLine} L${lineThrough((point) => point[1], [...points].reverse())} Z`;
  const area = `M${actualLine} L${right},${bottom} L${left},${bottom} Z`;
  const gridLines = [0, 1, 2, 3, 4].map((step) => {
    const gridLineY = yFor(step * gridStepTokens);
    return `<line x1="${left}" x2="${right}" y1="${gridLineY.toFixed(1)}" y2="${gridLineY.toFixed(1)}" class="grid"/><text x="${left - 24}" y="${(gridLineY + 8).toFixed(1)}" text-anchor="end">${(step * gridStepTokens) / 1e9}B</text>`;
  });
  const mondayLabels: string[] = [];
  for (let dayMs = startMs; dayMs <= endMs; dayMs += 86_400_000) {
    const day = new Date(dayMs);
    if (day.getUTCDay() !== 1) continue;
    const label = day.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    mondayLabels.push(`<text x="${xFor(day.toISOString()).toFixed(1)}" y="${bottom + 44}" text-anchor="middle">${label}</text>`);
  }
  const weeks = Math.round((endMs - startMs) / (7 * 86_400_000));
  return page(
    `${gridLines.join("")}${mondayLabels.join("")}
<path d="${gap}" fill="url(#hatch)"/>
<path d="${area}" fill="url(#fill)"/>
<path d="M${withoutCapLine}" fill="none" stroke="#7fa3b5" stroke-width="3" stroke-linejoin="round"/>
<path d="M${actualLine}" fill="none" stroke="url(#stroke)" stroke-width="3.5" stroke-linejoin="round"/>
<text x="${right - 10}" y="${(yFor(finalWithoutCap) - 22).toFixed(1)}" text-anchor="end" class="lab" style="fill:#7fa3b5">without the cap · ${(finalWithoutCap / 1e9).toFixed(1)}B</text>
<text x="${right - 10}" y="${(yFor(finalActual) + 160).toFixed(1)}" text-anchor="end" class="lab" style="fill:#ff5c8a">with auto-compact · ${(finalActual / 1e9).toFixed(1)}B</text>
<text x="${left + 40}" y="230" class="big">${((finalWithoutCap - finalActual) / 1e9).toFixed(1)}B</text>
<text x="${left + 40}" y="280" class="mid">tokens of context never re-read</text>
<text x="${left + 40}" y="318">${(finalWithoutCap / finalActual).toFixed(1)}x less, in ${weeks} weeks of Claude Code (hatched)</text>`,
    `${FADING_FILL}
<pattern id="hatch" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="14" height="14" fill="#7fa3b5" opacity=".06"/><line x1="0" y1="0" x2="0" y2="14" stroke="#7fa3b5" stroke-width="3" opacity=".35"/></pattern>`,
  );
}

function sessionsCard(report: CompactionReport): string {
  const { sessions, reread } = report;
  const sessionShare = sessions.compacting / sessions.total;
  const contextPercent = Math.round(sessions.compactingContextShare * 100);
  return page(
    `<text x="150" y="230" class="big">${contextPercent}%</text>
<text x="150" y="290" class="mid">of all context came from the ${(sessionShare * 100).toFixed(1)}% of sessions that compact</text>
${shareBar(450, sessionShare, `sessions · ${sessions.total.toLocaleString("en-US")}`, `${sessions.compacting} compacted`)}
${shareBar(660, sessions.compactingContextShare, `context tokens · ${(reread.actualTokens / 1e9).toFixed(1)}B`, `${contextPercent}%`)}`,
    "",
  );
}

function paybackCard(report: CompactionReport): string {
  const payback = report.payback.summaryReadFromCache;
  const costDollars = payback.medianCostDollars;
  const breakEvenCalls = payback.medianBreakEvenCalls;
  const savingPerCallDollars = costDollars / breakEvenCalls;
  const medianRunCalls = report.compactions.medianCallsUntilNext;
  const left = 170;
  const right = 1510;
  const top = 120;
  const bottom = 790;
  const maxCalls = Math.max(120, Math.ceil((medianRunCalls * 1.4) / 20) * 20);
  const savingAtEndDollars = savingPerCallDollars * maxCalls;
  const maxDollars = Math.ceil(savingAtEndDollars * 2) / 2;
  const xFor = (calls: number) => left + (calls / maxCalls) * (right - left);
  const yFor = (amount: number) => bottom - (amount / maxDollars) * (bottom - top);
  const dollarGrid = Array.from({ length: Math.floor(maxDollars) + 1 }, (_, amount) =>
    `<line x1="${left}" x2="${right}" y1="${yFor(amount).toFixed(1)}" y2="${yFor(amount).toFixed(1)}" class="grid"/><text x="${left - 24}" y="${(yFor(amount) + 8).toFixed(1)}" text-anchor="end">$${amount}</text>`);
  const callTicks = Array.from({ length: maxCalls / 20 + 1 }, (_, index) =>
    `<text x="${xFor(index * 20).toFixed(1)}" y="${bottom + 44}" text-anchor="middle">${index * 20}</text>`);
  const headlineX = (xFor(breakEvenCalls) + 30).toFixed(1);
  return page(
    `${dollarGrid.join("")}${callTicks.join("")}
<text x="${(left + right) / 2}" y="${bottom + 84}" text-anchor="middle">calls after a compaction</text>
<path d="M${xFor(breakEvenCalls).toFixed(1)},${yFor(costDollars).toFixed(1)} L${xFor(maxCalls).toFixed(1)},${yFor(savingAtEndDollars).toFixed(1)} L${xFor(maxCalls).toFixed(1)},${yFor(costDollars).toFixed(1)} Z" fill="url(#fill)"/>
<line x1="${left}" x2="${right}" y1="${yFor(costDollars).toFixed(1)}" y2="${yFor(costDollars).toFixed(1)}" stroke="#7fa3b5" stroke-width="3"/>
<text x="${(xFor(breakEvenCalls) + 14).toFixed(1)}" y="${(yFor(costDollars) + 40).toFixed(1)}" class="lab" style="fill:#7fa3b5">one compaction · $${costDollars.toFixed(2)}</text>
<line x1="${xFor(0)}" y1="${yFor(0)}" x2="${xFor(maxCalls).toFixed(1)}" y2="${yFor(savingAtEndDollars).toFixed(1)}" stroke="url(#stroke)" stroke-width="3.5"/>
<text x="${(xFor(maxCalls) - 10).toFixed(1)}" y="${(yFor(savingAtEndDollars) - 20).toFixed(1)}" text-anchor="end" class="lab" style="fill:#ff5c8a">context not re-read · ${(savingPerCallDollars * 100).toFixed(1)}¢ per call</text>
<line x1="${xFor(breakEvenCalls).toFixed(1)}" x2="${xFor(breakEvenCalls).toFixed(1)}" y1="${top}" y2="${bottom}" stroke="#7fa3b5" stroke-width="2" stroke-dasharray="8 8"/>
<line x1="${xFor(medianRunCalls).toFixed(1)}" x2="${xFor(medianRunCalls).toFixed(1)}" y1="${top + 260}" y2="${bottom}" stroke="#ff5c8a" stroke-width="2" stroke-dasharray="8 8"/>
<text x="${(xFor(medianRunCalls) + 14).toFixed(1)}" y="${top + 290}" class="lab" style="fill:#ff5c8a">median run · ${medianRunCalls} calls</text>
<text x="${headlineX}" y="250" class="big" style="font-size:130px">${breakEvenCalls.toFixed(0)} calls</text>
<text x="${headlineX}" y="296" class="mid">to pay back the cache rebuild</text>
<text x="${headlineX}" y="334">${payback.paidBack} of ${report.compactions.total} compactions paid for themselves</text>`,
    FADING_FILL,
  );
}

function delegationCard(report: CompactionReport): string {
  const { delegation, sessions } = report;
  const rows: [string, number][] = [
    ["Workflow tool calls", delegation.workflowCalls],
    ["Agent subagent calls", delegation.agentCalls],
    ["Glimmervoid child sessions", delegation.childSessionSpawns],
  ];
  const left = 150;
  const right = 1450;
  const longestCount = Math.max(1, ...rows.map(([, count]) => count));
  const bars = rows.map(([label, count], index) => {
    const top = 470 + index * 130;
    const barWidth = Math.max((count / longestCount) * (right - left), 12);
    const isLabelInside = barWidth > 900;
    return `<text x="${left}" y="${top - 16}" class="lab">${label}</text><rect x="${left}" y="${top}" width="${right - left}" height="56" rx="6" fill="#12455e"/><rect x="${left}" y="${top}" width="${barWidth.toFixed(1)}" height="56" rx="6" fill="url(#stroke)"/><text x="${(isLabelInside ? left + barWidth - 18 : left + barWidth + 18).toFixed(1)}" y="${top + 40}" text-anchor="${isLabelInside ? "end" : "start"}" class="mid">${count.toLocaleString("en-US")}</text>`;
  });
  return page(
    `<text x="${left}" y="230" class="big">${delegation.compactingSessionsThatDelegated} of ${sessions.compacting}</text>
<text x="${left}" y="290" class="mid">sessions that compacted had already delegated</text>
<text x="${left}" y="330">the parent still fills up with what comes back</text>
${bars.join("")}`,
    "",
  );
}

function idleCard(report: CompactionReport): string {
  const { compactions } = report;
  const columns = 21;
  const cellSize = 30;
  const cellGap = 6;
  const gridLeft = 150;
  const gridTop = 110;
  const cells = Array.from({ length: compactions.total }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const fill = index < compactions.precomputed ? "url(#stroke)" : "#7fa3b5";
    return `<rect x="${gridLeft + column * (cellSize + cellGap)}" y="${gridTop + row * (cellSize + cellGap)}" width="${cellSize}" height="${cellSize}" rx="4" fill="${fill}"/>`;
  });
  const textLeft = gridLeft + columns * (cellSize + cellGap) + 80;
  return page(
    `${cells.join("")}
<text x="${textLeft}" y="300" class="big">${Math.round(compactions.medianPrecomputedDurationMs)}ms</text>
<text x="${textLeft}" y="352" class="mid">${compactions.precomputed} compacted mid-work</text>
<text x="${textLeft}" y="392">summary prewritten in background</text>
<text x="${textLeft}" y="600" class="mid" style="fill:#7fa3b5">${compactions.idle} ran while I was away</text>
<text x="${textLeft}" y="640">after ~${Math.round(compactions.medianIdleMinutesBeforeIdleCompaction)} min idle, before</text>
<text x="${textLeft}" y="676">the prompt cache expired</text>
<rect x="${textLeft - 40}" y="328" width="18" height="18" rx="3" fill="url(#stroke)"/>
<rect x="${textLeft - 40}" y="576" width="18" height="18" rx="3" fill="#7fa3b5"/>`,
    "",
  );
}

export async function renderGraphics(report: CompactionReport, outDirectory: string): Promise<string[]> {
  const cards: Record<string, string> = {
    reread: rereadCard(report),
    sessions: sessionsCard(report),
    payback: paybackCard(report),
    delegation: delegationCard(report),
    idle: idleCard(report),
  };
  fs.mkdirSync(outDirectory, { recursive: true });
  const { chromium } = await import("playwright-core");
  const { launchCaptureBrowser } = await import("../../lib/headless-chrome.mjs");
  const browser = await launchCaptureBrowser(chromium);
  const pngPaths: string[] = [];
  try {
    const browserPage = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
    for (const [name, html] of Object.entries(cards)) {
      const htmlPath = path.resolve(outDirectory, `${name}.html`);
      const pngPath = path.resolve(outDirectory, `${name}.png`);
      fs.writeFileSync(htmlPath, html);
      await browserPage.goto(pathToFileURL(htmlPath).href);
      await browserPage.evaluate(() => document.fonts.ready);
      await browserPage.screenshot({ path: pngPath });
      pngPaths.push(pngPath);
    }
  } finally {
    await browser.close();
  }
  return pngPaths;
}
