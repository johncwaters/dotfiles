#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { chromeLaunchOptions, parseFlags, requireFlags } from '../../../../../ai/lib/headless-chrome.mjs'

const stageViewport = { width: 1100, height: 1000 }
const sheetCellWidth = 520
const audioBitrateKbps = 160
const artifactSizeHeadroom = 0.95
const voiceDuckFilter = 'sidechaincompress=threshold=0.03:ratio=6:attack=20:release=350'
const loudnessFilter = 'loudnorm=I=-16:TP=-1.5:LRA=11'
const narrationDriftToleranceSeconds = 0.15

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

async function evaluateRealSeconds(page, storyExpressions) {
    return page.evaluate((expressions) => expressions.map((expression) => realTimeAt(Function(`return (${expression})`)())), storyExpressions)
}

function readCueSheet(sheetPath) {
    const cueSheet = JSON.parse(readFileSync(sheetPath, 'utf8'))
    const sheetDirectory = dirname(resolve(sheetPath))
    return {
        soundLevel: cueSheet.soundLevel ?? 1,
        voiceClips: (cueSheet.voices ?? []).map((voice) => resolve(sheetDirectory, voice.clip)),
        sounds: (cueSheet.sounds ?? []).map((sound) => ({ clip: resolve(sheetDirectory, sound.clip), at: sound.at, level: sound.level ?? 1 })),
    }
}

async function resolveCueTimes(page, cueSheet) {
    const voiceStoryStarts = cueSheet.voiceClips.map((_, lineIndex) => `SUBTITLES[${lineIndex}].from`)
    const voiceLeadSeconds = await page.evaluate('typeof VOICE_LEAD_SECONDS === "number" ? VOICE_LEAD_SECONDS : 0')
    const voiceStarts = await evaluateRealSeconds(page, voiceStoryStarts)
    const soundStarts = await evaluateRealSeconds(page, cueSheet.sounds.map((sound) => sound.at))
    return {
        totalSeconds: await page.evaluate('totalSeconds'),
        voices: cueSheet.voiceClips.map((clip, lineIndex) => ({ clip, realSeconds: voiceStarts[lineIndex] + voiceLeadSeconds })),
        sounds: cueSheet.sounds.map((sound, soundIndex) => ({ ...sound, realSeconds: soundStarts[soundIndex] })),
    }
}

async function printCueTimes(flags) {
    requireFlags(flags, ['page', 'sheet'])
    const { browser, page } = await openStage(flags.page)
    const cueTimes = await resolveCueTimes(page, readCueSheet(flags.sheet))
    await browser.close()
    const roundedSeconds = (seconds) => Number(seconds.toFixed(3))
    console.log(JSON.stringify({
        totalSeconds: roundedSeconds(cueTimes.totalSeconds),
        voices: cueTimes.voices.map((voice) => ({ clip: voice.clip, realSeconds: roundedSeconds(voice.realSeconds) })),
        sounds: cueTimes.sounds.map((sound) => ({ clip: sound.clip, at: sound.at, realSeconds: roundedSeconds(sound.realSeconds) })),
        earshotCues: cueTimes.sounds.map((sound) => sound.realSeconds.toFixed(3)).join(','),
    }, null, 1))
}

function delayedInputFilter(inputIndex, startSeconds, extraFilters) {
    return `[${inputIndex}:a]aresample=48000,aformat=channel_layouts=mono,${extraFilters}adelay=${Math.round(startSeconds * 1000)}:all=1`
}

