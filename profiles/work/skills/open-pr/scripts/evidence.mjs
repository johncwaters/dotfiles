#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { arch, homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const colorModes = ['light', 'dark']
const viewportWidths = { narrow: 640, wide: 1440 }
const evidenceStates = ['before', 'after']
const imageFilePattern = /\.(png|gif)$/i
const shotNamePattern = /^(before|after)-(.+)-(light|dark)-(narrow|wide)\.png$/

export function shotFileName({ state, area, mode, width }) {
    return `${state}-${area}-${mode}-${width}.png`
}

export function parseShotName(fileName) {
    const match = shotNamePattern.exec(fileName)
    if (!match) {
        return null
    }
    const [, state, area, mode, width] = match
    return { state, area, mode, width }
}

export function listAreas(fileNames) {
    const areas = fileNames.map(parseShotName).filter(Boolean).map((shot) => shot.area)
    return [...new Set(areas)]
}

function titleCase(word) {
    return word.charAt(0).toUpperCase() + word.slice(1)
}

function gridRows(area, renderCell) {
    return colorModes.flatMap((mode) =>
        Object.keys(viewportWidths).map((width) => {
            const cells = evidenceStates.map((state) => renderCell(shotFileName({ state, area, mode, width })))
            return { label: `${titleCase(mode)}, ${width} window`, cells }
        })
    )
}

export function renderContactSheet(fileNames, title) {
    const escapeHtml = (text) => text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`)
    const present = new Set(fileNames)
    const cellHtml = (fileName) =>
        present.has(fileName)
            ? `<td><img src="${escapeHtml(fileName)}" alt="${escapeHtml(fileName)}"><div>${escapeHtml(fileName)}</div></td>`
            : `<td class="missing">missing: ${escapeHtml(fileName)}</td>`
    const tables = listAreas(fileNames).map((area) => {
        const rows = gridRows(area, cellHtml).map((row) => `<tr><th>${row.label}</th>${row.cells.join('')}</tr>`)
        return `<h2>${escapeHtml(area)}</h2><table><tr><th></th><th>Before</th><th>After</th></tr>${rows.join('')}</table>`
    })
    const otherFileNames = fileNames.filter((fileName) => imageFilePattern.test(fileName) && !parseShotName(fileName))
    const otherFilesHtml = otherFileNames.length
        ? `<h2>Other files</h2><table><tr>${otherFileNames.map(cellHtml).join('')}</tr></table>`
        : ''
    const styles =
        'body{font:14px -apple-system,sans-serif;margin:24px;background:#f6f8fa}table{border-collapse:collapse;margin-bottom:32px;background:#fff}td,th{border:1px solid #d0d7de;padding:8px;vertical-align:top;text-align:left}img{width:420px;display:block}td div{font:11px ui-monospace,monospace;color:#59636e}.missing{color:#cf222e}'
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body><h1>${escapeHtml(title)}</h1>${tables.join('')}${otherFilesHtml}</body></html>`
}

export function parseUploadedMarkdown(markdown) {
    const urlsByStem = new Map()
    for (const match of markdown.matchAll(/!\[([^\]]+)\]\(([^)\s]+)\)/g)) {
        urlsByStem.set(match[1], match[2])
    }
    return urlsByStem
}

export function renderGridMarkdown(area, urlsByStem, heading = area) {
    const cellMarkdown = (fileName) => {
        const stem = fileName.replace(/\.png$/, '')
        const url = urlsByStem.get(stem)
        if (!url) {
            throw new Error(`no uploaded URL for ${stem}`)
        }
        return `<img src="${url}" width="300" alt="${stem}">`
    }
    const rows = gridRows(area, cellMarkdown).map((row) => `| ${row.label} | ${row.cells.join(' | ')} |`)
    return [`#### ${heading}`, '', '| State | Before | After |', '|---|---|---|', ...rows].join('\n')
}

export function parseFlags(argumentList) {
    const flags = {}
    for (let index = 0; index < argumentList.length; index++) {
        const argument = argumentList[index]
        if (!argument.startsWith('--')) {
            throw new Error(`unexpected argument: ${argument}`)
        }
        const next = argumentList[index + 1]
        if (next === undefined || next.startsWith('--')) {
            flags[argument.slice(2)] = true
            continue
        }
        flags[argument.slice(2)] = next
        index++
    }
    return flags
}

function requireFlags(flags, names) {
    const missing = names.filter((name) => flags[name] === undefined)
    if (missing.length) {
        throw new Error(`missing --${missing.join(', --')}`)
    }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function openPage(browser, { url, width, mode, localStorageTemplate, hydrationMs }) {
    const context = await browser.newContext({ viewport: { width, height: 860 }, colorScheme: mode })
    if (localStorageTemplate) {
        const entries = JSON.parse(localStorageTemplate.replaceAll('{mode}', mode))
        await context.addInitScript((seeded) => {
            for (const [key, value] of Object.entries(seeded)) {
                localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
            }
        }, entries)
    }
    const page = await context.newPage()
    const consoleErrors = []
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}))
    page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()))
    page.on('pageerror', (error) => consoleErrors.push(error.message.split('\n')[0]))
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 240000 })
    await sleep(hydrationMs)
    return { context, page, consoleErrors }
}

