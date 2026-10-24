import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { arch, homedir } from 'node:os'
import { join } from 'node:path'

export function parseFlags(argumentList) {
    const flags = {}
    for (let index = 0; index < argumentList.length; index++) {
        const argument = argumentList[index]
        if (!argument.startsWith('--')) {
            throw new Error(`unexpected argument: ${argument}`)
        }
        const next = argumentList[index + 1]
        if (next === undefined || next.startsWith('--')) {
            flags[argument.slice(2)] = true
            continue
        }
        flags[argument.slice(2)] = next
        index++
    }
    return flags
}

export function requireFlags(flags, names) {
    const missing = names.filter((name) => flags[name] === undefined)
    if (missing.length) {
        throw new Error(`missing --${missing.join(', --')}`)
    }
}

const googleChromeLinuxPath = '/opt/google/chrome/chrome'
const playwrightCacheDirectory = join(homedir(), '.cache', 'ms-playwright')
const headlessShellLibraryDirectory = join(homedir(), '.cache', 'evidence-chrome-libs')

const headlessShellDirectoryNameByArchitecture = {
    arm64: 'chrome-headless-shell-linux-arm64',
    x64: 'chrome-headless-shell-linux64',
}

function newestHeadlessShellPath(cacheDirectory, architecture) {
    if (!existsSync(cacheDirectory)) {
        return null
    }
    const revisions = readdirSync(cacheDirectory)
        .filter((entry) => entry.startsWith('chromium_headless_shell-'))
        .sort((left, right) => Number(right.split('-')[1]) - Number(left.split('-')[1]))
    const candidatePaths = revisions.map((revision) =>
        join(cacheDirectory, revision, headlessShellDirectoryNameByArchitecture[architecture], 'chrome-headless-shell')
    )
    return candidatePaths.find((candidatePath) => existsSync(candidatePath)) ?? null
}

function listMissingSharedLibraries(executablePath) {
    const lddOutput = execFileSync('ldd', [executablePath], {
        encoding: 'utf8',
        env: { ...process.env, LD_LIBRARY_PATH: headlessShellLibraryDirectory },
    })
    return [...lddOutput.matchAll(/^\s*(\S+) => not found$/gm)].map((match) => match[1])
}

function findNixLibrary(libraryName) {
    const matchPaths = execFileSync('find', ['/nix/store', '-maxdepth', '3', '-name', libraryName], { encoding: 'utf8' })
        .split('\n')
        .filter((matchPath) => matchPath && !matchPath.includes('-dev/'))
    return matchPaths[0] ?? null
}

function buildGbmStub(executablePath) {
    const gbmSymbols = execFileSync('nm', ['-D', '--undefined-only', executablePath], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().split(/\s+/).pop()?.split('@')[0])
        .filter((symbol) => symbol?.startsWith('gbm_'))
    const stubSourcePath = join(headlessShellLibraryDirectory, 'gbm-stub.c')
    const stubSource = [...new Set(gbmSymbols)].map((symbol) => `void *${symbol}(void){return 0;}`).join('\n')
    writeFileSync(stubSourcePath, stubSource)
    execFileSync('gcc', ['-shared', '-fPIC', '-o', join(headlessShellLibraryDirectory, 'libgbm.so.1'), stubSourcePath])
}

function prepareHeadlessShellLibraries(executablePath) {
    mkdirSync(headlessShellLibraryDirectory, { recursive: true })
    for (const libraryName of listMissingSharedLibraries(executablePath)) {
        if (libraryName === 'libgbm.so.1') {
            buildGbmStub(executablePath)
            continue
        }
        const nixLibraryPath = findNixLibrary(libraryName)
        if (!nixLibraryPath) {
            continue
        }
        const linkPath = join(headlessShellLibraryDirectory, libraryName)
        rmSync(linkPath, { force: true })
        symlinkSync(nixLibraryPath, linkPath)
    }
    const stillMissing = listMissingSharedLibraries(executablePath)
    if (stillMissing.length) {
        throw new Error(`chrome-headless-shell still lacks: ${stillMissing.join(', ')}`)
    }
}

export function chromeLaunchOptions() {
    if (process.platform !== 'linux' || existsSync(googleChromeLinuxPath)) {
        return { channel: 'chrome' }
    }
    const headlessShellPath = newestHeadlessShellPath(playwrightCacheDirectory, arch() === 'arm64' ? 'arm64' : 'x64')
    if (!headlessShellPath) {
        throw new Error('no Google Chrome or chrome-headless-shell: run `npx playwright-core install --only-shell chromium`')
    }
    prepareHeadlessShellLibraries(headlessShellPath)
    return {
        executablePath: headlessShellPath,
        env: { ...process.env, LD_LIBRARY_PATH: headlessShellLibraryDirectory },
    }
}

export async function launchCaptureBrowser(chromium) {
    const options = { headless: true, args: ['--force-color-profile=srgb'] }
    try {
        return await chromium.launch({ ...options, channel: 'chrome' })
    } catch (error) {
        if (!/distribution 'chrome' is not found|Executable doesn't exist/i.test(error.message)) throw error
        return chromium.launch(options)
    }
}
