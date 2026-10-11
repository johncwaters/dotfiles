#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { escapeHtml, isNonemptyString, writeFileRefusingSymlink } from './render.mjs'

const maxSharePageBytes = 16_000_000
const maxCaptionCount = 8

function validateCaptions(captions) {
    if (!Array.isArray(captions) || captions.length === 0 || captions.length > maxCaptionCount) throw new Error(`captions must be an array of 1 to ${maxCaptionCount} entries`)
    for (const [captionIndex, caption] of captions.entries()) {
        if (!isNonemptyString(caption?.label) || !isNonemptyString(caption?.text)) throw new Error(`caption ${captionIndex + 1} needs a label and text`)
    }
    return captions
}

const pageStyles = `
:root { --ground: #f6f5f2; --ink: #22201c; --ink-dim: #6a655c; --line: #d8d4cb; --font: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; --font-mono: ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ground: #121110; --ink: #e9e6df; --ink-dim: #a39e93; --line: #34312c; color-scheme: dark } }
:root[data-theme="dark"] { --ground: #121110; --ink: #e9e6df; --ink-dim: #a39e93; --line: #34312c; color-scheme: dark }
body { background: var(--ground); color: var(--ink); font-family: var(--font); font-size: 15px; line-height: 1.55; }
main { display: flex; flex-direction: column; gap: 28px; max-width: 560px; margin: 0 auto; padding-block: 28px; padding-inline: 16px; }
h1, h2 { margin: 0; font-size: 15px; font-weight: 700; text-wrap: balance; }
p { margin: 0; }
section { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
video { display: block; width: 100%; max-width: 100%; border: 1px solid var(--line); background: var(--ground); }
pre { margin: 0; padding: 12px; border: 1px solid var(--line); font-family: var(--font-mono); font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: all; }
.control-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; min-height: 1.55em; }
button { padding: 4px 12px; border: 1px solid var(--ink); border-radius: 4px; background: none; color: var(--ink); font: inherit; font-weight: 600; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
button:disabled { border-color: var(--line); color: var(--ink-dim); cursor: default; }
.status { color: var(--ink-dim); }
`

function pageScript(clipFileName) {
    return `
const clipFileName = ${JSON.stringify(clipFileName).replaceAll('<', '\\u003c')};
const clipBase64 = document.getElementById('clip-data').textContent.trim();
const saveStatusByErrorCode = { declined: 'Not saved.', rate_limited: 'A save prompt is already open.', too_large: 'The file is too large to save here.' };

document.getElementById('clip').src = 'data:video/mp4;base64,' + clipBase64;

function decodeClipBlob() {
  const binaryText = atob(clipBase64);
  const clipBytes = new Uint8Array(binaryText.length);
  for (let byteIndex = 0; byteIndex < binaryText.length; byteIndex += 1) clipBytes[byteIndex] = binaryText.charCodeAt(byteIndex);
  return new Blob([clipBytes], { type: 'video/mp4' });
}

function selectText(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

for (const copyControl of document.querySelectorAll('[data-copy-target]')) {
  copyControl.addEventListener('click', async () => {
    const textElement = document.getElementById(copyControl.dataset.copyTarget);
    const statusElement = document.getElementById(copyControl.dataset.copyTarget + '-status');
    try {
      await navigator.clipboard.writeText(textElement.textContent);
      statusElement.textContent = 'Copied.';
    } catch {
      selectText(textElement);
      statusElement.textContent = 'Selected. Copy it from the menu.';
    }
  });
}

async function wireSaveControl() {
  const saveControl = document.getElementById('save-clip');
  const saveStatus = document.getElementById('save-clip-status');
  const downloads = window.claude?.use ? await window.claude.use('downloads') : null;
  if (!downloads) {
    saveStatus.textContent = 'Saving is not available in this view.';
    return;
  }
  saveControl.disabled = false;
  saveStatus.textContent = '';
  saveControl.addEventListener('click', async () => {
    saveControl.disabled = true;
    saveStatus.textContent = 'Waiting for your confirmation.';
    try {
      await downloads.save({ filename: clipFileName, data: decodeClipBlob() });
      saveStatus.textContent = 'Saved.';
    } catch (saveError) {
      saveStatus.textContent = saveStatusByErrorCode[saveError?.code] ?? 'Could not save in this view.';
    }
    saveControl.disabled = false;
  });
}
wireSaveControl();
`
}

function renderCaption(caption, captionIndex) {
    const captionId = `caption-${captionIndex + 1}`
    return `<section><h2>${escapeHtml(caption.label)}</h2><pre id="${captionId}">${escapeHtml(caption.text)}</pre><p class="control-row"><button type="button" data-copy-target="${captionId}">Copy</button><span class="status" role="status" id="${captionId}-status"></span></p></section>`
}

export function buildSharePage({ title, clipFileName, clipBytes, captions }) {
    if (!isNonemptyString(title)) throw new Error('title must be a short name for the page')
    if (!isNonemptyString(clipFileName) || !clipFileName.endsWith('.mp4')) throw new Error('clip must be an .mp4 file')
    if (!clipBytes?.length) throw new Error('clip is empty')
    const page = [
        `<title>${escapeHtml(title)}</title>`,
        `<style>${pageStyles}</style>`,
        '<main>',
        `<h1>${escapeHtml(title)}</h1>`,
        '<section><video id="clip" controls muted loop playsinline preload="auto"></video><p class="control-row"><button type="button" id="save-clip" disabled>Save video</button><span class="status" role="status" id="save-clip-status">Checking whether this view can save files.</span></p></section>',
        ...validateCaptions(captions).map(renderCaption),
        '</main>',
        `<script type="application/octet-stream" id="clip-data">${Buffer.from(clipBytes).toString('base64')}</script>`,
        `<script>${pageScript(clipFileName)}</script>`,
        '',
    ].join('\n')
    if (Buffer.byteLength(page) > maxSharePageBytes) throw new Error(`share page is ${Buffer.byteLength(page)} bytes, over the ${maxSharePageBytes}-byte Artifact limit; shorten or re-encode the clip`)
    return page
}

function parseSharePageArguments(argumentList) {
    const usage = 'usage: node share-page.mjs --clip <file.mp4> --captions <file.json> --title <name> --out <file.html>'
    let parsedArguments
    try {
        parsedArguments = parseArgs({ args: argumentList, strict: true, allowPositionals: false, options: { clip: { type: 'string' }, captions: { type: 'string' }, title: { type: 'string' }, out: { type: 'string' } } })
    } catch {
        throw new Error(usage)
    }
    const flags = parsedArguments.values
    if (![flags.clip, flags.captions, flags.title, flags.out].every(isNonemptyString) || !flags.out.endsWith('.html')) throw new Error(usage)
    return flags
}

function main() {
    const flags = parseSharePageArguments(process.argv.slice(2))
    const page = buildSharePage({
        title: flags.title,
        clipFileName: basename(flags.clip),
        clipBytes: readFileSync(flags.clip),
        captions: JSON.parse(readFileSync(flags.captions, 'utf8')),
    })
    const outputPath = resolve(flags.out)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileRefusingSymlink(outputPath, page)
    console.log(`wrote ${outputPath}: ${Buffer.byteLength(page)} bytes`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        main()
    } catch (error) {
        console.error(error.message)
        process.exitCode = 1
    }
}