async function dismissOverlays(page, dismissSelector) {
    if (!dismissSelector) {
        return
    }
    const control = page.locator(dismissSelector).first()
    if (await control.count()) {
        await control.click().catch(() => {})
        await sleep(800)
    }
}

async function clipAround(page, selector, padding) {
    const target = page.locator(selector).first()
    await target.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await sleep(800)
    const box = await target.boundingBox()
    if (!box) {
        throw new Error(`selector not visible: ${selector}`)
    }
    const viewport = page.viewportSize()
    const x = Math.max(0, box.x - padding)
    const y = Math.max(0, box.y - padding)
    return {
        x,
        y,
        width: Math.min(viewport.width - x, box.width + padding * 2),
        height: Math.min(viewport.height - y, box.height + padding * 2),
    }
}

const googleChromeLinuxPath = '/opt/google/chrome/chrome'
const playwrightCacheDirectory = join(homedir(), '.cache', 'ms-playwright')
const headlessShellLibraryDirectory = join(homedir(), '.cache', 'evidence-chrome-libs')

const headlessShellDirectoryNameByArchitecture = {
    arm64: 'chrome-headless-shell-linux-arm64',
    x64: 'chrome-headless-shell-linux64',
}

function newestHeadlessShellPath(cacheDirectory, architecture) {
    if (!existsSync(cacheDirectory)) {
        return null
    }
    const revisions = readdirSync(cacheDirectory)
        .filter((entry) => entry.startsWith('chromium_headless_shell-'))
        .sort((left, right) => Number(right.split('-')[1]) - Number(left.split('-')[1]))
    const candidatePaths = revisions.map((revision) =>
        join(cacheDirectory, revision, headlessShellDirectoryNameByArchitecture[architecture], 'chrome-headless-shell')
    )
    return candidatePaths.find((candidatePath) => existsSync(candidatePath)) ?? null
}

function listMissingSharedLibraries(executablePath) {
    const lddOutput = execFileSync('ldd', [executablePath], {
        encoding: 'utf8',
        env: { ...process.env, LD_LIBRARY_PATH: headlessShellLibraryDirectory },
    })
    return [...lddOutput.matchAll(/^\s*(\S+) => not found$/gm)].map((match) => match[1])
}

function findNixLibrary(libraryName) {
    const matchPaths = execFileSync('find', ['/nix/store', '-maxdepth', '3', '-name', libraryName], { encoding: 'utf8' })
        .split('\n')
        .filter((matchPath) => matchPath && !matchPath.includes('-dev/'))
    return matchPaths[0] ?? null
}

function buildGbmStub(executablePath) {
    const gbmSymbols = execFileSync('nm', ['-D', '--undefined-only', executablePath], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().split(/\s+/).pop()?.split('@')[0])
        .filter((symbol) => symbol?.startsWith('gbm_'))
    const stubSourcePath = join(headlessShellLibraryDirectory, 'gbm-stub.c')
    const stubSource = [...new Set(gbmSymbols)].map((symbol) => `void *${symbol}(void){return 0;}`).join('\n')
    writeFileSync(stubSourcePath, stubSource)
    execFileSync('gcc', ['-shared', '-fPIC', '-o', join(headlessShellLibraryDirectory, 'libgbm.so.1'), stubSourcePath])
}

function prepareHeadlessShellLibraries(executablePath) {
    mkdirSync(headlessShellLibraryDirectory, { recursive: true })
    for (const libraryName of listMissingSharedLibraries(executablePath)) {
        if (libraryName === 'libgbm.so.1') {
            buildGbmStub(executablePath)
            continue
        }
        const nixLibraryPath = findNixLibrary(libraryName)
        if (!nixLibraryPath) {
            continue
        }
        const linkPath = join(headlessShellLibraryDirectory, libraryName)
        rmSync(linkPath, { force: true })
        symlinkSync(nixLibraryPath, linkPath)
    }
    const stillMissing = listMissingSharedLibraries(executablePath)
    if (stillMissing.length) {
        throw new Error(`chrome-headless-shell still lacks: ${stillMissing.join(', ')}`)
    }
}

