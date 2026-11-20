import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { runInNewContext } from 'node:vm'
import { buildCssVariables, buildPngViolations, calculateImageUpscale, fitCodeFont, collectPageViolations, getPlacement, getRenderScale, isVectorImageSource, parsePngSize, parseRenderArguments, placements, maxCodeLines, readCodeSlot, readTemplateKind, findProjectRoot, renderContactSheet, resolveInsideProjectRoot, templateKinds, validateBrand, validateManifest, writeAltTextAndSheet } from '../scripts/render.mjs'

function createManifest(overrides = {}) {
    return { brand: 'brand.json', shots: [{ template: 'templates/hook.html', placement: 'instagram-square', out: 'out/hook.png', alt: 'A real project image.', vars: { headline: 'Keep a habit' }, ...overrides }] }
}

function calculateCrc32(bytes) {
    let checksum = 0xffffffff
    for (const byte of bytes) {
        checksum ^= byte
        for (let bitIndex = 0; bitIndex < 8; bitIndex++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0)
    }
    return (checksum ^ 0xffffffff) >>> 0
}

function createPngChunk(type, payload) {
    const chunk = Buffer.alloc(payload.length + 12)
    chunk.writeUInt32BE(payload.length)
    chunk.write(type, 4, 'ascii')
    payload.copy(chunk, 8)
    chunk.writeUInt32BE(calculateCrc32(chunk.subarray(4, -4)), chunk.length - 4)
    return chunk
}

function createTinyPng() {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(1, 0)
    header.writeUInt32BE(1, 4)
    header[8] = 8
    header[9] = 2
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        createPngChunk('IHDR', header),
        createPngChunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))),
        createPngChunk('IEND', Buffer.alloc(0)),
    ])
}

test('story margins round Meta percentages up and link cards preserve a centered square', () => {
    assert.deepEqual(placements.story.safeInsets, { top: Math.ceil(1920 * .14), bottom: 1920 * .35, left: Math.ceil(1080 * .06), right: Math.ceil(1080 * .06) })
    const linkCard = placements['link-card']
    assert.equal(linkCard.width - linkCard.safeInsets.left - linkCard.safeInsets.right, 630)
    assert.equal(linkCard.safeInsets.left, linkCard.safeInsets.right)
})

test('placement lookup refuses unknown and inherited names', () => {
    assert.equal(getPlacement('story'), placements.story)
    assert.throws(() => getPlacement('billboard'), /unknown placement/)
    assert.throws(() => getPlacement('toString'), /unknown placement/)
})

test('even canvases render at half size and odd dimensions use scale one', () => {
    assert.equal(getRenderScale(placements.story), 2)
    assert.equal(getRenderScale({ width: 1001, height: 1500 }), 1)
    assert.equal(getRenderScale({ width: 1000, height: 1501 }), 1)
})

test('a manifest with accessible templates validates without browser dependencies', () => {
    const manifest = createManifest()
    assert.equal(validateManifest(manifest, { templateExists: (template) => template === 'templates/hook.html' }), manifest)
})

test('missing and blank alt text fail before rendering', () => {
    for (const alt of [undefined, '', '  ', 12]) assert.throws(() => validateManifest(createManifest({ alt })), /alt is required/)
})

test('unknown placements and missing templates are reported together', () => {
    assert.throws(() => validateManifest(createManifest({ placement: 'unknown', template: undefined })), (error) => /unknown placement/.test(error.message) && /missing template/.test(error.message))
    assert.throws(() => validateManifest(createManifest(), { templateExists: () => false }), /missing template: templates\/hook.html/)
})

test('invalid manifests, outputs and slot values fail validation', () => {
    for (const manifest of [null, {}, { brand: 'brand.json', shots: [] }]) assert.throws(() => validateManifest(manifest), /manifest requires/)
    assert.throws(() => validateManifest({ brand: 'brand.json', shots: [null] }), /must be an object/)
    assert.throws(() => validateManifest(createManifest({ out: 'hook.jpg' })), /local PNG/)
    assert.throws(() => validateManifest(createManifest({ vars: [] })), /vars must be an object/)
    assert.throws(() => validateManifest(createManifest({ vars: { headline: {} } })), /invalid slot/)
    assert.throws(() => validateManifest(createManifest({ vars: { image: 'https://example.com/art.png' } })), /local asset/)
    assert.throws(() => validateManifest(createManifest({ vars: { deviceFrame: 'true' } })), /must be boolean/)
})

test('duplicate output paths cannot silently discard a slide', () => {
    const manifest = createManifest()
    manifest.shots.push({ ...manifest.shots[0] })
    assert.throws(() => validateManifest(manifest), /duplicate output/)
})