async function writeAudioMix(flags) {
    requireFlags(flags, ['page', 'sheet', 'out'])
    requireFfmpegOnPath()
    const cueSheet = readCueSheet(flags.sheet)
    const { browser, page } = await openStage(flags.page)
    const cueTimes = await resolveCueTimes(page, cueSheet)
    await browser.close()
    if (cueTimes.voices.length === 0 || cueTimes.sounds.length === 0) {
        throw new Error('the cue sheet needs at least one voice clip and one sound')
    }
    const clips = [...cueTimes.voices, ...cueTimes.sounds].map((cue) => cue.clip)
    const voiceFilters = cueTimes.voices.map((voice, voiceIndex) => `${delayedInputFilter(voiceIndex, voice.realSeconds, '')}[voice${voiceIndex}]`)
    const soundFilters = cueTimes.sounds.map((sound, soundIndex) => `${delayedInputFilter(cueTimes.voices.length + soundIndex, sound.realSeconds, `volume=${sound.level * cueSheet.soundLevel},`)}[sound${soundIndex}]`)
    const trimToLoop = `apad,atrim=0:${cueTimes.totalSeconds}`
    const voiceLabels = cueTimes.voices.map((_, voiceIndex) => `[voice${voiceIndex}]`).join('')
    const soundLabels = cueTimes.sounds.map((_, soundIndex) => `[sound${soundIndex}]`).join('')
    const busFilters = [
        `${voiceLabels}amix=inputs=${cueTimes.voices.length}:normalize=0,${trimToLoop},asplit=2[voicebus][voicekey]`,
        `${soundLabels}amix=inputs=${cueTimes.sounds.length}:normalize=0,${trimToLoop}[soundbus]`,
        `[soundbus][voicekey]${voiceDuckFilter}[duckedsound]`,
        `[voicebus][duckedsound]amix=inputs=2:normalize=0,${loudnessFilter},aresample=48000[mixed]`,
    ]
    const inputArguments = clips.flatMap((clip) => ['-i', clip])
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputArguments, '-filter_complex', [...voiceFilters, ...soundFilters, ...busFilters].join(';'), '-map', '[mixed]', '-ac', '2', flags.out], { stdio: 'inherit' })
    console.log(`${flags.out}: ${cueTimes.voices.length} voice clips, ${cueTimes.sounds.length} sounds, ${cueTimes.totalSeconds.toFixed(2)} s`)
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

function encodeFrames(flags, framesDirectory, framesPerSecond, totalSeconds) {
    const runFfmpeg = (ffmpegArguments) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...ffmpegArguments], { stdio: 'inherit' })
    const frameInput = ['-framerate', String(framesPerSecond), '-i', join(framesDirectory, 'frame-%05d.png')]
    const audioInput = flags.audio ? ['-i', flags.audio] : []
    const audioOutput = flags.audio ? ['-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', `${audioBitrateKbps}k`, '-shortest'] : []
    const videoFilter = ['-vf', 'scale=1920:-2:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow']
    const finish = ['-movflags', '+faststart', flags.out]
    if (!flags['max-mb']) {
        runFfmpeg([...frameInput, ...audioInput, ...videoFilter, '-crf', '18', ...audioOutput, ...finish])
        return
    }
    const audioShareKbps = flags.audio ? audioBitrateKbps : 0
    const videoBitrateKbps = Math.floor((Number(flags['max-mb']) * 8000 * artifactSizeHeadroom) / totalSeconds - audioShareKbps)
    if (!(videoBitrateKbps > 0)) {
        throw new Error(`--max-mb ${flags['max-mb']} leaves no video bitrate for ${totalSeconds.toFixed(1)} s`)
    }
    const twoPass = (passNumber) => ['-b:v', `${videoBitrateKbps}k`, '-pass', String(passNumber), '-passlogfile', join(framesDirectory, 'pass')]
    runFfmpeg([...frameInput, ...videoFilter, ...twoPass(1), '-an', '-f', 'null', devNull])
    runFfmpeg([...frameInput, ...audioInput, ...videoFilter, ...twoPass(2), ...audioOutput, ...finish])
}

async function readNarrationState(page) {
    return page.evaluate(() => {
        const narration = document.getElementById('narration')
        const volume = document.getElementById('volume')
        return {
            hasNarration: narration instanceof HTMLAudioElement,
            hasVolume: volume instanceof HTMLInputElement,
            narrationSeconds: narration?.duration ?? NaN,
            isPaused: narration?.paused ?? true,
            audioSeconds: narration?.currentTime ?? NaN,
            volume: narration?.volume ?? NaN,
            pageSeconds: typeof currentTime === 'number' ? currentTime : NaN,
            totalSeconds: window.totalSeconds,
        }
    })
}

