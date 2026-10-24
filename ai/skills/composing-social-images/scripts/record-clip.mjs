#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { getPlacement, isNonemptyString, launchBrowser, resolveInsideProjectRoot, writeFileRefusingSymlink } from './render.mjs'

const defaultFramesPerSecond = 60
const pausedClockStartMs = 3_600_000
const contentTypeByExtension = Object.freeze({
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
})

function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0
}

export function getClipViewport(placement, cssWidth) {
    const cssHeight = placement.height * cssWidth / placement.width
    if (!Number.isInteger(cssHeight)) throw new Error(`cssWidth ${cssWidth} does not divide the placement into a whole CSS height`)
    return { width: cssWidth, height: cssHeight, deviceScaleFactor: placement.width / cssWidth }
}

function countSceneFrames(scene, framesPerSecond) {
    return Math.round(scene.durationMs * framesPerSecond / 1000)
}

function validateClipManifest(manifest) {
    const violations = []
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('clip manifest must be an object')
    const framesPerSecond = manifest.framesPerSecond ?? defaultFramesPerSecond
    if (!isNonemptyString(manifest.harness)) violations.push('harness must be a directory path')
    if (!isNonemptyString(manifest.out) || !manifest.out.endsWith('.mp4')) violations.push('out must be a path ending in .mp4')
    if (!isPositiveInteger(framesPerSecond) || framesPerSecond > 60) violations.push('framesPerSecond must be an integer from 1 to 60')
    if (!isPositiveInteger(manifest.cssWidth)) violations.push('cssWidth must be a positive integer')
    try {
        const placement = getPlacement(manifest.placement)
        if (placement.width % 2 || placement.height % 2) violations.push(`placement ${manifest.placement} has an odd dimension, which H.264 4:2:0 cannot encode`)
        if (isPositiveInteger(manifest.cssWidth)) getClipViewport(placement, manifest.cssWidth)
    } catch (error) {
        violations.push(error.message)
    }
    if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) violations.push('scenes must be a nonempty array')
    for (const [sceneIndex, scene] of (Array.isArray(manifest.scenes) ? manifest.scenes : []).entries()) {
        if (!isNonemptyString(scene?.run)) violations.push(`scene ${sceneIndex + 1} needs a run expression`)
        if (!isPositiveInteger(scene?.durationMs)) violations.push(`scene ${sceneIndex + 1} needs a positive integer durationMs`)
        if (isPositiveInteger(scene?.durationMs) && isPositiveInteger(framesPerSecond) && countSceneFrames(scene, framesPerSecond) < 1) violations.push(`scene ${sceneIndex + 1} is shorter than one frame`)
    }
    if (violations.length) throw new Error(violations.join('\n'))
    return { ...manifest, framesPerSecond }
}

export function planClipFrames(scenes, framesPerSecond) {
    const frames = []
    let sceneStartMs = 0
    for (const [sceneIndex, scene] of scenes.entries()) {
        const sceneFrameCount = countSceneFrames(scene, framesPerSecond)
        const reviewFrameIndex = Math.floor(sceneFrameCount / 2)
        for (let frameIndex = 0; frameIndex < sceneFrameCount; frameIndex++) {
            frames.push({ sceneIndex, clipTimeMs: sceneStartMs + frameIndex * 1000 / framesPerSecond, startsScene: frameIndex === 0, isReviewFrame: frameIndex === reviewFrameIndex })
        }
        sceneStartMs += sceneFrameCount * 1000 / framesPerSecond
    }
    return frames
}

function buildEncoderArguments(framesPerSecond, outputPath) {
    return [
        '-hide_banner', '-loglevel', 'error', '-n',
        '-f', 'image2pipe', '-framerate', String(framesPerSecond), '-c:v', 'png', '-i', '-',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        outputPath,
    ]
}

function decodeRequestPath(requestUrl) {
    try {
        return decodeURIComponent(new URL(requestUrl, 'http://harness.invalid').pathname)
    } catch {
        return null
    }
}