test('output paths that resolve to the same file are duplicates', () => {
    const manifest = createManifest()
    manifest.shots.push({ ...manifest.shots[0], out: './out/../out/hook.png' })
    assert.throws(() => validateManifest(manifest), /duplicate output: .\/out\/..\/out\/hook.png/)
})

function createProjectWithManifestDirectory(context, { isGitRepository }) {
    const workDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'social-images-containment-')))
    context.after(() => rmSync(workDirectory, { recursive: true, force: true }))
    const projectRoot = join(workDirectory, 'project')
    const manifestDirectory = join(projectRoot, 'marketing', 'social')
    mkdirSync(manifestDirectory, { recursive: true })
    mkdirSync(join(projectRoot, 'assets'))
    mkdirSync(join(workDirectory, 'outside'))
    if (isGitRepository) execFileSync('git', ['init', '-q', projectRoot])
    return { workDirectory, projectRoot, manifestDirectory }
}

function writeTrackedFile(projectRoot, fileName, contents) {
    writeFileSync(join(projectRoot, fileName), contents)
    execFileSync('git', ['-C', projectRoot, 'add', '--', fileName])
}

test('a manifest inside a git worktree may reach sibling assets anywhere in that worktree', (context) => {
    const { projectRoot, manifestDirectory } = createProjectWithManifestDirectory(context, { isGitRepository: true })
    assert.equal(findProjectRoot(manifestDirectory), projectRoot)
    assert.equal(resolveInsideProjectRoot(manifestDirectory, '../../assets/art.webp'), join(projectRoot, 'assets/art.webp'))
    assert.equal(validateManifest(createManifest({ vars: { image: '../../assets/art.webp' } }), { manifestDirectory }).shots.length, 1)
})

test('paths that climb out of the git worktree fail validation', (context) => {
    const { manifestDirectory } = createProjectWithManifestDirectory(context, { isGitRepository: true })
    assert.throws(() => validateManifest({ ...createManifest(), brand: '../../../brand.json' }, { manifestDirectory }), /manifest requires/)
    assert.throws(() => validateManifest(createManifest({ template: '../../../templates/hook.html' }), { manifestDirectory }), /missing template/)
    assert.throws(() => validateManifest(createManifest({ out: 'out/../../../../hook.png' }), { manifestDirectory }), /local PNG/)
    assert.throws(() => validateManifest(createManifest({ vars: { image: '../../../outside/art.png' } }), { manifestDirectory }), /image must be a local asset/)
    assert.throws(() => validateManifest(createManifest({ vars: { logo: 'assets/../../../../logo.png' } }), { manifestDirectory }), /logo must be a local asset/)
})

test('outside a git repository the manifest directory is the containment root', (context) => {
    const { manifestDirectory } = createProjectWithManifestDirectory(context, { isGitRepository: false })
    assert.equal(findProjectRoot(manifestDirectory), manifestDirectory)
    assert.throws(() => resolveInsideProjectRoot(manifestDirectory, '../../assets/art.webp'), /escapes the project root/)
    assert.equal(resolveInsideProjectRoot(manifestDirectory, 'out/new/hook.png'), join(manifestDirectory, 'out/new/hook.png'))
})

test('a symlink inside the project cannot carry a path outside it', (context) => {
    const { workDirectory, projectRoot, manifestDirectory } = createProjectWithManifestDirectory(context, { isGitRepository: true })
    symlinkSync(join(workDirectory, 'outside'), join(projectRoot, 'escape'))
    assert.throws(() => resolveInsideProjectRoot(manifestDirectory, '../../escape/hook.png'), /escapes the project root/)
    assert.throws(() => resolveInsideProjectRoot(manifestDirectory, '/etc/passwd'), /must be local/)
})

test('a dangling symlink at an output path cannot plant a file outside the project', (context) => {
    const { workDirectory, manifestDirectory } = createProjectWithManifestDirectory(context, { isGitRepository: true })
    const outputDirectory = join(manifestDirectory, 'out')
    mkdirSync(outputDirectory)
    for (const fileName of ['hook.png', 'alt.json', 'preview.html']) symlinkSync(join(workDirectory, 'outside', `pwned-${fileName}`), join(outputDirectory, fileName))
    assert.throws(() => resolveInsideProjectRoot(manifestDirectory, 'out/hook.png'), /dangling symlink/)
    assert.throws(() => validateManifest(createManifest({ out: 'out/hook.png' }), { manifestDirectory }), /local PNG/)
    assert.throws(() => writeAltTextAndSheet(outputDirectory, { 'hook.png': 'New hook.' }, { sheetTitle: 'Social images' }), /refusing to write through symlink/)
    rmSync(join(outputDirectory, 'alt.json'))
    assert.throws(() => writeAltTextAndSheet(outputDirectory, { 'hook.png': 'New hook.' }, { sheetTitle: 'Social images' }), /refusing to write through symlink: .*preview\.html/)
    assert.deepEqual(readdirSync(join(workDirectory, 'outside')), [])
})

