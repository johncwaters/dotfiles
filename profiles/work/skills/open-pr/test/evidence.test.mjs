import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
    listAreas,
    parseFlags,
    parseShotName,
    parseUploadedMarkdown,
    renderContactSheet,
    renderGridMarkdown,
    shotFileName,
} from '../scripts/evidence.mjs'

const allShots = (area) =>
    ['before', 'after'].flatMap((state) =>
        ['light', 'dark'].flatMap((mode) =>
            ['narrow', 'wide'].map((width) => shotFileName({ state, area, mode, width }))
        )
    )

test('a shot file name round-trips through the parser', () => {
    const shot = { state: 'after', area: 'session-replay', mode: 'dark', width: 'narrow' }
    assert.deepEqual(parseShotName(shotFileName(shot)), shot)
})

test('a file outside the naming scheme parses to null', () => {
    assert.equal(parseShotName('after-session-replay-motion.gif'), null)
    assert.equal(parseShotName('peek.png'), null)
})

test('areas are listed once each in first-seen order', () => {
    const fileNames = [...allShots('session-replay'), ...allShots('ai-observability'), 'preview.html']
    assert.deepEqual(listAreas(fileNames), ['session-replay', 'ai-observability'])
})

test('the contact sheet flags a missing cell instead of leaving it blank', () => {
    const fileNames = allShots('nav').filter((fileName) => fileName !== 'before-nav-dark-wide.png')
    const html = renderContactSheet(fileNames, 'PR 1')
    assert.match(html, /missing: before-nav-dark-wide\.png/)
    assert.equal((html.match(/<img /g) ?? []).length, 7)
})

test('the contact sheet shows a gif and off-grid frames under other files', () => {
    const html = renderContactSheet([...allShots('nav'), 'after-nav-motion.gif', 'after-nav-motion-frame8.png'], 'PR 1')
    assert.match(html, /<h2>Other files<\/h2>/)
    assert.match(html, /<img src="after-nav-motion\.gif"/)
    assert.match(html, /<img src="after-nav-motion-frame8\.png"/)
})

test('uploaded markdown maps each alt stem to its URL', () => {
    const markdown = '![before-nav-light-narrow](https://raw.githubusercontent.com/PostHog/pr-assets/abc/1.png)\n![after-nav-light-narrow](https://raw.githubusercontent.com/PostHog/pr-assets/abc/2.png)\n'
    const urlsByStem = parseUploadedMarkdown(markdown)
    assert.equal(urlsByStem.get('after-nav-light-narrow'), 'https://raw.githubusercontent.com/PostHog/pr-assets/abc/2.png')
})

test('the grid markdown has four state rows with before then after', () => {
    const urlsByStem = new Map(allShots('nav').map((fileName) => [fileName.replace('.png', ''), `https://x/${fileName}`]))
    const markdown = renderGridMarkdown('nav', urlsByStem, 'Navigation bar')
    const rows = markdown.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| State'))
    assert.equal(rows.length, 4)
    assert.match(rows[0], /^\| Light, narrow window \| .*before-nav-light-narrow.* \| .*after-nav-light-narrow.* \|$/)
    assert.match(markdown, /^#### Navigation bar$/m)
})

test('the grid markdown refuses to render with an upload missing', () => {
    assert.throws(() => renderGridMarkdown('nav', new Map(), 'Navigation bar'), /no uploaded URL for before-nav-light-narrow/)
})

test('flags parse values and bare switches', () => {
    assert.deepEqual(parseFlags(['--url', 'http://localhost:8021/', '--yes', '--area', 'nav']), {
        url: 'http://localhost:8021/',
        yes: true,
        area: 'nav',
    })
    assert.throws(() => parseFlags(['stray']), /unexpected argument: stray/)
})
