import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const lintSlopScript = new URL("../scripts/lint-slop.mjs", import.meta.url).pathname;

function lintSlopFile(fileName, contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lint-slop-"));
  fs.writeFileSync(path.join(directory, fileName), contents);
  const run = spawnSync(process.execPath, [lintSlopScript, directory], { encoding: "utf8" });
  fs.rmSync(directory, { recursive: true, force: true });
  const rules = run.stdout.split("\n").map((line) => line.match(/:\d+: ([a-z-]+): /)?.[1]).filter(Boolean);
  return { exitCode: run.status, stdout: run.stdout, rules };
}

test("each taste-neutral tell flags on its own line and a clean screen with uppercase tracked labels passes", () => {
  const sloppyScreen = [
    '<button class="transition-all">Save</button>',
    '<div class="card hover:scale-105">Card</div>',
    '<span class="animate-pulse">Live</span>',
    '<span class="animate-bounce">Scroll</span>',
    '<h1 class="bg-clip-text text-transparent bg-gradient-to-r">Title</h1>',
    '<h2 class="font-black">Heading</h2>',
    "<p>Welcome back! \u{1F44B}</p>",
    '<div class="shadow-[0_0_20px_rgba(139,92,246,0.5)]">Glow</div>',
    '<div class="mt-[13px]">Nudged</div>',
    ".pill { box-shadow: 0 0 24px #8b5cf6; }",
    ".cue { animation: bounce 1s infinite; }",
    '<div style="animation: 1s infinite bounce">Cue</div>',
    '<div class="animate-[bounce_1s_infinite]">Cue</div>',
  ].join("\n");
  assert.deepEqual(lintSlopFile("screen.html", sloppyScreen).rules, ["transition-all", "hover-scale", "looping-pulse", "looping-pulse", "gradient-text", "heavy-weight", "emoji", "colored-glow", "off-grid-px", "colored-glow", "looping-pulse", "looping-pulse", "looping-pulse"]);

  const prettierFormattedStylesheet = [".card:hover {", "  transform: scale(1.05);", "}", ".pill {", "  box-shadow:", "    0 0 24px #8b5cf6;", "}", ".live {", "  animation: pulse 2s;", "  animation-iteration-count: infinite;", "}"].join("\n");
  assert.deepEqual(lintSlopFile("screen.css", prettierFormattedStylesheet).rules, ["hover-scale", "colored-glow", "looping-pulse"]);
  assert.deepEqual(lintSlopFile("page.php", '<button class="transition-all">Go</button>').rules, ["transition-all"]);

  const nudgedIcons = [
    '<svg class="mt-0.5 size-4" viewBox="0 0 16 16"></svg>',
    '<CheckIcon className="-translate-y-px" />',
    '<span class="icon mt-[3px]"></span>',
    '<i class="icon relative top-px"></i>',
    '<svg style="margin-top: 2px"></svg>',
    "<AlertIcon",
    '  className="mt-1 size-5"',
    "/>",
    ".row .icon { margin-top: 2px; }",
    "svg.chevron {",
    "  transform: translateY(1.5px);",
    "}",
    '<CheckIcon onClick={() => go()} className="mt-0.5 size-4" />',
    "<CheckIcon className=\"size-4\" style={{ marginTop: 2 }} />",
    '<svg style={{ position: "relative", top: "1px" }} />',
    '<svg class="relative top-px" aria-label="fixed"></svg>',
    '<svg class="relative top-px md:absolute"></svg>',
    '<svg class="absolute top-px mt-0.5"></svg>',
    ".icon { position: absolute; top: 1px; margin-top: 2px; }",
  ].join("\n");
  assert.deepEqual(lintSlopFile("icons.tsx", nudgedIcons).rules, ["icon-nudge", "icon-nudge", "off-grid-px", ...Array(13).fill("icon-nudge")]);

  const cleanScreen = [
    '<button class="flex items-center gap-2"><svg class="size-4"></svg>Save</button>',
    '<label class="relative"><SearchIcon className="absolute top-3 left-3" /><input /></label>',
    '<p class="mt-1">Body</p>',
    ".row { display: flex; align-items: start; } .row .icon { margin-block: calc((1lh - 1.25em) / 2); }",
    ".search-icon { position: absolute; top: 12px; }",
    '<SearchIcon className="size-4" />',
    '<p className={cn("mt-1 text-sm", muted && "opacity-60")}>Body</p>',
    '<button class="icon-button mt-1">Save</button>',
    '<div class="mt-1" data-icon="check">x</div>',
    ".icons { display: grid; margin-top: 4px; }",
    ".list svg { margin-top: 0.25rem; /* mt-1 */ }",
    '<h2 class="uppercase tracking-widest text-xs">Stack</h2>',
    '<button class="transition-colors hover:bg-neutral-800 mt-[12px] font-medium">Save</button>',
    ".card { box-shadow: 0 0 12px rgba(0, 0, 0, 0.4); border-top: 1px solid #333; }",
    "<span>● ok · ▶ photos</span>",
  ].join("\n");
  const cleanRun = lintSlopFile("screen.html", cleanScreen);
  assert.equal(cleanRun.exitCode, 0, cleanRun.stdout);
});