test('the contact sheet captions every image with its file name and escaped alt text', () => {
    const sheet = renderContactSheet({ 'a&b.png': 'Remi says <hi> & "bye"' }, 'Social <images>')
    assert.match(sheet, /<title>Social &#60;images&#62;<\/title>/)
    assert.match(sheet, /<img src="a%26b.png" alt="Remi says &#60;hi&#62; &#38; &#34;bye&#34;">/)
    assert.match(sheet, /<code>a&#38;b.png<\/code><p>Remi says &#60;hi&#62; &#38; &#34;bye&#34;<\/p>/)
    assert.doesNotMatch(sheet, /<hi>/)
})

test('alt text from an earlier run survives a later run into the same directory', (context) => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'social-images-alt-'))
    context.after(() => rmSync(outputDirectory, { recursive: true, force: true }))
    writeFileSync(join(outputDirectory, 'alt.json'), JSON.stringify({ 'old.png': 'Earlier slide.', 'hook.png': 'Stale hook.' }))
    writeAltTextAndSheet(outputDirectory, { 'hook.png': 'New hook.' }, { sheetTitle: 'Social images' })
    assert.deepEqual(JSON.parse(readFileSync(join(outputDirectory, 'alt.json'), 'utf8')), { 'old.png': 'Earlier slide.', 'hook.png': 'New hook.' })
    const sheet = readFileSync(join(outputDirectory, 'preview.html'), 'utf8')
    assert.match(sheet, /old\.png/)
    assert.match(sheet, /New hook\./)
})

test('a malformed alt.json is refused rather than overwritten', (context) => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'social-images-alt-'))
    context.after(() => rmSync(outputDirectory, { recursive: true, force: true }))
    writeFileSync(join(outputDirectory, 'alt.json'), '[]')
    assert.throws(() => writeAltTextAndSheet(outputDirectory, { 'hook.png': 'New hook.' }), /must hold an object/)
    assert.equal(readFileSync(join(outputDirectory, 'alt.json'), 'utf8'), '[]')
})

test('render arguments accept the documented flags and refuse anything else', () => {
    assert.deepEqual({ ...parseRenderArguments(['--manifest', 'm.json', '--sheet']) }, { manifest: 'm.json', sheet: true })
    for (const argumentList of [[], ['--manifest'], ['--manifest', 'm.json', '--sheet=yes'], ['--manifest', 'm.json', 'extra'], ['--manifest', 'm.json', '--publish']]) {
        assert.throws(() => parseRenderArguments(argumentList), /usage:/)
    }
})

test('PNG dimensions are parsed from a valid tiny PNG and a Uint8Array', () => {
    const png = createTinyPng()
    assert.deepEqual(parsePngSize(png), { width: 1, height: 1 })
    assert.deepEqual(parsePngSize(new Uint8Array(png)), { width: 1, height: 1 })
})

test('truncated headers, invalid signatures, missing IHDR and zero dimensions fail', () => {
    assert.throws(() => parsePngSize(Buffer.alloc(24)), /invalid PNG/)
    for (const offset of [0, 8, 12, 16]) {
        const bytes = createTinyPng()
        bytes[offset] = 0
        if (offset === 8) bytes.writeUInt32BE(12, 8)
        if (offset === 16) bytes.writeUInt32BE(0, 16)
        assert.throws(() => parsePngSize(bytes), /invalid PNG|positive/)
    }
})

test('wrong dimensions and excessive bytes produce separate violations', () => {
    const bytes = createTinyPng()
    const violations = buildPngViolations(bytes, { width: 1080, height: 1350, maxBytes: bytes.length - 1 }, 'hook.png')
    assert.equal(violations.length, 2)
    assert.match(violations[0], /hook.png: 1x1, expected 1080x1350/)
    assert.match(violations[1], /bytes exceeds/)
    assert.deepEqual(buildPngViolations(bytes, { width: 1, height: 1, maxBytes: bytes.length }), [])
    assert.equal(buildPngViolations(Buffer.alloc(50), { width: 1, height: 1, maxBytes: 49 }).length, 2)
})

test('the example brand builds palette, font and half-size placement tokens, with variable fonts set to regular weight', () => {
    const brand = JSON.parse(readFileSync(new URL('../templates/brand.example.json', import.meta.url), 'utf8'))
    const variables = buildCssVariables(brand, placements.story)
    assert.equal(variables['--brand-background'], '#f7f5ef')
    assert.equal(variables['--brand-accent-ink'], '#ffffff')
    assert.equal(variables['--brand-display-family'], '"Project Display"')
    assert.equal(variables['--brand-body-weight'], '400')
    assert.equal(variables['--canvas-width'], '540px')
    assert.equal(variables['--canvas-height'], '960px')
    assert.equal(variables['--safe-top'], '134.5px')
    assert.equal(variables['--safe-bottom'], '336px')
    assert.equal(variables['--min-text-size'], '16px')
})

