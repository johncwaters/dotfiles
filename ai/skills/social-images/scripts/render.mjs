#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { closeSync, constants as fileSystemConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const placements = Object.freeze({
    'instagram-portrait': { width: 1080, height: 1350, safeInsets: { top: 81, right: 65, bottom: 81, left: 65 }, maxBytes: 1_000_000, minTextPx: 32 },
    'instagram-square': { width: 1080, height: 1080, safeInsets: { top: 65, right: 65, bottom: 65, left: 65 }, maxBytes: 1_000_000, minTextPx: 32 },
    story: { width: 1080, height: 1920, safeInsets: { top: 269, right: 65, bottom: 672, left: 65 }, maxBytes: 1_000_000, minTextPx: 32 },
    'link-card': { width: 1200, height: 630, safeInsets: { top: 0, right: 285, bottom: 0, left: 285 }, maxBytes: 1_000_000, minTextPx: 35 },
    'x-card': { width: 1200, height: 600, safeInsets: { top: 36, right: 72, bottom: 36, left: 72 }, maxBytes: 1_000_000, minTextPx: 35 },
    pinterest: { width: 1000, height: 1500, safeInsets: { top: 90, right: 60, bottom: 90, left: 60 }, maxBytes: 1_000_000, minTextPx: 29 },
})