async function collectNarrationFailures(page) {
    const initial = await readNarrationState(page)
    if (!initial.hasNarration) {
        return ['no <audio id="narration"> element: the page must carry its own narration, not only the MP4']
    }
    const failures = []
    if (!(Math.abs(initial.narrationSeconds - initial.totalSeconds) <= 0.5)) {
        failures.push(`narration lasts ${initial.narrationSeconds} s but the loop is ${initial.totalSeconds} s`)
    }
    if (!initial.hasVolume) {
        failures.push('no <input id="volume"> control for narration volume')
    }
    await page.mouse.click(400, 400)
    await page.waitForTimeout(2000)
    const playing = await readNarrationState(page)
    if (playing.isPaused) {
        failures.push('narration did not start after a click on the page')
    }
    if (!(Math.abs(playing.audioSeconds - playing.pageSeconds) <= narrationDriftToleranceSeconds)) {
        failures.push(`audio at ${playing.audioSeconds.toFixed(2)} s drifts from the page clock at ${playing.pageSeconds.toFixed(2)} s`)
    }
    if (initial.hasVolume) {
        await page.locator('#volume').fill('0.3')
        const adjusted = await readNarrationState(page)
        if (Math.abs(adjusted.volume - 0.3) > 0.01) {
            failures.push(`setting #volume to 0.3 left narration volume at ${adjusted.volume}`)
        }
    }
    const hasPauseControl = (await page.locator('#pause').count()) > 0
    if (!hasPauseControl) {
        failures.push('no #pause control to stop the narration')
        return failures
    }
    await page.click('#pause')
    await page.waitForTimeout(300)
    const paused = await readNarrationState(page)
    if (!paused.isPaused) {
        failures.push('#pause left the narration playing')
    }
    return failures
}

async function checkPageAudio(flags) {
    requireFlags(flags, ['page'])
    const launchOptions = chromeLaunchOptions()
    const gestureOnlyArguments = [...(launchOptions.args ?? []).filter((argument) => !argument.startsWith('--autoplay-policy')), '--autoplay-policy=user-gesture-required']
    const browser = await chromium.launch({ ...launchOptions, args: gestureOnlyArguments })
    const pageErrors = []
    let narrationFailures = []
    try {
        const page = await browser.newPage({ viewport: stageViewport })
        page.on('pageerror', (error) => pageErrors.push(`page error: ${error.message}`))
        await page.goto(pathToFileURL(resolve(flags.page)).href)
        await page.waitForTimeout(1000)
        narrationFailures = await collectNarrationFailures(page)
    } finally {
        await browser.close()
    }
    const failures = [...pageErrors, ...narrationFailures]
    if (failures.length) {
        console.error(failures.map((failure) => `audio-check: ${failure}`).join('\n'))
        process.exit(1)
    }
    console.log(`audio-check passed: ${flags.page}`)
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
        encodeFrames(flags, framesDirectory, framesPerSecond, frameCount / framesPerSecond)
        console.log(`${flags.out}: ${frameCount} frames at ${framesPerSecond} fps, ${(statSync(flags.out).size / 1e6).toFixed(1)} MB${flags.audio ? ' with audio' : ''}`)
    } finally {
        await browser?.close()
        rmSync(framesDirectory, { recursive: true, force: true })
    }
}

const commands = { sheet: writeContactSheet, render: renderVideo, cues: printCueTimes, mix: writeAudioMix, 'audio-check': checkPageAudio }
const [commandName, ...rest] = process.argv.slice(2)
const command = commands[commandName]
if (!command) {
    console.error(`usage: frames.mjs <${Object.keys(commands).join('|')}> --page <html> ...`)
    process.exit(2)
}
await command(parseFlags(rest))