test('neutral branding uses template defaults and scale one preserves output units', () => {
    assert.deepEqual(buildCssVariables({}, placements['link-card'], 1), {
        '--canvas-width': '1200px', '--canvas-height': '630px', '--min-text-size': '35px', '--safe-top': '0px', '--safe-right': '285px', '--safe-bottom': '0px', '--safe-left': '285px',
    })
})

test('brand validation rejects malformed font descriptors and nonlocal assets', () => {
    for (const brand of [null, [], { colors: [] }, { colors: { unknown: '#fff' } }, { colors: { ink: 'red;display:none' } }, { fonts: [] }, { fonts: { display: { family: 'Brand', files: [], weight: 400 } } }, { fonts: { body: { family: 'Brand', files: ['body.ttf'], weight: '900 100' } } }, { fonts: { body: { family: 'Brand', files: ['https://example.com/font.ttf'], weight: 400 } } }, { logo: 'https://example.com/logo.png' }]) {
        assert.throws(() => validateBrand(brand), /brand/)
    }
    assert.deepEqual(validateBrand({}), {})
})


test('new placements reserve crop margins and the YouTube duration band', () => {
    assert.deepEqual(placements.landscape.safeInsets, { top: 54, right: 96, bottom: 54, left: 96 })
    assert.deepEqual(placements['github-social-preview'].safeInsets, { top: 64, right: 96, bottom: 64, left: 96 })
    assert.deepEqual(placements['youtube-thumbnail'].safeInsets, { top: 43, right: 77, bottom: 120, left: 77 })
    for (const placement of ['landscape', 'github-social-preview', 'youtube-thumbnail']) assert.doesNotThrow(() => validateManifest(createManifest({ placement })))
})

test('list slots accept one through six nonempty strings and reject other arrays', () => {
    for (const items of [['<escaped>'], Array(6).fill('Feature')]) assert.doesNotThrow(() => validateManifest(createManifest({ vars: { items } })))
    for (const items of [[], Array(7).fill('Feature'), [''], ['  '], [1], ['Feature', null], [{}]]) {
        assert.throws(() => validateManifest(createManifest({ vars: { items } })), /1-6 nonempty strings/)
    }
})

test('carousel progress needs a valid slide pair even on a code CTA', () => {
    for (const slideNumber of [1, 5]) assert.doesNotThrow(() => validateManifest(createManifest({ template: 'templates/carousel.html', vars: { slideNumber, slideCount: 5 } })))
    for (const vars of [{}, { slideNumber: 0, slideCount: 5 }, { slideNumber: 6, slideCount: 5 }, { slideNumber: 1.5, slideCount: 5 }, { slideNumber: 1, slideCount: '5' }, { slideNumber: 1, slideCount: 21 }]) {
        assert.throws(() => validateManifest(createManifest({ template: 'templates/carousel.html', vars })), /slideNumber\/slideCount/)
    }
    assert.throws(() => validateManifest(createManifest({ vars: { slideNumber: 1 } })), /slideNumber\/slideCount/)
})

test('stat cards and charts require a source, their slot shapes and chart copy caps', () => {
    const statShot = { template: 'templates/stat.html', source: 'README.md, Supported agents', vars: { figure: '3', label: 'Named agent CLIs', context: 'Claude Code, Codex and Grok' } }
    assert.doesNotThrow(() => validateManifest(createManifest(statShot)))
    for (const source of [undefined, '', '  ', 3, {}]) assert.throws(() => validateManifest(createManifest({ ...statShot, source })), /source/)
    for (const name of ['figure', 'label', 'context']) assert.throws(() => validateManifest(createManifest({ ...statShot, vars: { ...statShot.vars, [name]: 3 } })), /nonempty string/)
    assert.throws(() => validateManifest(createManifest({ source: [] })), /source/)
    const chartShot = { template: 'templates/chart.html', source: 'harness/load-cost run at f9f5387d', vars: { headline: 'We lost. For now.', unit: 's', note: 'Their numbers from their published graphic.', series: ['glimmervoid', 't3code'], groups: [{ label: 'Cold connect', values: [39.7, 3.6] }, { label: 'Reconnect', values: [4.9, 1.3] }] } }
    assert.doesNotThrow(() => validateManifest(createManifest(chartShot)))
    assert.throws(() => validateManifest(createManifest({ ...chartShot, source: undefined })), /chart requires a cited repo source/)
    const rejectedChartVars = [
        [{ headline: 'We ran their exact benchmark on our own dashboard and lost' }, /headline exceeds 8 words/],
        [{ subline: 'Four hundred kilobits per second, four hundred milliseconds round trip, median of three runs' }, /subline exceeds 10 words/],
        [{ eyebrow: 'Benchmark' }, /refuses the eyebrow slot/],
        [{ items: ['Shell is uncompressed'] }, /refuses the items slot/],
        [{ series: ['glimmervoid', 't3code', 'old', 'older'] }, /1-3 series/],
        [{ groups: [{ label: 'Cold connect', values: [39.7] }] }, /one value per series/],
        [{ groups: [{ label: 'Cold connect', values: [-1, 3.6] }] }, /finite non-negative/],
        [{ groups: [{ label: 'Cold connect on a slow link', values: [39.7, 3.6] }] }, /label exceeds 3 words/],
    ]
    for (const [overrides, expectedError] of rejectedChartVars) assert.throws(() => validateManifest(createManifest({ ...chartShot, vars: { ...chartShot.vars, ...overrides } })), expectedError)
})

