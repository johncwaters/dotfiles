import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const framesScript = new URL('../scripts/frames.mjs', import.meta.url).pathname
const loopSeconds = 6

function readDurationSeconds(audioPath) {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath], { encoding: 'utf8' }))
}

test('mix keeps the silence before a head-trimmed cue that starts after zero', () => {
    const workDirectory = mkdtempSync(join(tmpdir(), 'animating-mix-test-'))
    try {
        const tonePath = join(workDirectory, 'tone.wav')
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', tonePath])
        const pagePath = join(workDirectory, 'page.html')
        writeFileSync(pagePath, `<!DOCTYPE html><html><body><script>const TIMELINE = { cue: 2.4 }; const totalSeconds = ${loopSeconds}; function realTimeAt(storySeconds) { return storySeconds } function renderAt() {}</script></body></html>`)
        const sheetPath = join(workDirectory, 'cues.json')
        writeFileSync(sheetPath, JSON.stringify({ soundLevel: 1, sounds: [{ clip: tonePath, at: 'TIMELINE.cue', clipAt: 1, notBefore: 'TIMELINE.cue - 0.5', level: 0.5 }] }))
        const mixPath = join(workDirectory, 'mix.wav')
        execFileSync('node', [framesScript, 'mix', '--page', pagePath, '--sheet', sheetPath, '--out', mixPath], { stdio: 'ignore' })
        assert.ok(Math.abs(readDurationSeconds(mixPath) - loopSeconds) < 0.05)
    } finally {
        rmSync(workDirectory, { recursive: true, force: true })
    }
})