export function resolveHarnessFile(harnessDirectory, requestUrl) {
    const requestPath = decodeRequestPath(requestUrl)
    if (requestPath === null || requestPath.includes('\0')) return null
    const filePath = resolve(harnessDirectory, `.${requestPath.endsWith('/') ? `${requestPath}index.html` : requestPath}`)
    if (filePath !== harnessDirectory && !filePath.startsWith(`${harnessDirectory}${sep}`)) return null
    return filePath
}

async function respondWithHarnessFile(harnessDirectory, request, response) {
    const filePath = resolveHarnessFile(harnessDirectory, request.url)
    if (!filePath || !statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        response.writeHead(404)
        response.end()
        return
    }
    const fileBytes = await readFile(filePath)
    response.writeHead(200, { 'content-type': contentTypeByExtension[extname(filePath).toLowerCase()] ?? 'application/octet-stream' })
    response.end(fileBytes)
}

async function serveHarness(harnessDirectory) {
    const server = createServer((request, response) => {
        respondWithHarnessFile(harnessDirectory, request, response).catch(() => {
            response.writeHead(500)
            response.end()
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return server
}

function collectPageFailures(clipPage) {
    const pageFailures = []
    clipPage.on('response', (response) => {
        if (!response.ok()) pageFailures.push(`${response.status()} ${response.url()}`)
    })
    clipPage.on('requestfailed', (request) => pageFailures.push(`${request.failure()?.errorText ?? 'request failed'} ${request.url()}`))
    clipPage.on('pageerror', (pageError) => pageFailures.push(`page error: ${pageError.message}`))
    return pageFailures
}

async function throwOnPageFailures(clipPage, pageFailures, failureSummary) {
    const failedFontFamilies = await clipPage.evaluate(() => Array.from(document.fonts).filter((fontFace) => fontFace.status === 'error').map((fontFace) => fontFace.family))
    const failures = [...pageFailures, ...failedFontFamilies.map((fontFamily) => `font did not load: ${fontFamily}`)]
    if (failures.length) throw new Error(`${failureSummary}:\n${failures.join('\n')}`)
}

async function loadHarnessPage(clipPage, harnessUrl, pageFailures) {
    await clipPage.goto(harnessUrl)
    await clipPage.evaluate(() => document.fonts.ready)
    await throwOnPageFailures(clipPage, pageFailures, 'harness did not load cleanly')
}

function runSceneExpression(sceneExpression) {
    globalThis.eval(sceneExpression)
}

function syncAnimationsToClipTime(clipTimeMs) {
    function collectAnimations(treeRoot) {
        const openShadowRoots = Array.from(treeRoot.querySelectorAll('*'), (element) => element.shadowRoot).filter(Boolean)
        return [...treeRoot.getAnimations(), ...openShadowRoots.flatMap(collectAnimations)]
    }
    function projectAnimationTimeMs({ firstSeenClipTimeMs, playbackStartTimeMs, playbackRate }) {
        return playbackStartTimeMs + (clipTimeMs - firstSeenClipTimeMs) * playbackRate
    }
    function pauseApplyingPendingPlaybackRate(animation) {
        animation.pause()
        animation.currentTime = animation.currentTime
    }
    globalThis.clipSeekOriginByAnimation ??= new WeakMap()
    globalThis.clipPageHeldTimeMsByAnimation ??= new WeakMap()
    for (const animation of collectAnimations(document)) {
        const seekOriginBeforeThisFrame = globalThis.clipSeekOriginByAnimation.get(animation)
        if (animation.playState === 'finished') {
            globalThis.clipSeekOriginByAnimation.delete(animation)
            globalThis.clipPageHeldTimeMsByAnimation.delete(animation)
            continue
        }
        if (!seekOriginBeforeThisFrame && animation.playState === 'paused') {
            globalThis.clipPageHeldTimeMsByAnimation.set(animation, animation.currentTime)
            continue
        }
        const effectEndTimeMs = animation.effect.getComputedTiming().endTime
        if (animation.playState !== 'paused') {
            const timeReachedMs = seekOriginBeforeThisFrame
                ? Math.min(Math.max(projectAnimationTimeMs(seekOriginBeforeThisFrame), 0), effectEndTimeMs)
                : globalThis.clipPageHeldTimeMsByAnimation.get(animation)
            globalThis.clipPageHeldTimeMsByAnimation.delete(animation)
            pauseApplyingPendingPlaybackRate(animation)
            const appliedPlaybackRate = animation.playbackRate
            const hasPlaybackLeft = appliedPlaybackRate < 0 ? timeReachedMs > 0 : timeReachedMs < effectEndTimeMs
            const rewoundTimeMs = appliedPlaybackRate < 0 ? effectEndTimeMs : 0
            globalThis.clipSeekOriginByAnimation.set(animation, { firstSeenClipTimeMs: clipTimeMs, playbackStartTimeMs: hasPlaybackLeft ? timeReachedMs : rewoundTimeMs, playbackRate: appliedPlaybackRate })
        }
        const seekOrigin = globalThis.clipSeekOriginByAnimation.get(animation)
        const { playbackRate } = seekOrigin
        const animationTimeMs = projectAnimationTimeMs(seekOrigin)
        const hasPlayedForwardToEnd = playbackRate > 0 && animationTimeMs >= effectEndTimeMs
        const hasPlayedBackwardToStart = playbackRate < 0 && animationTimeMs <= 0
        if (hasPlayedForwardToEnd || hasPlayedBackwardToStart) {
            globalThis.clipSeekOriginByAnimation.delete(animation)
            animation.finish()
            continue
        }
        animation.currentTime = animationTimeMs
    }
}

async function startEncoder(framesPerSecond, outputPath) {
    const { default: encoderPath } = await import('ffmpeg-static')
    const encoder = spawn(encoderPath, buildEncoderArguments(framesPerSecond, outputPath), { stdio: ['pipe', 'ignore', 'pipe'] })
    let encoderErrorText = ''
    encoder.stderr.on('data', (chunk) => { encoderErrorText += chunk })
    encoder.stdin.on('error', (inputError) => { encoderErrorText += `\n${inputError.message}` })
    const finished = once(encoder, 'close').then(([exitCode]) => {
        if (exitCode !== 0) throw new Error(`encoder exited ${exitCode}: ${encoderErrorText.trim()}`)
    })
    return { encoder, finished }
}

async function writeFrame(encoder, frameBytes) {
    if (encoder.stdin.write(frameBytes)) return
    await once(encoder.stdin, 'drain')
}

async function captureFramesIntoEncoder(clipPage, scenes, frames, encoder) {
    const reviewFrames = []
    let clockMs = 0
    for (const frame of frames) {
        const frameClockMs = Math.round(frame.clipTimeMs)
        if (frameClockMs > clockMs) await clipPage.clock.runFor(frameClockMs - clockMs)
        clockMs = frameClockMs
        if (frame.startsScene) await clipPage.evaluate(runSceneExpression, scenes[frame.sceneIndex].run)
        await clipPage.evaluate(syncAnimationsToClipTime, frame.clipTimeMs)
        const frameBytes = await clipPage.screenshot({ type: 'png' })
        await writeFrame(encoder, frameBytes)
        if (frame.isReviewFrame) reviewFrames.push({ sceneIndex: frame.sceneIndex, frameBytes })
    }
    encoder.stdin.end()
    return reviewFrames
}

async function encodeClip(clipPage, pageFailures, manifest, frames, outputPath) {
    const partialOutputPath = outputPath.replace(/\.mp4$/, `.${randomUUID()}.partial.mp4`)
    const { encoder, finished } = await startEncoder(manifest.framesPerSecond, partialOutputPath)
    try {
        const [reviewFrames] = await Promise.all([captureFramesIntoEncoder(clipPage, manifest.scenes, frames, encoder), finished])
        await throwOnPageFailures(clipPage, pageFailures, 'clip did not record cleanly')
        renameSync(partialOutputPath, outputPath)
        return reviewFrames
    } catch (error) {
        encoder.stdin.destroy()
        encoder.kill('SIGKILL')
        await Promise.allSettled([finished])
        rmSync(partialOutputPath, { force: true })
        throw error
    }
}

function resolveClipOutputPath(manifestDirectory, manifestOut) {
    if (lstatSync(resolve(manifestDirectory, manifestOut), { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${manifestOut}`)
    const outputPath = resolveInsideProjectRoot(manifestDirectory, manifestOut)
    if (!outputPath.endsWith('.mp4')) throw new Error(`out must resolve to a path ending in .mp4: ${manifestOut}`)
    return outputPath
}

async function recordClip(manifestPath) {
    const absoluteManifestPath = resolve(manifestPath)
    const manifestDirectory = dirname(absoluteManifestPath)
    const manifest = validateClipManifest(JSON.parse(readFileSync(absoluteManifestPath, 'utf8')))
    const harnessDirectory = resolveInsideProjectRoot(manifestDirectory, manifest.harness)
    if (!existsSync(join(harnessDirectory, 'index.html'))) throw new Error(`harness has no index.html: ${manifest.harness}`)
    const outputPath = resolveClipOutputPath(manifestDirectory, manifest.out)
    mkdirSync(dirname(outputPath), { recursive: true })

    const frames = planClipFrames(manifest.scenes, manifest.framesPerSecond)
    const reviewFramePaths = []
    let server
    let browser
    try {
        server = await serveHarness(harnessDirectory)
        browser = await launchBrowser()
        const { width, height, deviceScaleFactor } = getClipViewport(getPlacement(manifest.placement), manifest.cssWidth)
        const clipPage = await browser.newPage({ viewport: { width, height }, deviceScaleFactor })
        await clipPage.clock.install({ time: 0 })
        const pageFailures = collectPageFailures(clipPage)
        await loadHarnessPage(clipPage, `http://127.0.0.1:${server.address().port}/`, pageFailures)
        await clipPage.clock.pauseAt(pausedClockStartMs)
        for (const { sceneIndex, frameBytes } of await encodeClip(clipPage, pageFailures, manifest, frames, outputPath)) {
            const reviewFramePath = outputPath.replace(/\.mp4$/, `.scene-${sceneIndex + 1}.png`)
            writeFileRefusingSymlink(reviewFramePath, frameBytes)
            reviewFramePaths.push(reviewFramePath)
        }
    } finally {
        server?.close()
        await browser?.close()
    }
    return { outputPath, frameCount: frames.length, seconds: frames.length / manifest.framesPerSecond, bytes: statSync(outputPath).size, reviewFramePaths }
}

function parseRecordArguments(argumentList) {
    const usage = 'usage: node record-clip.mjs --manifest <path>'
    let parsedArguments
    try {
        parsedArguments = parseArgs({ args: argumentList, strict: true, allowPositionals: false, options: { manifest: { type: 'string' } } })
    } catch {
        throw new Error(usage)
    }
    if (!isNonemptyString(parsedArguments.values.manifest)) throw new Error(usage)
    return parsedArguments.values
}

async function main() {
    const flags = parseRecordArguments(process.argv.slice(2))
    const clip = await recordClip(flags.manifest)
    console.log(`wrote ${clip.outputPath}: ${clip.frameCount} frames, ${clip.seconds.toFixed(1)}s, ${clip.bytes} bytes`)
    for (const reviewFramePath of clip.reviewFramePaths) console.log(`review ${reviewFramePath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    main().catch((error) => {
        console.error(error.message)
        process.exitCode = 1
    })
}
