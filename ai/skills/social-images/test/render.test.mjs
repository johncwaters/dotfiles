import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { buildCssVariables, buildPngViolations, getPlacement, getRenderScale, parsePngSize, parseRenderArguments, placements, findProjectRoot, renderContactSheet, resolveInsideProjectRoot, validateBrand, validateManifest, writeAltTextAndSheet } from '../scripts/render.mjs'

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

test('the placement table contains exactly the requested social canvases', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(placements).map(([name, placement]) => [name, [placement.width, placement.height]])), {
        'instagram-portrait': [1080, 1350], 'instagram-square': [1080, 1080], story: [1080, 1920], 'link-card': [1200, 630], 'x-card': [1200, 600], pinterest: [1000, 1500],
    })
    for (const placement of Object.values(placements)) {
        assert.ok(Object.values(placement.safeInsets).every((inset) => Number.isInteger(inset) && inset >= 0))
        assert.ok(placement.safeInsets.left + placement.safeInsets.right < placement.width)
        assert.ok(placement.safeInsets.top + placement.safeInsets.bottom < placement.height)
        assert.ok(placement.minTextPx > 0)
        assert.equal(placement.maxBytes, 1_000_000)
    }
})

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