async function launchChrome() {
    const { chromium } = await import('playwright-core')
    if (process.platform !== 'linux' || existsSync(googleChromeLinuxPath)) {
        return chromium.launch({ channel: 'chrome' })
    }
    const headlessShellPath = newestHeadlessShellPath(playwrightCacheDirectory, arch() === 'arm64' ? 'arm64' : 'x64')
    if (!headlessShellPath) {
        throw new Error('no Google Chrome or chrome-headless-shell: run `npx playwright-core install --only-shell chromium`')
    }
    prepareHeadlessShellLibraries(headlessShellPath)
    return chromium.launch({
        executablePath: headlessShellPath,
        env: { ...process.env, LD_LIBRARY_PATH: headlessShellLibraryDirectory },
    })
}

async function captureGrid(flags) {
    requireFlags(flags, ['url', 'selector', 'state', 'area', 'out'])
    const browser = await launchChrome()
    const consoleErrors = new Set()
    for (const mode of colorModes) {
        for (const [width, pixels] of Object.entries(viewportWidths)) {
            const { context, page, consoleErrors: pageErrors } = await openPage(browser, {
                url: flags.url,
                width: pixels,
                mode,
                localStorageTemplate: flags['local-storage'],
                hydrationMs: Number(flags['hydration-ms'] ?? 9000),
            })
            await dismissOverlays(page, flags.dismiss)
            const clip = await clipAround(page, flags.selector, Number(flags.padding ?? 24))
            const fileName = shotFileName({ state: flags.state, area: flags.area, mode, width })
            await page.screenshot({ path: join(flags.out, fileName), clip })
            pageErrors.forEach((message) => consoleErrors.add(message.slice(0, 200)))
            await context.close()
        }
    }
    await browser.close()
    console.log(JSON.stringify({ consoleErrors: [...consoleErrors] }, null, 1))
}

async function recordGif(flags) {
    requireFlags(flags, ['url', 'selector', 'target', 'out'])
    if (!/\.gif$/i.test(flags.out)) {
        throw new Error(`--out must end in .gif: ${flags.out}`)
    }
    const { default: gifenc } = await import('gifenc')
    const { PNG } = await import('pngjs')
    const browser = await launchChrome()
    const mode = flags.mode ?? 'light'
    const { page } = await openPage(browser, {
        url: flags.url,
        width: Number(flags.width ?? 1100),
        mode,
        localStorageTemplate: flags['local-storage'],
        hydrationMs: Number(flags['hydration-ms'] ?? 9000),
    })
    await dismissOverlays(page, flags.dismiss)
    const clip = await clipAround(page, flags.selector, Number(flags.padding ?? 90))
    const targetBox = await page.locator(flags.target).first().boundingBox()
    const restingPoint = { x: clip.x + clip.width - 20, y: clip.y + clip.height - 20 }
    const frameDelayMs = 80
    const frames = []
    const captureFrames = async (count) => {
        for (let index = 0; index < count; index++) {
            frames.push(await page.screenshot({ clip }))
            await sleep(frameDelayMs - 40)
        }
    }
    await page.mouse.move(restingPoint.x, restingPoint.y)
    await captureFrames(8)
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 6 })
    await captureFrames(12)
    await page.mouse.down()
    await page.mouse.up()
    await captureFrames(22)
    await page.mouse.move(restingPoint.x, restingPoint.y, { steps: 6 })
    await captureFrames(10)
    await browser.close()
    const encoder = gifenc.GIFEncoder()
    for (const frame of frames) {
        const { data, width, height } = PNG.sync.read(frame)
        const palette = gifenc.quantize(data, 256)
        encoder.writeFrame(gifenc.applyPalette(data, palette), width, height, { palette, delay: frameDelayMs })
    }
    encoder.finish()
    writeFileSync(flags.out, encoder.bytes())
    for (const index of [8, 20, 30]) {
        writeFileSync(flags.out.replace(/\.gif$/i, `-frame${index}.png`), frames[index])
    }
    console.log(JSON.stringify({ gif: flags.out, frames: frames.length, bytes: encoder.bytes().length }))
}

function writeContactSheet(flags) {
    requireFlags(flags, ['dir'])
    const fileNames = readdirSync(flags.dir).filter((fileName) => imageFilePattern.test(fileName))
    const outputPath = join(flags.dir, 'preview.html')
    writeFileSync(outputPath, renderContactSheet(fileNames, flags.title ?? 'Screenshots to upload'))
    console.log(outputPath)
}

function printGridMarkdown(flags) {
    requireFlags(flags, ['uploaded', 'area'])
    const urlsByStem = parseUploadedMarkdown(readFileSync(flags.uploaded, 'utf8'))
    console.log(renderGridMarkdown(flags.area, urlsByStem, flags.heading))
}

const commands = { grid: captureGrid, gif: recordGif, sheet: writeContactSheet, markdown: printGridMarkdown }

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [commandName, ...rest] = process.argv.slice(2)
    const command = commands[commandName]
    if (!command) {
        console.error(`usage: evidence.mjs <${Object.keys(commands).join('|')}> --flag value ...`)
        process.exit(2)
    }
    await command(parseFlags(rest))
}
