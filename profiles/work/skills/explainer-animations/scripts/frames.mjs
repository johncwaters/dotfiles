#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { chromeLaunchOptions, parseFlags, requireFlags } from '../../../../../ai/lib/headless-chrome.mjs'

const stageViewport = { width: 1100, height: 1000 }
const sheetCellWidth = 520

function requireFfmpegOnPath() {
    try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error
        }
        throw new Error('ffmpeg not found on PATH: install ffmpeg to render video')
    }
}

async function openStage(pagePath) {
    const browser = await chromium.launch(chromeLaunchOptions())
    const page = await browser.newPage({ viewport: stageViewport, deviceScaleFactor: 2, colorScheme: 'light' })
    await page.goto(`${pathToFileURL(resolve(pagePath)).href}#t0`)
    await page.evaluate(() => document.fonts.ready)
    const contractTypes = await page.evaluate('[typeof renderAt, typeof realTimeAt, typeof totalSeconds]')
    if (contractTypes.join() !== 'function,function,number') {
        await browser.close()
        throw new Error(`page breaks the contract (renderAt, realTimeAt, totalSeconds): got ${contractTypes.join(', ')}`)
    }
    return { browser, page, stage: page.locator('#stage') }
}

async function writeContactSheet(flags) {
    requireFlags(flags, ['page', 'times', 'out'])
    const storyTimes = String(flags.times).split(',').map(Number)
    const columnCount = Number(flags.columns ?? 4)
    const { browser, page, stage } = await openStage(flags.page)
    const cells = []
    for (const storyTime of storyTimes) {
        await page.evaluate(`renderAt(realTimeAt(${storyTime}))`)
        const frame = await stage.screenshot()
        cells.push(`<figure><img src="data:image/png;base64,${frame.toString('base64')}"><figcaption>${storyTime}</figcaption></figure>`)
    }
    await page.setViewportSize({ width: sheetCellWidth * columnCount, height: 400 })
    await page.setContent(`<style>body{margin:0;display:grid;grid-template-columns:repeat(${columnCount},1fr)}figure{margin:0;position:relative}img{width:100%;display:block}figcaption{position:absolute;top:6px;left:8px;font:700 20px monospace;color:#e00}</style>${cells.join('')}`)
    await page.screenshot({ path: flags.out, fullPage: true })
    await browser.close()
    console.log(flags.out)
}

async function renderVideo(flags) {
    requireFlags(flags, ['page', 'out'])
    requireFfmpegOnPath()
    const framesPerSecond = Number(flags.fps ?? 30)
    const framesDirectory = mkdtempSync(join(tmpdir(), 'explainer-frames-'))
    let browser
    try {
        const stageHandles = await openStage(flags.page)
        browser = stageHandles.browser
        const { page, stage } = stageHandles
        const frameCount = Math.round(framesPerSecond * (await page.evaluate('totalSeconds')))
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            await page.evaluate(`renderAt(${(frameIndex / framesPerSecond).toFixed(4)})`)
            await stage.screenshot({ path: join(framesDirectory, `frame-${String(frameIndex).padStart(5, '0')}.png`) })
        }
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(framesPerSecond), '-i', join(framesDirectory, 'frame-%05d.png'), '-vf', 'scale=1920:-2:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', flags.out], { stdio: 'inherit' })
        console.log(`${flags.out}: ${frameCount} frames at ${framesPerSecond} fps`)
    } finally {
        await browser?.close()
        rmSync(framesDirectory, { recursive: true, force: true })
    }
}

const commands = { sheet: writeContactSheet, render: renderVideo }
const [commandName, ...rest] = process.argv.slice(2)
const command = commands[commandName]
if (!command) {
    console.error(`usage: frames.mjs <${Object.keys(commands).join('|')}> --page <html> ...`)
    process.exit(2)
}
await command(parseFlags(rest))
