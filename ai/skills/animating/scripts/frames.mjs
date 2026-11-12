#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { chromeLaunchOptions, parseFlags, requireFlags } from '../../../lib/headless-chrome.mjs'

const stageViewport = { width: 1100, height: 1000 }
const sheetCellWidth = 520
const audioBitrateKbps = 160
const artifactSizeHeadroom = 0.95
const voiceDuckFilter = 'sidechaincompress=threshold=0.03:ratio=6:attack=20:release=350'
const targetLoudnessLufs = -16
const limiterFilter = 'alimiter=limit=0.84:level=false'
const narrationDriftToleranceSeconds = 0.15
const loudnessWindowSeconds = 0.05
const sustainFadeOutSeconds = 0.15
const trimmedHeadFadeInSeconds = 0.05
const silentLandingDecibels = -50

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
        sounds: (cueSheet.sounds ?? []).map((sound) => readSoundCue(sound, sheetDirectory)),
    }
}

function readSoundCue(sound, sheetDirectory) {
    if (sound.align !== undefined && sound.align !== 'peak') {
        throw new Error(`cue ${sound.clip} at ${sound.at}: align must be "peak", got ${JSON.stringify(sound.align)}`)
    }
    if (sound.align === 'peak' && sound.clipAt !== undefined) {
        throw new Error(`cue ${sound.clip} at ${sound.at}: align and clipAt both pick the clip second that lands on at; keep one`)
    }
    return {
        clip: resolve(sheetDirectory, sound.clip),
        at: sound.at,
        level: sound.level ?? 1,
        isPeakAligned: sound.align === 'peak',
        clipAtSeconds: sound.clipAt ?? 0,
        filter: sound.filter,
        fadeInSeconds: sound.fadeIn ?? trimmedHeadFadeInSeconds,
        fadeOutSeconds: sound.fadeOut ?? sustainFadeOutSeconds,
        stopBeforeSeconds: sound.stopBefore ?? 0,
        until: sound.until,
        notBefore: sound.notBefore,
    }
}

