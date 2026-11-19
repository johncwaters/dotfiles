import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nearestExistingDirectory } from "./hook-io.mjs";

const sharedOwnedListPath = path.join(import.meta.dirname, "..", "owned-repos.txt");

export function ownedListPath() {
  if (process.env.DOTFILES_OWNED_REPOS_FILE) return process.env.DOTFILES_OWNED_REPOS_FILE;
  const profileOwnedListPath = path.join(os.homedir(), ".claude", "owned-repos.txt");
  return fs.existsSync(profileOwnedListPath) ? profileOwnedListPath : sharedOwnedListPath;
}

export function readOwnedEntries(listPath = ownedListPath()) {
  let listText;
  try {
    listText = fs.readFileSync(listPath, "utf8");
  } catch {
    return [];
  }
  return listText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) return { remote: line };
      return { remote: line.slice(0, separatorIndex), pathGlob: line.slice(separatorIndex + 1) };
    });
}

function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      pattern += ".*";
      index++;
      continue;
    }
    if (character === "*") {
      pattern += "[^/]*";
      continue;
    }
    pattern += character.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

const URL_REMOTE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i;
const SCP_REMOTE_PATTERN = /^(?:[^@/]*@)?([^/:]+):(?!\/\/)(.+)$/;

function resolveSshHostAlias(host) {
  const sshConfig = spawnSync("ssh", ["-G", host], { encoding: "utf8", timeout: 2000 });
  const hostnameLine = sshConfig.status === 0 ? sshConfig.stdout.split("\n").find((line) => line.startsWith("hostname ")) : null;
  return hostnameLine ? hostnameLine.slice("hostname ".length).trim() : host;
}

export function normalizeRemote(remoteUrl) {
  const trimmedUrl = remoteUrl.trim();
  const urlMatch = URL_REMOTE_PATTERN.exec(trimmedUrl);
  const scpMatch = urlMatch ? null : SCP_REMOTE_PATTERN.exec(trimmedUrl);
  const match = urlMatch ?? scpMatch;
  if (!match) return null;
  const isSshForm = Boolean(scpMatch) || /^ssh:/i.test(trimmedUrl);
  const host = isSshForm ? resolveSshHostAlias(match[1]) : match[1];
  const repositoryPath = match[2].replace(/\/+$/, "").replace(/\.git$/, "");
  if (!/^[^/]+\/[^/]+$/.test(repositoryPath)) return null;
  return `${host.toLowerCase()}/${repositoryPath}`;
}

function runGit(directory, args) {
  const gitRun = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 2000 });
  return gitRun.status === 0 ? gitRun.stdout.trim() : null;
}

function readRepository(absolutePath) {
  const isExistingDirectory = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory();
  const directory = isExistingDirectory ? absolutePath : nearestExistingDirectory(absolutePath);
  const remoteUrl = runGit(directory, ["remote", "get-url", "origin"]);
  const remote = remoteUrl && normalizeRemote(remoteUrl);
  const directoryPrefix = remote && runGit(directory, ["rev-parse", "--show-prefix"]);
  if (directoryPrefix === null || !remote) return null;
  const pathInRepository = path.posix.join(directoryPrefix, path.relative(directory, absolutePath).split(path.sep).join("/"));
  return { remote, pathInRepository: pathInRepository.replace(/\/$/, "") };
}

function remoteMatches(entryRemote, remote) {
  return globToRegExp(entryRemote.toLowerCase()).test(remote.toLowerCase());
}

export function isPathOwned(absolutePath, entries = readOwnedEntries()) {
  const repository = readRepository(absolutePath);
  if (!repository) return false;
  return entries.some((entry) => {
    if (!remoteMatches(entry.remote, repository.remote)) return false;
    if (!entry.pathGlob) return true;
    const ownedRoot = entry.pathGlob.replace(/\/\*\*$/, "");
    return repository.pathInRepository === ownedRoot || globToRegExp(entry.pathGlob).test(repository.pathInRepository);
  });
}

export function describeSessionOwnership(workingDirectory, entries = readOwnedEntries()) {
  if (runGit(workingDirectory, ["rev-parse", "--show-toplevel"]) === null) return null;
  const repository = readRepository(workingDirectory);
  if (!repository) return { ownership: "foreign", ownedPaths: [] };
  const matchingEntries = entries.filter((entry) => remoteMatches(entry.remote, repository.remote));
  if (matchingEntries.some((entry) => !entry.pathGlob)) return { ownership: "owned", ownedPaths: [] };
  return { ownership: "foreign", ownedPaths: matchingEntries.map((entry) => entry.pathGlob) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  const targetPath = path.resolve(process.argv[2] ?? process.cwd());
  process.stdout.write(`${isPathOwned(targetPath) ? "owned" : "foreign"}\n`);
}
