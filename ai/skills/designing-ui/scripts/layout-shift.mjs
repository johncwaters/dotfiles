#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { chromeLaunchOptions, parseFlags, requireFlags } from '../../../lib/headless-chrome.mjs'

const viewportWidths = [640, 1440]
const stepSettleMs = 600
const quietPollMs = 100
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
    throw new Error(`step ${stepNumber}: expected {click}, {fill, value}, {scroll}, or {waitMs} with waitMs >= 0`)
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

async function runStep(page, step) {
    if (step.waitMs !== undefined) return sleep(step.waitMs)
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

async function measureAtWidth(browser, { url, width, settleMs, quietMs, steps }) {
    const context = await browser.newContext({ viewport: { width, height: 860 } })
    const shifts = []
    let currentStepLabel = 'load'
    let lastActivityAt = Date.now()
    let requestsInFlight = 0
    const markActivity = () => {
        lastActivityAt = Date.now()
    }
    await context.exposeBinding('__reportLayoutShift', (_source, shift) => {
        markActivity()
        shifts.push({ width, after: currentStepLabel, ...shift })
    })
    await context.addInitScript(observeLayoutShifts)
    const page = await context.newPage()
    page.on('request', () => {
        requestsInFlight++
        markActivity()
    })
    for (const requestEnd of ['requestfinished', 'requestfailed']) {
        page.on(requestEnd, () => {
            requestsInFlight--
            markActivity()
        })
    }
    const settleAndScroll = async (scrollLabel) => {
        const settleDeadline = Date.now() + settleMs
        while (Date.now() < settleDeadline && (requestsInFlight > 0 || Date.now() - lastActivityAt < quietMs)) {
            await sleep(quietPollMs)
        }
        currentStepLabel = scrollLabel
        await scrollThroughPage(page)
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 240000 })
    await settleAndScroll('load scroll pass')
    for (const [stepIndex, step] of steps.entries()) {
        currentStepLabel = describeStep(step, stepIndex)
        await runStep(page, step).catch((error) => {
            throw new Error(`${currentStepLabel}: ${error.message}`)
        })
        markActivity()
    }
    if (steps.length) await settleAndScroll('final scroll pass')
    await context.close()
    return shifts
}

function formatShift(shift) {
    const inputNote = shift.hadRecentInput ? ' (input-driven)' : ''
    return `${shift.width} | after ${shift.after} +${shift.atMs}ms | ${shift.score.toFixed(4)}${inputNote} | ${shift.frameUrl} | ${shift.sources.join('; ')}`
}

async function main() {
    const flags = parseFlags(process.argv.slice(2))
    requireFlags(flags, ['url'])
    const steps = readSteps(flags.steps)
    const settleMs = readMillisecondsFlag(flags, 'settle-ms', 9000)
    const quietMs = readMillisecondsFlag(flags, 'quiet-ms', 1000)
    const browser = await chromium.launch(chromeLaunchOptions())
    try {
        const shiftsByWidth = await Promise.all(viewportWidths.map((width) => measureAtWidth(browser, { url: flags.url, width, settleMs, quietMs, steps })))
        const shifts = shiftsByWidth.flat()
        for (const shift of shifts) console.log(formatShift(shift))
        process.exitCode = shifts.length ? 1 : 0
    } finally {
        await browser.close()
    }
}

main().catch((error) => {
    console.error(error.message)
    process.exitCode = usageExitCode
})