async function resolveCueTimes(page, cueSheet) {
    const voiceStoryStarts = cueSheet.voiceClips.map((_, lineIndex) => `SUBTITLES[${lineIndex}].from`)
    const voiceLeadSeconds = await page.evaluate('typeof VOICE_LEAD_SECONDS === "number" ? VOICE_LEAD_SECONDS : 0')
    const voiceStarts = await evaluateRealSeconds(page, voiceStoryStarts)
    const soundExpressions = cueSheet.sounds.flatMap((sound) => [sound.at, sound.until ?? 'NaN', sound.notBefore ?? 'NaN'])
    const soundSeconds = await evaluateRealSeconds(page, soundExpressions)
    const optionalSeconds = (storyExpression, seconds) => (storyExpression === undefined ? undefined : seconds)
    return {
        totalSeconds: await page.evaluate('totalSeconds'),
        voices: cueSheet.voiceClips.map((clip, lineIndex) => ({ clip, realSeconds: voiceStarts[lineIndex] + voiceLeadSeconds })),
        sounds: cueSheet.sounds.map((sound, soundIndex) => ({
            ...sound,
            realSeconds: soundSeconds[soundIndex * 3],
            untilSeconds: optionalSeconds(sound.until, soundSeconds[soundIndex * 3 + 1] - sound.stopBeforeSeconds),
            notBeforeSeconds: optionalSeconds(sound.notBefore, soundSeconds[soundIndex * 3 + 2]),
        })),
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

function delayedInputFilter(inputIndex, startSeconds, channelLayout, extraFilters) {
    return `[${inputIndex}:a]aresample=48000,aformat=channel_layouts=${channelLayout},${extraFilters}adelay=${Math.round(startSeconds * 1000)}:all=1`
}

function measureWindowDecibels(audioPath) {
    const windowSamples = Math.round(48000 * loudnessWindowSeconds)
    const levelFilter = `aresample=48000,aformat=channel_layouts=mono,asetnsamples=n=${windowSamples},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`
    const levelLines = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', audioPath, '-af', levelFilter, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    return [...levelLines.matchAll(/RMS_level=(\S+)/g)].map(([, level]) => (level === '-inf' ? -Infinity : Number(level)))
}

function loudestWindowCenterSeconds(windowDecibels) {
    const loudestDecibels = Math.max(...windowDecibels)
    if (!Number.isFinite(loudestDecibels)) {
        return 0
    }
    return (windowDecibels.indexOf(loudestDecibels) + 0.5) * loudnessWindowSeconds
}

function placeSound(sound, peakSecondsByClip) {
    const peakSeconds = sound.isPeakAligned ? peakSecondsByClip.get(sound.clip) : sound.clipAtSeconds
    const naturalStartSeconds = sound.realSeconds - peakSeconds
    const startSeconds = Math.max(naturalStartSeconds, sound.notBeforeSeconds ?? 0, 0)
    const label = `cue ${sound.clip} at ${sound.at}`
    if (sound.untilSeconds !== undefined && sound.untilSeconds <= startSeconds) {
        throw new Error(`${label}: until lands at ${sound.untilSeconds.toFixed(3)} s, at or before its start at ${startSeconds.toFixed(3)} s`)
    }
    return { ...sound, peakSeconds, startSeconds, skippedHeadSeconds: startSeconds - naturalStartSeconds, landingSeconds: Math.max(sound.realSeconds, startSeconds) }
}

function soundShapingFilters(placedSound, soundLevel) {
    const headTrim = placedSound.skippedHeadSeconds > 0
        ? `atrim=start=${placedSound.skippedHeadSeconds.toFixed(3)},asetpts=PTS-STARTPTS,${placedSound.fadeInSeconds > 0 ? `afade=t=in:d=${placedSound.fadeInSeconds},` : ''}`
        : ''
    const customFilter = placedSound.filter === undefined ? '' : `${placedSound.filter},`
    const sustain = placedSound.untilSeconds === undefined ? '' : sustainFilters(placedSound.untilSeconds - placedSound.startSeconds, placedSound.fadeOutSeconds)
    return `${headTrim}${customFilter}${sustain}volume=${placedSound.level * soundLevel},`
}

function sustainFilters(sustainSeconds, fadeOutSeconds) {
    return `aloop=loop=-1:size=2147483647,atrim=0:${sustainSeconds.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=${Math.max(0, sustainSeconds - fadeOutSeconds).toFixed(3)}:d=${fadeOutSeconds},`
}

function measureIntegratedLufs(audioPath) {
    const ebur128Report = spawnSync('ffmpeg', ['-nostats', '-i', audioPath, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stderr ?? ''
    const integratedLines = [...ebur128Report.matchAll(/^\s+I:\s+(-?[\d.]+) LUFS/gm)]
    if (integratedLines.length === 0) {
        throw new Error(`ebur128 printed no integrated loudness for ${audioPath}`)
    }
    return Number(integratedLines.at(-1)[1])
}

function writeLoudnessMatched(rawMixPath, outPath) {
    const measuredLufs = measureIntegratedLufs(rawMixPath)
    const gainDecibels = targetLoudnessLufs - measuredLufs
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', rawMixPath, '-af', `volume=${gainDecibels.toFixed(2)}dB,${limiterFilter}`, '-ar', '48000', outPath], { stdio: 'inherit' })
    console.log(`measured ${measuredLufs.toFixed(1)} LUFS, fixed gain ${gainDecibels.toFixed(1)} dB to ${targetLoudnessLufs} LUFS, then limiter`)
}

function formatDecibels(decibels) {
    return Number.isFinite(decibels) ? `${decibels.toFixed(1)} dB` : 'silent'
}

function printLandingReport(mixPath, placedSounds) {
    const mixWindowDecibels = measureWindowDecibels(mixPath)
    const loudestDecibelsBetween = (fromSeconds, toSeconds) => {
        const firstWindow = Math.max(0, Math.floor(fromSeconds / loudnessWindowSeconds))
        const lastWindow = Math.max(firstWindow, Math.ceil(toSeconds / loudnessWindowSeconds) - 1)
        return Math.max(...mixWindowDecibels.slice(firstWindow, lastWindow + 1))
    }
    let silentLandingCount = 0
    for (const placedSound of placedSounds) {
        const landingDecibels = loudestDecibelsBetween(placedSound.landingSeconds - loudnessWindowSeconds, placedSound.landingSeconds + 2 * loudnessWindowSeconds)
        const isSilentLanding = !(landingDecibels > silentLandingDecibels)
        silentLandingCount += isSilentLanding ? 1 : 0
        const peakNote = placedSound.isPeakAligned ? `, clip peak +${placedSound.peakSeconds.toFixed(3)} s` : ''
        const sustainNote = placedSound.untilSeconds === undefined
            ? ''
            : `, until ${placedSound.untilSeconds.toFixed(3)} s: ${formatDecibels(loudestDecibelsBetween(placedSound.untilSeconds - 0.25, placedSound.untilSeconds - 0.05))} before, ${formatDecibels(loudestDecibelsBetween(placedSound.untilSeconds + 0.05, placedSound.untilSeconds + 0.25))} after`
        console.log(`${isSilentLanding ? 'SILENT LANDING ' : ''}${placedSound.landingSeconds.toFixed(3)} s ${basename(placedSound.clip)}: ${formatDecibels(landingDecibels)}${peakNote}${sustainNote}`)
    }
    if (silentLandingCount > 0) {
        console.log(`${silentLandingCount} cue(s) land on silence: check the clip, its level, and its timing`)
    }
}

async function writeAudioMix(flags) {
    requireFlags(flags, ['page', 'sheet', 'out'])
    requireFfmpegOnPath()
    const cueSheet = readCueSheet(flags.sheet)
    const { browser, page } = await openStage(flags.page)
    const cueTimes = await resolveCueTimes(page, cueSheet)
    await browser.close()
    if (cueTimes.sounds.length === 0) {
        throw new Error('the cue sheet needs at least one sound')
    }
    const peakAlignedClips = new Set(cueTimes.sounds.filter((sound) => sound.isPeakAligned).map((sound) => sound.clip))
    const peakSecondsByClip = new Map([...peakAlignedClips].map((clip) => [clip, loudestWindowCenterSeconds(measureWindowDecibels(clip))]))
    const placedSounds = cueTimes.sounds.map((sound) => placeSound(sound, peakSecondsByClip))
    const clips = [...cueTimes.voices, ...placedSounds].map((cue) => cue.clip)
    const voiceFilters = cueTimes.voices.map((voice, voiceIndex) => `${delayedInputFilter(voiceIndex, voice.realSeconds, 'mono', '')}[voice${voiceIndex}]`)
    const soundFilters = placedSounds.map((placedSound, soundIndex) => `${delayedInputFilter(cueTimes.voices.length + soundIndex, placedSound.startSeconds, 'stereo', soundShapingFilters(placedSound, cueSheet.soundLevel))}[sound${soundIndex}]`)
    const trimToLoop = `apad,atrim=0:${cueTimes.totalSeconds}`
    const soundLabels = placedSounds.map((_, soundIndex) => `[sound${soundIndex}]`).join('')
    const soundBus = `${soundLabels}amix=inputs=${placedSounds.length}:normalize=0,${trimToLoop}`
    const busFilters = cueTimes.voices.length === 0
        ? [`${soundBus},aresample=48000[mixed]`]
        : duckedBusFilters(cueTimes.voices, soundBus, trimToLoop)
    const inputArguments = clips.flatMap((clip) => ['-i', clip])
    const rawMixDirectory = mkdtempSync(join(tmpdir(), 'animating-mix-'))
    const rawMixPath = join(rawMixDirectory, 'raw.wav')
    try {
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputArguments, '-filter_complex', [...voiceFilters, ...soundFilters, ...busFilters].join(';'), '-map', '[mixed]', '-ac', '2', '-c:a', 'pcm_f32le', rawMixPath], { stdio: 'inherit' })
        writeLoudnessMatched(rawMixPath, flags.out)
    } finally {
        rmSync(rawMixDirectory, { recursive: true, force: true })
    }
    console.log(`${flags.out}: ${cueTimes.voices.length} voice clips, ${placedSounds.length} sounds, ${cueTimes.totalSeconds.toFixed(2)} s`)
    printLandingReport(flags.out, placedSounds)
}

function duckedBusFilters(voices, soundBus, trimToLoop) {
    const voiceLabels = voices.map((_, voiceIndex) => `[voice${voiceIndex}]`).join('')
    return [
        `${voiceLabels}amix=inputs=${voices.length}:normalize=0,${trimToLoop},asplit=2[voicebus][voicekey]`,
        `${soundBus}[soundbus]`,
        `[soundbus][voicekey]${voiceDuckFilter}[duckedsound]`,
        `[voicebus][duckedsound]amix=inputs=2:normalize=0,aresample=48000[mixed]`,
    ]
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