export function getPlacement(name) {
    if (!Object.hasOwn(placements, name)) {
        throw new Error(`unknown placement: ${name}`)
    }
    return placements[name]
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonemptyString(value) {
    return typeof value === 'string' && value.trim().length > 0
}

function isLocalPath(value) {
    return isNonemptyString(value) && !isAbsolute(value) && !/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('//')
}

function resolveThroughExistingAncestor(absolutePath) {
    if (existsSync(absolutePath)) return realpathSync(absolutePath)
    if (lstatSync(absolutePath, { throwIfNoEntry: false })) throw new Error(`dangling symlink: ${absolutePath}`)
    const parentPath = dirname(absolutePath)
    if (parentPath === absolutePath) return absolutePath
    return join(resolveThroughExistingAncestor(parentPath), basename(absolutePath))
}

const projectRootByManifestDirectory = new Map()

export function findProjectRoot(manifestDirectory) {
    const resolvedManifestDirectory = resolveThroughExistingAncestor(resolve(manifestDirectory))
    if (projectRootByManifestDirectory.has(resolvedManifestDirectory)) return projectRootByManifestDirectory.get(resolvedManifestDirectory)
    let projectRoot = resolvedManifestDirectory
    try {
        const worktreeTopLevel = execFileSync('git', ['-C', resolvedManifestDirectory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        if (worktreeTopLevel) projectRoot = realpathSync(worktreeTopLevel)
    } catch {
        projectRoot = resolvedManifestDirectory
    }
    projectRootByManifestDirectory.set(resolvedManifestDirectory, projectRoot)
    return projectRoot
}

export function resolveInsideProjectRoot(manifestDirectory, localPath) {
    if (!isLocalPath(localPath)) throw new Error(`path must be local: ${localPath}`)
    const absolutePath = resolveThroughExistingAncestor(resolve(manifestDirectory, localPath))
    const pathFromProjectRoot = relative(findProjectRoot(manifestDirectory), absolutePath)
    if (!pathFromProjectRoot || pathFromProjectRoot === '..' || pathFromProjectRoot.startsWith(`..${sep}`) || isAbsolute(pathFromProjectRoot)) {
        throw new Error(`path escapes the project root: ${localPath}`)
    }
    return absolutePath
}

function isInsideProjectRoot(manifestDirectory, localPath) {
    try {
        resolveInsideProjectRoot(manifestDirectory, localPath)
        return true
    } catch {
        return false
    }
}

export function validateManifest(manifest, { manifestDirectory = process.cwd(), templateExists = () => true } = {}) {
    if (!isRecord(manifest) || !isInsideProjectRoot(manifestDirectory, manifest.brand) || !Array.isArray(manifest.shots) || !manifest.shots.length) {
        throw new Error('manifest requires a local brand path and a nonempty shots array')
    }
    const violations = []
    const outputPaths = new Set()
    for (const [index, shot] of manifest.shots.entries()) {
        const label = `shot ${index + 1}`
        if (!isRecord(shot)) {
            violations.push(`${label}: must be an object`)
            continue
        }
        if (!isNonemptyString(shot.alt)) violations.push(`${label}: alt is required`)
        if (!Object.hasOwn(placements, shot.placement)) violations.push(`${label}: unknown placement: ${shot.placement}`)
        if (!isInsideProjectRoot(manifestDirectory, shot.template) || !templateExists(shot.template)) violations.push(`${label}: missing template: ${shot.template}`)
        const hasContainedOutput = isInsideProjectRoot(manifestDirectory, shot.out) && /\.png$/i.test(shot.out)
        if (!hasContainedOutput) violations.push(`${label}: out must be a local PNG path`)
        const resolvedOutputPath = hasContainedOutput ? resolveInsideProjectRoot(manifestDirectory, shot.out) : shot.out
        if (outputPaths.has(resolvedOutputPath)) violations.push(`${label}: duplicate output: ${shot.out}`)
        outputPaths.add(resolvedOutputPath)
        if (shot.vars !== undefined && !isRecord(shot.vars)) {
            violations.push(`${label}: vars must be an object`)
            continue
        }
        for (const [name, value] of Object.entries(shot.vars ?? {})) {
            if (!/^[a-z][a-z\d-]*$/i.test(name) || !['string', 'number', 'boolean'].includes(typeof value)) {
                violations.push(`${label}: invalid slot: ${name}`)
            }
            if (['image', 'logo'].includes(name) && !isInsideProjectRoot(manifestDirectory, value)) violations.push(`${label}: ${name} must be a local asset path`)
            if (name === 'deviceFrame' && typeof value !== 'boolean') violations.push(`${label}: deviceFrame must be boolean`)
        }
    }
    if (violations.length) throw new Error(violations.join('\n'))
    return manifest
}

export function validateBrand(brand) {
    if (!isRecord(brand)) throw new Error('brand must be an object')
    const colorNames = ['background', 'surface', 'ink', 'accent', 'accentInk']
    if (brand.colors !== undefined) {
        if (!isRecord(brand.colors)) throw new Error('brand.colors must be an object')
        for (const [name, color] of Object.entries(brand.colors)) {
            if (!colorNames.includes(name) || !isNonemptyString(color) || /[;{}]|url\(/i.test(color)) {
                throw new Error(`invalid brand color: ${name}`)
            }
        }
    }
    if (brand.fonts !== undefined) {
        if (!isRecord(brand.fonts)) throw new Error('brand.fonts must be an object')
        for (const [role, font] of Object.entries(brand.fonts)) {
            if (!['display', 'body'].includes(role) || !isRecord(font) || !isNonemptyString(font.family) || !Array.isArray(font.files) || !font.files.length || !font.files.every(isLocalPath)) {
                throw new Error(`invalid brand font: ${role}`)
            }
            const weights = String(font.weight).split(' ').map(Number)
            if (!/^(\d{1,4})( \d{1,4})?$/.test(String(font.weight)) || weights.some((weight) => weight < 1 || weight > 1000) || (weights.length === 2 && weights[0] > weights[1])) {
                throw new Error(`invalid brand font weight: ${role}`)
            }
        }
    }
    if (brand.logo !== undefined && !isLocalPath(brand.logo)) throw new Error('brand.logo must be a local asset path')
    return brand
}

export function getRenderScale(placement) {
    return placement.width % 2 || placement.height % 2 ? 1 : 2
}

export function buildCssVariables(brand, placement, scale = getRenderScale(placement)) {
    validateBrand(brand)
    const variables = {
        '--canvas-width': `${placement.width / scale}px`,
        '--canvas-height': `${placement.height / scale}px`,
        '--min-text-size': `${placement.minTextPx / scale}px`,
    }
    for (const [side, inset] of Object.entries(placement.safeInsets)) variables[`--safe-${side}`] = `${inset / scale}px`
    for (const [name, color] of Object.entries(brand.colors ?? {})) {
        const tokenName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
        variables[`--brand-${tokenName}`] = color
    }
    for (const [role, font] of Object.entries(brand.fonts ?? {})) {
        variables[`--brand-${role}-family`] = JSON.stringify(font.family)
        const [lightestWeight, heaviestWeight = lightestWeight] = String(font.weight).split(' ').map(Number)
        variables[`--brand-${role}-weight`] = String(Math.min(Math.max(400, lightestWeight), heaviestWeight))
    }
    return variables
}

export function parsePngSize(bytes) {
    const header = Buffer.from(bytes)
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    if (header.length < 33 || !header.subarray(0, 8).equals(signature) || header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error('invalid PNG IHDR header')
    }
    const width = header.readUInt32BE(16)
    const height = header.readUInt32BE(20)
    if (!width || !height) throw new Error('PNG dimensions must be positive')
    return { width, height }
}

export function buildPngViolations(bytes, placement, label = 'PNG') {
    const violations = []
    try {
        const { width, height } = parsePngSize(bytes)
        if (width !== placement.width || height !== placement.height) {
            violations.push(`${label}: ${width}x${height}, expected ${placement.width}x${placement.height}`)
        }
    } catch (error) {
        violations.push(`${label}: ${error.message}`)
    }
    if (bytes.length > placement.maxBytes) violations.push(`${label}: ${bytes.length} bytes exceeds ${placement.maxBytes}`)
    return violations
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)
}

export function renderContactSheet(altTextByFileName, title) {
    const cells = Object.entries(altTextByFileName).map(([fileName, altText]) =>
        `<figure><img src="${escapeHtml(encodeURIComponent(fileName))}" alt="${escapeHtml(altText)}"><figcaption><code>${escapeHtml(fileName)}</code><p>${escapeHtml(altText)}</p></figcaption></figure>`)
    const styles = 'body{font:14px -apple-system,sans-serif;margin:24px;background:#f6f8fa}main{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}figure{margin:0;padding:12px;background:#fff;border:1px solid #d0d7de;width:420px}img{width:100%;display:block}code{font:11px ui-monospace,monospace;color:#59636e}'
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body><h1>${escapeHtml(title)}</h1><main>${cells.join('')}</main></body></html>`
}

function writeFileRefusingSymlink(filePath, contents) {
    if (lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${filePath}`)
    const fileDescriptor = openSync(filePath, fileSystemConstants.O_WRONLY | fileSystemConstants.O_CREAT | fileSystemConstants.O_TRUNC | fileSystemConstants.O_NOFOLLOW, 0o644)
    try {
        writeFileSync(fileDescriptor, contents)
    } finally {
        closeSync(fileDescriptor)
    }
}

export function writeAltTextAndSheet(outputDirectory, renderedAltTextByFileName, { sheetTitle } = {}) {
    const altTextPath = resolve(outputDirectory, 'alt.json')
    const previewPath = resolve(outputDirectory, 'preview.html')
    for (const outputFilePath of [altTextPath, previewPath]) {
        if (lstatSync(outputFilePath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${outputFilePath}`)
    }
    const previousAltTextByFileName = existsSync(altTextPath) ? JSON.parse(readFileSync(altTextPath, 'utf8')) : {}
    if (!isRecord(previousAltTextByFileName)) throw new Error(`${altTextPath} must hold an object`)
    const altTextByFileName = { ...previousAltTextByFileName, ...renderedAltTextByFileName }
    writeFileRefusingSymlink(altTextPath, `${JSON.stringify(altTextByFileName, null, 2)}\n`)
    if (sheetTitle) writeFileRefusingSymlink(previewPath, renderContactSheet(altTextByFileName, sheetTitle))
}

async function launchBrowser() {
    const { chromium } = await import('playwright-core')
    const options = { headless: true, args: ['--force-color-profile=srgb'] }
    try {
        return await chromium.launch({ ...options, channel: 'chrome' })
    } catch (error) {
        if (!/distribution 'chrome' is not found|Executable doesn't exist/i.test(error.message)) throw error
        return chromium.launch(options)
    }
}

function resolveAssetUrl(manifestDirectory, assetPath) {
    const absolutePath = resolveInsideProjectRoot(manifestDirectory, assetPath)
    if (!existsSync(absolutePath)) throw new Error(`missing asset: ${assetPath}`)
    return pathToFileURL(absolutePath).href
}

async function preparePage(page, { brand, placement, scale, manifestDirectory, shot, safeZones }) {
    const fonts = Object.values(brand.fonts ?? {}).map((font) => ({
        ...font,
        urls: font.files.map((file) => resolveAssetUrl(manifestDirectory, file)),
    }))
    const slots = { ...shot.vars }
    if (!Object.hasOwn(slots, 'logo') && brand.logo) slots.logo = brand.logo
    for (const name of ['image', 'logo']) {
        if (slots[name]) slots[name] = resolveAssetUrl(manifestDirectory, slots[name])
    }
    await page.evaluate(({ variables, fonts, slots, safeZones }) => {
        for (const [name, value] of Object.entries(variables)) {
            if (name.startsWith('--brand-') && !name.endsWith('-family') && !name.endsWith('-weight') && !CSS.supports('color', value)) {
                throw new Error(`invalid brand color: ${name}=${value}`)
            }
            document.documentElement.style.setProperty(name, value)
        }
        const fontStyles = document.createElement('style')
        fontStyles.textContent = fonts.map((font) => `@font-face{font-family:${JSON.stringify(font.family)};src:${font.urls.map((url) => `url(${JSON.stringify(url)})`).join(',')};font-weight:${font.weight};font-style:normal;font-display:block;}`).join('\n')
        document.head.append(fontStyles)
        document.documentElement.dataset.deviceFrame = String(slots.deviceFrame === true)
        for (const element of document.querySelectorAll('[data-slot]')) {
            const value = slots[element.dataset.slot]
            if (element instanceof HTMLImageElement) {
                if (!value) {
                    element.remove()
                    continue
                }
                element.src = String(value)
                continue
            }
            element.textContent = value === undefined ? '' : String(value)
        }
        if (!safeZones) return
        for (const side of ['top', 'right', 'bottom', 'left']) {
            const overlay = document.createElement('div')
            const isHorizontal = ['top', 'bottom'].includes(side)
            Object.assign(overlay.style, {
                position: 'fixed', background: '#d946ef38', pointerEvents: 'none', zIndex: '2147483647',
                [side]: '0', [isHorizontal ? 'left' : 'top']: '0',
                width: isHorizontal ? '100%' : `var(--safe-${side})`,
                height: isHorizontal ? `var(--safe-${side})` : '100%',
            })
            document.body.append(overlay)
        }
    }, { variables: buildCssVariables(brand, placement, scale), fonts, slots, safeZones })
}

async function collectPageViolations(page, placement, scale) {
    return page.evaluate(async ({ minTextPx, scale }) => {
        const violations = []
        await document.fonts.ready
        for (const font of document.fonts) {
            if (font.status === 'error') violations.push(`font failed to load: ${font.family}`)
        }
        for (const image of document.images) {
            try {
                await image.decode()
                if (!image.naturalWidth) violations.push(`image failed to load: ${image.src}`)
            } catch {
                violations.push(`image failed to load: ${image.src}`)
            }
        }
        const textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        while (textWalker.nextNode()) {
            const node = textWalker.currentNode
            const text = node.textContent.trim()
            if (!text || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.parentElement.tagName)) continue
            const style = getComputedStyle(node.parentElement)
            if (style.visibility !== 'visible') continue
            let hasHiddenAncestor = false
            for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
                const ancestorStyle = getComputedStyle(ancestor)
                if (ancestorStyle.display === 'none' || Number(ancestorStyle.opacity) === 0 || ancestorStyle.contentVisibility === 'hidden') {
                    hasHiddenAncestor = true
                    break
                }
            }
            if (hasHiddenAncestor) continue
            const range = document.createRange()
            range.selectNodeContents(node)
            const isVisible = [...range.getClientRects()].some((rectangle) => rectangle.width > 0 && rectangle.height > 0 && rectangle.right > 0 && rectangle.bottom > 0 && rectangle.left < innerWidth && rectangle.top < innerHeight)
            if (!isVisible) continue
            const outputFontSize = parseFloat(style.fontSize) * scale
            if (outputFontSize < minTextPx) violations.push(`text too small (${outputFontSize}px < ${minTextPx}px): ${text}`)
        }
        return violations
    }, { minTextPx: placement.minTextPx, scale })
}

export async function renderManifest(manifestPath, { safeZones = false, sheet = false } = {}) {
    const manifestDirectory = dirname(resolve(manifestPath))
    const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), {
        manifestDirectory,
        templateExists: (template) => existsSync(resolveInsideProjectRoot(manifestDirectory, template)),
    })
    const brand = validateBrand(JSON.parse(readFileSync(resolveInsideProjectRoot(manifestDirectory, manifest.brand), 'utf8')))
    const outputGroups = new Map()
    const violations = []
    const browser = await launchBrowser()
    try {
        for (const shot of manifest.shots) {
            const placement = getPlacement(shot.placement)
            const scale = getRenderScale(placement)
            const context = await browser.newContext({ viewport: { width: placement.width / scale, height: placement.height / scale }, deviceScaleFactor: scale })
            try {
                await context.route(/^https?:\/\//, (route) => route.abort())
                const page = await context.newPage()
                await page.goto(pathToFileURL(resolveInsideProjectRoot(manifestDirectory, shot.template)).href, { waitUntil: 'load' })
                await preparePage(page, { brand, placement, scale, manifestDirectory, shot, safeZones })
                const pageViolations = await collectPageViolations(page, placement, scale)
                if (pageViolations.length) {
                    violations.push(...pageViolations.map((violation) => `${shot.out}: ${violation}`))
                    continue
                }
                const bytes = await page.screenshot({ type: 'png', fullPage: false, omitBackground: false, animations: 'disabled' })
                const pngViolations = buildPngViolations(bytes, placement, shot.out)
                violations.push(...pngViolations)
                if (pngViolations.length) continue
                const outputPath = resolveInsideProjectRoot(manifestDirectory, shot.out)
                const outputDirectory = dirname(outputPath)
                mkdirSync(outputDirectory, { recursive: true })
                writeFileRefusingSymlink(outputPath, bytes)
                if (!outputGroups.has(outputDirectory)) outputGroups.set(outputDirectory, {})
                outputGroups.get(outputDirectory)[basename(outputPath)] = shot.alt
                console.log(`${shot.out}: ${placement.width}x${placement.height}, ${bytes.length} bytes`)
            } catch (error) {
                violations.push(`${shot.out}: ${error.message}`)
            } finally {
                await context.close()
            }
        }
    } finally {
        await browser.close()
    }
    const sheetTitle = sheet ? (safeZones ? 'Social images: safe-zone review' : 'Social images') : undefined
    for (const [outputDirectory, renderedAltTextByFileName] of outputGroups) {
        try {
            writeAltTextAndSheet(outputDirectory, renderedAltTextByFileName, { sheetTitle })
        } catch (error) {
            violations.push(`${outputDirectory}: ${error.message}`)
        }
    }
    if (violations.length) throw new Error(violations.join('\n'))
}

export function parseRenderArguments(argumentList) {
    const usage = 'usage: node render.mjs --manifest <path> [--safe-zones] [--sheet]'
    let parsedArguments
    try {
        parsedArguments = parseArgs({ args: argumentList, strict: true, allowPositionals: false, options: { manifest: { type: 'string' }, 'safe-zones': { type: 'boolean' }, sheet: { type: 'boolean' } } })
    } catch {
        throw new Error(usage)
    }
    if (!isNonemptyString(parsedArguments.values.manifest)) throw new Error(usage)
    return parsedArguments.values
}

async function main() {
    const flags = parseRenderArguments(process.argv.slice(2))
    await renderManifest(flags.manifest, { safeZones: flags['safe-zones'] === true, sheet: flags.sheet === true })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error(error.message)
        process.exitCode = 1
    })
}