test('features and releases enforce their template slot shapes', () => {
    for (const items of [['Status', 'Terminals'], Array(4).fill('Feature')]) assert.doesNotThrow(() => validateManifest(createManifest({ template: 'templates/features.html', vars: { headline: 'Features', items } })))
    for (const items of [undefined, ['Only one'], Array(5).fill('Feature')]) assert.throws(() => validateManifest(createManifest({ template: 'templates/features.html', vars: { headline: 'Features', items } })), /2-4 items/)
    const releaseShot = { template: 'templates/release.html', vars: { version: '0.29.0', date: '2026-10-04', highlights: ['Session tasks'] } }
    assert.doesNotThrow(() => validateManifest(createManifest(releaseShot)))
    for (const name of ['version', 'date', 'highlights']) assert.throws(() => validateManifest(createManifest({ ...releaseShot, vars: { ...releaseShot.vars, [name]: undefined } })), /nonempty string|highlights/)
})

test('code ranges and explicit multiline commands validate before launching a browser', (context) => {
    const { projectRoot, manifestDirectory } = createProjectWithManifestDirectory(context, { isGitRepository: true })
    writeTrackedFile(projectRoot, 'README.md', `${Array(maxCodeLines).fill('line').join('\n')}\n`)
    const code = { file: '../../README.md', startLine: 1, endLine: maxCodeLines }
    assert.doesNotThrow(() => validateManifest(createManifest({ template: 'templates/code.html', vars: { code } }), { manifestDirectory }))
    assert.doesNotThrow(() => validateManifest(createManifest({ template: 'templates/code.html', vars: { command: 'npx glimmervoid' } })))
    for (const invalidCode of [null, 'README.md', { ...code, startLine: 0 }, { ...code, startLine: 1.5 }, { ...code, endLine: '2' }, { ...code, endLine: 0 }, { ...code, endLine: maxCodeLines + 1 }, { ...code, file: '/etc/passwd' }, { ...code, extra: true }]) {
        assert.throws(() => validateManifest(createManifest({ vars: { code: invalidCode } })), /code requires|line cap/)
    }
    for (const command of ['', ' ', 'first\rsecond', 12, []]) assert.throws(() => validateManifest(createManifest({ vars: { command } })), /nonempty string/)
    for (const command of ['npx \\\n  --allow-scripts=node-pty', 'first\r\nsecond', Array(12).fill('line').join('\n')]) assert.doesNotThrow(() => validateManifest(createManifest({ vars: { command } })))
    assert.throws(() => validateManifest(createManifest({ vars: { command: Array(13).fill('line').join('\n') } })), /12-line cap/)
    assert.throws(() => validateManifest(createManifest({ vars: { code, command: 'npx glimmervoid' } })), /not both/)
    assert.throws(() => validateManifest(createManifest({ template: 'templates/code.html' })), /requires code or command/)
})

test('release highlights accept escaped title/detail content and legacy strings but reject malformed objects', () => {
    for (const highlights of [[{ title: '<Workflows>', detail: 'Act on pull request events & notify.' }], ['Session tasks', { title: 'Stacks', detail: 'Follow dependent pull requests.' }]]) {
        assert.doesNotThrow(() => validateManifest(createManifest({ template: 'templates/release.html', vars: { version: '0.29.0', date: '2026-10-04', highlights } })))
    }
    for (const highlights of [[{}], [{ title: 'Title' }], [{ title: '', detail: 'Detail' }], [{ title: 'Title', detail: ' ' }], [{ title: 'Title', detail: 3 }], [{ title: 'Title', detail: 'Two\nlines' }], [{ title: 'Title', detail: 'Detail', extra: true }], Array(7).fill({ title: 'Title', detail: 'Detail' })]) {
        assert.throws(() => validateManifest(createManifest({ vars: { highlights } })), /highlights/)
    }
    assert.throws(() => validateManifest(createManifest({ vars: { items: [{ title: 'Title', detail: 'Detail' }] } })), /nonempty strings/)
})

