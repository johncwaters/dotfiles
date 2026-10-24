import { execFileSync } from 'node:child_process'
import { closeSync, constants as fileSystemConstants, existsSync, lstatSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const placements = Object.freeze({
    'instagram-portrait': { width: 1080, height: 1350, safeInsets: { top: 81, right: 65, bottom: 81, left: 65 }, maxBytes: 1_000_000, minTextPx: 32 },
    'instagram-square': { width: 1080, height: 1080, safeInsets: { top: 65, right: 65, bottom: 65, left: 65 }, maxBytes: 1_000_000, minTextPx: 32 },
    story: { width: 1080, height: 1920, safeInsets: { top: 269, right: 65, bottom: 672, left: 65 }, maxBytes: 1_000_000, minTextPx: 32 },
    'link-card': { width: 1200, height: 630, safeInsets: { top: 0, right: 285, bottom: 0, left: 285 }, maxBytes: 1_000_000, minTextPx: 35 },
    'x-card': { width: 1200, height: 600, safeInsets: { top: 36, right: 72, bottom: 36, left: 72 }, maxBytes: 1_000_000, minTextPx: 35 },
    landscape: { width: 1600, height: 900, safeInsets: { top: 54, right: 96, bottom: 54, left: 96 }, maxBytes: 1_000_000, minTextPx: 40 },
    'github-social-preview': { width: 1280, height: 640, safeInsets: { top: 64, right: 96, bottom: 64, left: 96 }, maxBytes: 1_000_000, minTextPx: 35 },
    'youtube-thumbnail': { width: 1280, height: 720, safeInsets: { top: 43, right: 77, bottom: 120, left: 77 }, maxBytes: 1_000_000, minTextPx: 35 },
    pinterest: { width: 1000, height: 1500, safeInsets: { top: 90, right: 60, bottom: 90, left: 60 }, maxBytes: 1_000_000, minTextPx: 29 },
})

export function getPlacement(name) {
    if (!Object.hasOwn(placements, name)) {
        throw new Error(`unknown placement: ${name}`)
    }
    return placements[name]
}

export function isNonemptyString(value) {
    return typeof value === 'string' && value.trim().length > 0
}

export function isLocalPath(value) {
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
const gitWorktreeRoots = new Set()

export function isGitWorktreeRoot(projectRoot) {
    return gitWorktreeRoots.has(projectRoot)
}

export function findProjectRoot(manifestDirectory) {
    const resolvedManifestDirectory = resolveThroughExistingAncestor(resolve(manifestDirectory))
    if (projectRootByManifestDirectory.has(resolvedManifestDirectory)) return projectRootByManifestDirectory.get(resolvedManifestDirectory)
    let projectRoot = resolvedManifestDirectory
    try {
        const worktreeTopLevel = execFileSync('git', ['-C', resolvedManifestDirectory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        if (worktreeTopLevel) {
            projectRoot = realpathSync(worktreeTopLevel)
            gitWorktreeRoots.add(projectRoot)
        }
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

export function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)
}

export function writeFileRefusingSymlink(filePath, contents) {
    if (lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${filePath}`)
    const fileDescriptor = openSync(filePath, fileSystemConstants.O_WRONLY | fileSystemConstants.O_CREAT | fileSystemConstants.O_TRUNC | fileSystemConstants.O_NOFOLLOW, 0o644)
    try {
        writeFileSync(fileDescriptor, contents)
    } finally {
        closeSync(fileDescriptor)
    }
}
