import assert from 'node:assert/strict'
import { sep } from 'node:path'
import { test } from 'node:test'
import { getClipViewport, planClipFrames, resolveHarnessFile } from '../scripts/record-clip.mjs'
import { getPlacement } from '../scripts/render.mjs'
import { buildSharePage } from '../scripts/share-page.mjs'

test('the viewport lays out at the CSS width and reaches placement pixels through device scale', () => {
    assert.deepEqual(getClipViewport(getPlacement('instagram-square'), 480), { width: 480, height: 480, deviceScaleFactor: 2.25 })
    assert.throws(() => getClipViewport(getPlacement('instagram-portrait'), 481), /whole CSS height/)
})

test('frames run on one clip timeline with each scene starting once and reviewed at its midpoint', () => {
    const frames = planClipFrames([{ run: 'first()', durationMs: 100 }, { run: 'second()', durationMs: 50 }], 20)
    assert.deepEqual(frames.map((frame) => frame.clipTimeMs), [0, 50, 100])
    assert.deepEqual(frames.map((frame) => frame.sceneIndex), [0, 0, 1])
    assert.deepEqual(frames.map((frame) => frame.startsScene), [true, false, true])
    assert.deepEqual(frames.map((frame) => frame.isReviewFrame), [false, true, true])
})

test('the harness server refuses request paths that climb out of the harness', () => {
    assert.equal(resolveHarnessFile(`${sep}srv${sep}harness`, '/'), `${sep}srv${sep}harness${sep}index.html`)
    assert.equal(resolveHarnessFile(`${sep}srv${sep}harness`, '/fonts/body.woff2?v=1'), `${sep}srv${sep}harness${sep}fonts${sep}body.woff2`)
    assert.equal(resolveHarnessFile(`${sep}srv${sep}harness`, '/..%2f..%2fetc/passwd'), null)
    assert.equal(resolveHarnessFile(`${sep}srv${sep}harness`, '/%E0%A4%A'), null)
    assert.equal(resolveHarnessFile(`${sep}srv${sep}harness`, '/a%00b.png'), null)
})

test('share page caption and title markup is escaped rather than rendered', () => {
    const page = buildSharePage({ title: 'Clip <b>', clipFileName: 'a</script><img src=x>.mp4', clipBytes: Buffer.from('not really a video'), captions: [{ label: 'X & <LinkedIn>', text: '</pre><script>alert(1)</script>' }] })
    assert.ok(page.includes('const clipFileName = "a\\u003c/script>\\u003cimg src=x>.mp4";'))
    assert.ok(page.includes('&#60;/pre&#62;&#60;script&#62;alert(1)&#60;/script&#62;'))
    assert.ok(page.includes('X &#38; &#60;LinkedIn&#62;'))
    assert.ok(page.startsWith('<title>Clip &#60;b&#62;</title>'))
    assert.doesNotMatch(page, /<script>alert/)
})