test('image factors use output pixels and the actual object-fit dimensions', () => {
    const dimensions = { width: 400, height: 300, naturalWidth: 800, naturalHeight: 400, deviceScaleFactor: 2 }
    for (const [objectFit, expected] of Object.entries({ fill: 1.5, contain: 1, cover: 1.5, none: 2, 'scale-down': 1 })) {
        assert.equal(calculateImageUpscale({ ...dimensions, objectFit }), expected)
    }
    assert.equal(calculateImageUpscale({ ...dimensions, width: 800, height: 600, objectFit: 'scale-down' }), 2)
    assert.equal(calculateImageUpscale({ ...dimensions, objectFit: 'contain', transformScaleX: 2 }), 2)
    assert.equal(calculateImageUpscale({ ...dimensions, naturalWidth: 0 }), Infinity)
})

test('vector images never count as upscaled while raster images at the same size do', () => {
    const smallIntrinsicLogo = { width: 29, height: 29, naturalWidth: 24, naturalHeight: 24, deviceScaleFactor: 2, objectFit: 'contain' }
    assert.ok(calculateImageUpscale(smallIntrinsicLogo) > 2)
    assert.equal(calculateImageUpscale({ ...smallIntrinsicLogo, isVector: true }), 1)
    for (const source of ['file:///project/public/favicon.svg', 'file:///logo.SVG?v=2', 'file:///logo.svgz', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/svg+xml,%3Csvg%2F%3E']) assert.ok(isVectorImageSource(source), source)
    for (const source of ['file:///logo.png', 'file:///svg/logo.png', 'file:///logo.svg.png', 'data:image/png;base64,AAAA']) assert.equal(isVectorImageSource(source), false, source)
})

test('the old GIF rail crop fails while native and exact-limit captures pass', () => {
    const crop = { width: 448, height: 256, naturalWidth: 160, naturalHeight: 104, deviceScaleFactor: 2, objectFit: 'contain' }
    assert.ok(calculateImageUpscale(crop) > 4)
    assert.equal(calculateImageUpscale({ ...crop, width: 80, height: 52 }), 1)
    assert.equal(calculateImageUpscale({ ...crop, width: 100, height: 65 }), 1.25)
    assert.ok(calculateImageUpscale({ ...crop, width: 100.1, height: 65.1 }) > 1.25)
})

test('code fitting preserves short lines, shrinks the longest line and refuses a below-minimum fit', () => {
    const measurements = { lineWidths: [100, 400, 200], availableWidth: 320, fontSize: 20, minFontSize: 16 }
    assert.deepEqual(fitCodeFont(measurements), { fontSize: 16, fits: true })
    assert.deepEqual(fitCodeFont({ ...measurements, availableWidth: 480 }), { fontSize: 20, fits: true })
    assert.deepEqual(fitCodeFont({ ...measurements, availableWidth: 360 }), { fontSize: 18, fits: true })
    assert.deepEqual(fitCodeFont({ ...measurements, availableWidth: 319 }), { fontSize: 16, fits: false })
    assert.deepEqual(fitCodeFont({ ...measurements, lineWidths: [0] }), { fontSize: 20, fits: true })
    assert.equal(fitCodeFont({ ...measurements, availableWidth: 0 }).fits, false)
})

test('code excerpts preserve literal text, contain paths and reject missing or excessive ranges', (context) => {
    const { projectRoot, workDirectory, manifestDirectory } = createProjectWithManifestDirectory(context, { isGitRepository: true })
    writeTrackedFile(projectRoot, 'example.ts', 'const text = "<script>&"\r\nreturn text\r\n')
    const code = { file: '../../example.ts', startLine: 1, endLine: 2 }
    assert.equal(readCodeSlot(code, manifestDirectory), 'const text = "<script>&"\nreturn text')
    assert.equal(readCodeSlot({ ...code, startLine: 2 }, manifestDirectory), 'return text')
    assert.throws(() => readCodeSlot({ ...code, endLine: 3 }, manifestDirectory), /file length/)
    assert.throws(() => readCodeSlot({ ...code, endLine: maxCodeLines + 1 }, manifestDirectory), /line cap/)
    assert.throws(() => readCodeSlot({ ...code, file: '../../missing.ts' }, manifestDirectory), /tracked by git/)
    writeTrackedFile(projectRoot, 'blank.ts', '\n')
    assert.throws(() => readCodeSlot({ ...code, file: '../../blank.ts', endLine: 1 }, manifestDirectory), /must contain text/)
    symlinkSync(join(workDirectory, 'outside'), join(projectRoot, 'escape'))
    assert.throws(() => readCodeSlot({ ...code, file: '../../escape/example.ts' }, manifestDirectory), /local file/)
    assert.throws(() => validateManifest(createManifest({ vars: { code: { ...code, file: '../../../outside/example.ts' } } }), { manifestDirectory }), /local file/)
})

test('the visual code cap accepts twelve padded lines and rejects a thirteenth wrapped line', async () => {
    const codeElement = { textContent: 'A real code excerpt', scrollHeight: 0 }
    const page = {
        evaluate: (callback, parameters) => runInNewContext(`(${callback.toString()})(parameters)`, {
            parameters,
            document: {
                fonts: [], images: [], body: {},
                querySelectorAll: () => [codeElement],
                createTreeWalker: () => ({ nextNode: () => false }),
            },
            NodeFilter: { SHOW_TEXT: 4 },
            getComputedStyle: () => ({ lineHeight: '24px', paddingTop: '12px', paddingBottom: '12px' }),
        }),
    }
    codeElement.scrollHeight = 12 * 24 + 24
    assert.equal((await collectPageViolations(page, placements['instagram-portrait'], 2)).length, 0)
    codeElement.scrollHeight += 24
    assert.match((await collectPageViolations(page, placements['instagram-portrait'], 2))[0], /12-line cap after wrapping/)
})

test('code files must be git-tracked and never come from .git or untracked secrets', (context) => {
    const { projectRoot, manifestDirectory } = createProjectWithManifestDirectory(context, { isGitRepository: true })
    writeTrackedFile(projectRoot, 'tracked.ts', 'export const answer = 42\n')
    writeFileSync(join(projectRoot, '.env'), 'API_TOKEN=secret\n')
    const code = { file: '../../tracked.ts', startLine: 1, endLine: 1 }
    assert.equal(readCodeSlot(code, manifestDirectory), 'export const answer = 42')
    assert.throws(() => readCodeSlot({ ...code, file: '../../.env' }, manifestDirectory), /tracked by git/)
    assert.throws(() => readCodeSlot({ ...code, file: '../../.git/config' }, manifestDirectory), /under \.git/)
    assert.throws(() => validateManifest(createManifest({ vars: { code: { ...code, file: '../../.env' } } }), { manifestDirectory }), /tracked by git/)
})

test('outside a git repository code files may not be dotfiles', (context) => {
    const { manifestDirectory } = createProjectWithManifestDirectory(context, { isGitRepository: false })
    writeFileSync(join(manifestDirectory, 'example.ts'), 'const shown = true\n')
    writeFileSync(join(manifestDirectory, '.env'), 'API_TOKEN=secret\n')
    mkdirSync(join(manifestDirectory, '.config'))
    writeFileSync(join(manifestDirectory, '.config', 'settings.ts'), 'const hidden = true\n')
    const code = { file: 'example.ts', startLine: 1, endLine: 1 }
    assert.equal(readCodeSlot(code, manifestDirectory), 'const shown = true')
    for (const file of ['.env', '.config/settings.ts']) assert.throws(() => readCodeSlot({ ...code, file }, manifestDirectory), /dotfile/)
})

test('a renamed template copy keeps the rules of the kind it declares', () => {
    const declaredStat = '<!doctype html>\n<html lang="en" data-template="stat">'
    const statShot = { template: 'templates/launch-stat.html', vars: { figure: '3', label: 'Agents', context: 'Named CLIs' } }
    assert.throws(() => validateManifest(createManifest(statShot), { readTemplateSource: () => declaredStat }), /stat requires a cited repo source/)
    assert.doesNotThrow(() => validateManifest(createManifest(statShot)))
    assert.throws(() => validateManifest(createManifest({ template: 'templates/stat.html', vars: {} })), /stat requires a cited repo source/)
    assert.throws(() => validateManifest(createManifest(), { readTemplateSource: () => '<html data-template="poster">' }), /unknown template kind: poster/)
})

test('every shipped template declares the kind its file name names', () => {
    for (const kind of templateKinds) {
        const templateSource = readFileSync(new URL(`../templates/${kind}.html`, import.meta.url), 'utf8')
        assert.equal(readTemplateKind(templateSource, 'templates/renamed.html'), kind)
    }
    assert.equal(readTemplateKind('<html lang="en">', 'templates/custom.html'), undefined)
})

test('a brand mono font feeds code blocks while other roles stay rejected', () => {
    const brand = { fonts: { mono: { family: 'Brand Mono', files: ['fonts/mono.woff2'], weight: 400 } } }
    assert.equal(buildCssVariables(brand, placements.story)['--brand-mono-family'], '"Brand Mono"')
    assert.throws(() => validateBrand({ fonts: { code: brand.fonts.mono } }), /invalid brand font: code/)
    assert.throws(() => validateBrand({ fonts: { mono: { ...brand.fonts.mono, files: [] } } }), /invalid brand font: mono/)
    for (const templateName of ['code.html', 'carousel.html']) {
        const templateSource = readFileSync(new URL(`../templates/${templateName}`, import.meta.url), 'utf8')
        assert.match(templateSource, /pre \{[^}]*font-family: var\(--brand-mono-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace\)/)
    }
})

function createTextPageStub(textRectangle) {
    const paragraph = { tagName: 'P', parentElement: null }
    const textNode = { textContent: 'Copy pushed below the canvas', parentElement: paragraph }
    return {
        evaluate: (callback, parameters) => runInNewContext(`(${callback.toString()})(parameters)`, {
            parameters,
            innerWidth: 600,
            innerHeight: 315,
            document: {
                fonts: [], images: [], body: {},
                querySelectorAll: () => [],
                createTreeWalker: () => {
                    let hasVisitedText = false
                    const walker = { currentNode: null, nextNode: () => {
                        if (hasVisitedText) return false
                        hasVisitedText = true
                        walker.currentNode = textNode
                        return true
                    } }
                    return walker
                },
                createRange: () => ({ selectNodeContents: () => {}, getClientRects: () => [textRectangle] }),
            },
            NodeFilter: { SHOW_TEXT: 4 },
            getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1', contentVisibility: 'visible', fontSize: '20px' }),
        }),
    }
}

test('rendered text pushed entirely off the canvas, or on a copy-free placement, is reported rather than skipped', async () => {
    const insideCanvas = { left: 200, right: 400, top: 100, bottom: 120, width: 200, height: 20 }
    assert.equal((await collectPageViolations(createTextPageStub(insideCanvas), placements['link-card'], 2)).length, 0)
    const belowCanvas = { ...insideCanvas, top: 400, bottom: 420 }
    assert.match((await collectPageViolations(createTextPageStub(belowCanvas), placements['link-card'], 2))[0], /text outside safe insets: Copy pushed below the canvas/)
    const collapsedBox = { ...belowCanvas, width: 0, height: 0 }
    assert.equal((await collectPageViolations(createTextPageStub(collapsedBox), placements['link-card'], 2)).length, 0)
    assert.match((await collectPageViolations(createTextPageStub(insideCanvas), placements['x-article-cover'], 2))[0], /copy-free placement shows text; the platform prints the title: Copy pushed below the canvas/)
})

test('sources merge alongside alt text and stale sources disappear on replacement', (context) => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'social-images-sources-'))
    context.after(() => rmSync(outputDirectory, { recursive: true, force: true }))
    writeAltTextAndSheet(outputDirectory, { 'stat.png': 'Figure.', 'old.png': 'Old.' }, { renderedSourcesByFileName: { 'stat.png': 'README.md', 'old.png': 'PRODUCT.md' } })
    writeAltTextAndSheet(outputDirectory, { 'stat.png': 'Updated.' }, { renderedSourcesByFileName: { 'stat.png': 'CHANGELOG.md' } })
    assert.deepEqual(JSON.parse(readFileSync(join(outputDirectory, 'sources.json'), 'utf8')), { 'stat.png': 'CHANGELOG.md', 'old.png': 'PRODUCT.md' })
    writeAltTextAndSheet(outputDirectory, { 'stat.png': 'Now a hook.' })
    assert.deepEqual(JSON.parse(readFileSync(join(outputDirectory, 'sources.json'), 'utf8')), { 'old.png': 'PRODUCT.md' })
    assert.deepEqual(JSON.parse(readFileSync(join(outputDirectory, 'alt.json'), 'utf8')), { 'stat.png': 'Now a hook.', 'old.png': 'Old.' })
})

