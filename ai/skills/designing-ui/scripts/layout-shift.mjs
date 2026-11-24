#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { chromeLaunchOptions, parseFlags, requireFlags, trackPageActivity } from '../../../lib/headless-chrome.mjs'

const viewportWidths = [640, 1440]
const colorModes = ['light', 'dark']
const stepSettleMs = 600
const usageExitCode = 2

function observeLayoutShifts() {
    const describeNode = (node) => {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return node ? node.nodeName : 'unknown'
        const idSuffix = node.id ? `#${node.id}` : ''
        const classSuffix = node.classList.length ? `.${[...node.classList].join('.')}` : ''
        return `${node.nodeName}${idSuffix}${classSuffix}`
    }
    const describeRect = (rect) => `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
    new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
            window.__reportLayoutShift({
                frameUrl: location.href,
                atMs: Math.round(entry.startTime),
                score: entry.value,
                hadRecentInput: entry.hadRecentInput,
                sources: entry.sources.map((source) => `${describeNode(source.node)} ${describeRect(source.previousRect)} -> ${describeRect(source.currentRect)}`),
            })
        }
    }).observe({ type: 'layout-shift', buffered: true })
}

function describeStep(step, stepIndex) {
    const stepNumber = stepIndex + 1
    if (typeof step?.click === 'string') return `step ${stepNumber} click ${step.click}`
    if (typeof step?.fill === 'string' && typeof step.value === 'string') return `step ${stepNumber} fill ${step.fill}`
    if (typeof step?.scroll === 'string') return `step ${stepNumber} scroll ${step.scroll}`
    if (Number.isFinite(step?.waitMs) && step.waitMs >= 0) return `step ${stepNumber} wait ${step.waitMs}ms`
    if (typeof step?.offline === 'boolean') return `step ${stepNumber} offline ${step.offline}`
    if (typeof step?.failRequests === 'string' && (step.status === undefined || isFailureStatus(step.status))) return `step ${stepNumber} fail ${step.failRequests} with ${step.status ?? 'network error'}`
    throw new Error(`step ${stepNumber}: expected {click}, {fill, value}, {scroll}, {waitMs} with waitMs >= 0, {offline: true|false}, or {failRequests: <url glob>, status?: 400-599}`)
}

function isFailureStatus(status) {
    return Number.isInteger(status) && status >= 400 && status <= 599
}

function trackForcedFailures() {
    let offlineStepLabel = null
    let hasRequestFailedOffline = false
    const interceptedRequestCountByStepLabel = new Map()
    return {
        recordOffline(stepLabel, isOffline) {
            offlineStepLabel = isOffline ? stepLabel : null
            hasRequestFailedOffline = false
        },
        recordFailedRequest() {
            if (offlineStepLabel) hasRequestFailedOffline = true
        },
        recordInterception(stepLabel) {
            interceptedRequestCountByStepLabel.set(stepLabel, (interceptedRequestCountByStepLabel.get(stepLabel) ?? 0) + 1)
        },
        activeAtEnd() {
            const failingRouteLabels = [...interceptedRequestCountByStepLabel.keys()]
            return hasRequestFailedOffline ? [offlineStepLabel, ...failingRouteLabels] : failingRouteLabels
        },
    }
}

function failMatchingRequests(page, { failRequests, status }, stepLabel, forcedFailures) {
    return page.route(failRequests, (route) => {
        forcedFailures.recordInterception(stepLabel)
        if (status === undefined) return route.abort('failed')
        return route.fulfill({ status, body: '', headers: { 'access-control-allow-origin': '*' } })
    })
}

function readSteps(stepsPath) {
    if (!stepsPath) return []
    const steps = JSON.parse(readFileSync(stepsPath, 'utf8'))
    if (!Array.isArray(steps)) throw new Error(`${stepsPath}: expected a JSON array of steps`)
    steps.forEach(describeStep)
    return steps
}

function readMillisecondsFlag(flags, name, defaultMs) {
    const milliseconds = Number(flags[name] ?? defaultMs)
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || flags[name] === true) {
        throw new Error(`--${name} must be a number of milliseconds, got ${flags[name]}`)
    }
    return milliseconds
}

async function runStep(page, step, stepLabel, forcedFailures) {
    if (step.waitMs !== undefined) return sleep(step.waitMs)
    if (step.offline !== undefined) {
        forcedFailures.recordOffline(stepLabel, step.offline)
        return page.context().setOffline(step.offline)
    }
    if (step.failRequests !== undefined) return failMatchingRequests(page, step, stepLabel, forcedFailures)
    const selector = step.click ?? step.fill ?? step.scroll
    const target = page.locator(selector).first()
    if (!(await target.count())) throw new Error(`no element matches ${selector}`)
    if (step.click !== undefined) await target.click()
    if (step.fill !== undefined) await target.fill(step.value)
    if (step.scroll !== undefined) await target.scrollIntoViewIfNeeded()
    await sleep(stepSettleMs)
}

async function scrollThroughPage(page) {
    const { pageHeight, screenHeight } = await page.evaluate(() => ({ pageHeight: document.documentElement.scrollHeight, screenHeight: window.innerHeight }))
    for (let scrollTop = screenHeight; scrollTop < pageHeight; scrollTop += screenHeight) {
        await page.evaluate((top) => window.scrollTo(0, top), scrollTop)
        await sleep(stepSettleMs)
    }
    await page.evaluate(() => window.scrollTo(0, 0))
}

async function measureContext(browser, { url, width, mode, settleMs, quietMs, steps, screenshotPrefix }) {
    const context = await browser.newContext({ viewport: { width, height: 860 }, colorScheme: mode })
    const shifts = []
    const forcedFailures = trackForcedFailures()
    let currentStepLabel = 'load'
    let markActivity = () => {}
    await context.exposeBinding('__reportLayoutShift', (_source, shift) => {
        markActivity()
        shifts.push({ width, mode, after: currentStepLabel, ...shift })
    })
    await context.addInitScript(observeLayoutShifts)
    const page = await context.newPage()
    page.on('requestfailed', () => forcedFailures.recordFailedRequest())
    const pageActivity = trackPageActivity(page)
    markActivity = pageActivity.markActivity
    const settleAndScroll = async (scrollLabel) => {
        await pageActivity.waitUntilQuiet({ capMs: settleMs, quietMs })
        currentStepLabel = scrollLabel
        await scrollThroughPage(page)
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 240000 })
    await settleAndScroll('load scroll pass')
    for (const [stepIndex, step] of steps.entries()) {
        currentStepLabel = describeStep(step, stepIndex)
        await runStep(page, step, currentStepLabel, forcedFailures).catch((error) => {
            throw new Error(`${currentStepLabel}: ${error.message}`)
        })
        markActivity()
    }
    if (steps.length) await settleAndScroll('final scroll pass')
    const screenshot = screenshotPrefix ? `${screenshotPrefix}-${width}-${mode}.png` : null
    if (screenshot) await page.screenshot({ path: screenshot })
    await context.close()
    return { shifts, screenshot, activeFailures: forcedFailures.activeAtEnd() }
}

function formatShift(shift) {
    const inputNote = shift.hadRecentInput ? ' (input-driven)' : ''
    return `${shift.width} ${shift.mode} | after ${shift.after} +${shift.atMs}ms | ${shift.score.toFixed(4)}${inputNote} | ${shift.frameUrl} | ${shift.sources.join('; ')}`
}

async function main() {
    const flags = parseFlags(process.argv.slice(2))
    requireFlags(flags, ['url'])
    if (flags.report === true) throw new Error('--report needs a file path')
    const steps = readSteps(flags.steps)
    const settleMs = readMillisecondsFlag(flags, 'settle-ms', 9000)
    const quietMs = readMillisecondsFlag(flags, 'quiet-ms', 1000)
    const browser = await chromium.launch(chromeLaunchOptions())
    try {
        const reportFile = flags.report ? resolve(flags.report) : null
        const screenshotPrefix = reportFile ? join(dirname(reportFile), basename(reportFile, extname(reportFile))) : null
        const contexts = viewportWidths.flatMap((width) => colorModes.map((mode) => ({ width, mode })))
        const measurements = await Promise.all(contexts.map(({ width, mode }) => measureContext(browser, { url: flags.url, width, mode, settleMs, quietMs, steps, screenshotPrefix })))
        const shifts = measurements.flatMap((measurement) => measurement.shifts)
        for (const shift of shifts) console.log(formatShift(shift))
        if (reportFile) {
            const screenshots = measurements.map((measurement) => measurement.screenshot)
            const forcedFailures = measurements[0].activeFailures.filter((stepLabel) => measurements.every((measurement) => measurement.activeFailures.includes(stepLabel)))
            writeFileSync(reportFile, `${JSON.stringify({ url: flags.url, shifts, screenshots, forcedFailures }, null, 1)}\n`)
        }
        process.exitCode = shifts.length ? 1 : 0
    } finally {
        await browser.close()
    }
}

main().catch((error) => {
    console.error(error.message)
    process.exitCode = usageExitCode
})