test('malformed and symlinked sources are refused before metadata is overwritten', (context) => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'social-images-sources-'))
    context.after(() => rmSync(outputDirectory, { recursive: true, force: true }))
    writeFileSync(join(outputDirectory, 'alt.json'), '{"old.png":"Earlier"}')
    writeFileSync(join(outputDirectory, 'sources.json'), '[]')
    assert.throws(() => writeAltTextAndSheet(outputDirectory, { 'new.png': 'New' }), /must hold an object/)
    assert.equal(readFileSync(join(outputDirectory, 'alt.json'), 'utf8'), '{"old.png":"Earlier"}')
    rmSync(join(outputDirectory, 'sources.json'))
    const targetPath = join(outputDirectory, 'untouched.json')
    symlinkSync(targetPath, join(outputDirectory, 'sources.json'))
    assert.throws(() => writeAltTextAndSheet(outputDirectory, { 'new.png': 'New' }), /refusing to write through symlink/)
    assert.equal(readFileSync(join(outputDirectory, 'alt.json'), 'utf8'), '{"old.png":"Earlier"}')
    writeFileSync(targetPath, '{}')
    assert.throws(() => writeAltTextAndSheet(outputDirectory, { 'new.png': 'New' }), /refusing to write through symlink/)
    assert.equal(readFileSync(targetPath, 'utf8'), '{}')
})
