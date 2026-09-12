#!/usr/bin/env node
// Enforces the ROUTING.md rule that Fable sessions delegate after three direct tool calls per turn.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  allow,
  denyPreToolUse,
  DIRECT_WORK_TOOLS,
  readPayload,
} from "./hook-io.mjs";

const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 4 * 1024 * 1024;
const DIRECT_TOOL_BUDGET = 3;
const QUOTE_CHARACTER = /['"]/g;
const DISPATCH_COMMAND = /(?:^|[\s;&|(])(?:codex\s+exec|grok)\b/;
const COMMAND_SEGMENT_SEPARATOR = /\n|;|&&|\|\||\||\(|\)/;
const COMMAND_TOKEN_SEPARATOR = /\s+/;
const COMMIT_WORKFLOW_INTERPRETERS = new Set(["bun", "node"]);
const COMMIT_WORKFLOW_SCRIPT_PATHS = ["skills/commit/preflight.ts", "skills/commit/land.ts"];
const ENVIRONMENT_ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HEREDOC_OPERATOR = "<<";

function basenameOf(token) {
  return token.slice(token.lastIndexOf("/") + 1);
}

function isCommitWorkflowSegment(commandSegment) {
  const segmentTokens = commandSegment.trim().split(COMMAND_TOKEN_SEPARATOR);
  const invocationStartIndex = segmentTokens.findIndex(
    (segmentToken) => !ENVIRONMENT_ASSIGNMENT_TOKEN.test(segmentToken),
  );
  if (invocationStartIndex < 0) return false;
  const [interpreterToken, scriptToken] = segmentTokens.slice(invocationStartIndex);
  if (!COMMIT_WORKFLOW_INTERPRETERS.has(basenameOf(interpreterToken))) return false;
  if (typeof scriptToken !== "string") return false;
  return COMMIT_WORKFLOW_SCRIPT_PATHS.some((scriptPath) => scriptToken.endsWith(scriptPath));
}

function isDirectoryChangeSegment(commandSegment) {
  return commandSegment.split(COMMAND_TOKEN_SEPARATOR)[0] === "cd";
}

function withoutHeredocBody(command) {
  const commandLines = command.split("\n");
  const heredocOpenerIndex = commandLines.findIndex((commandLine) =>
    commandLine.includes(HEREDOC_OPERATOR),
  );
  if (heredocOpenerIndex < 0) return command;
  return commandLines.slice(0, heredocOpenerIndex + 1).join("\n");
}

function isCommitWorkflowCommand(command) {
  const commandSegments = withoutHeredocBody(command)
    .split(COMMAND_SEGMENT_SEPARATOR)
    .map((commandSegment) => commandSegment.trim())
    .filter((commandSegment) => commandSegment !== "");
  if (commandSegments.length === 0) return false;
  if (!isCommitWorkflowSegment(commandSegments.at(-1))) return false;
  return commandSegments.slice(0, -1).every(isDirectoryChangeSegment);
}

function isExemptBash(toolName, toolInput) {
  if (toolName !== "Bash") return false;
  if (!toolInput || typeof toolInput !== "object") return false;
  if (typeof toolInput.command !== "string") return false;
  const commandWithoutQuoteCharacters = toolInput.command.replace(QUOTE_CHARACTER, "");
  if (DISPATCH_COMMAND.test(commandWithoutQuoteCharacters)) return true;
  return isCommitWorkflowCommand(commandWithoutQuoteCharacters);
}

function isCountedToolUse(contentBlock) {
  if (!contentBlock || typeof contentBlock !== "object") return false;
  if (contentBlock.type !== "tool_use") return false;
  if (!DIRECT_WORK_TOOLS.has(contentBlock.name)) return false;
  return !isExemptBash(contentBlock.name, contentBlock.input);
}

function denyForBudget(priorCalls) {
  denyPreToolUse(
    `Fable direct-tool budget exceeded: ${priorCalls} prior calls; budget is ${DIRECT_TOOL_BUDGET}.\n` +
      "Dispatch per ROUTING.md: Codex for coding, Explore for reads; Agent, Skill, Workflow, `codex exec`/`grok` Bash dispatches, and the commit skill's preflight.ts and land.ts steps are not counted.",
  );
}

function isTypedPrompt(transcriptEntry, payload) {
  if (transcriptEntry.promptId !== payload.prompt_id) return false;
  if (typeof transcriptEntry.promptSource !== "string") return false;
  if (transcriptEntry.isMeta === true) return false;
  if (!transcriptEntry.message || typeof transcriptEntry.message !== "object") return false;
  const { content } = transcriptEntry.message;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return !content.some((contentBlock) => contentBlock?.type === "tool_result");
}

function enforceFromTranscript(payload) {
  let priorCalls = 0;
  let callsRecordedAfterCurrent = 0;
  let isCurrentCallRecorded = false;
  let isSessionModelKnown = false;

  function denyIfBudgetSpent(spentCalls) {
    if (spentCalls >= DIRECT_TOOL_BUDGET) denyForBudget(spentCalls);
  }

  function finishDecision() {
    if (!isSessionModelKnown) allow();
    denyIfBudgetSpent(isCurrentCallRecorded ? priorCalls : callsRecordedAfterCurrent);
    allow();
  }

  function inspectLine(line) {
    const transcriptEntry = JSON.parse(line);
    if (!transcriptEntry || typeof transcriptEntry !== "object") allow();

    if (transcriptEntry.type === "user") {
      if (
        typeof transcriptEntry.promptId === "string" &&
        transcriptEntry.promptId !== payload.prompt_id
      )
        finishDecision();
      if (isTypedPrompt(transcriptEntry, payload)) finishDecision();
      return;
    }

    if (transcriptEntry.type !== "assistant") return;
    if (!transcriptEntry.message || typeof transcriptEntry.message !== "object") allow();

    if (!isSessionModelKnown) {
      if (typeof transcriptEntry.message.model !== "string") allow();
      isSessionModelKnown = true;
      if (!/fable/i.test(transcriptEntry.message.model)) allow();
    }

    const recordedBlocks = transcriptEntry.message.content;
    if (!Array.isArray(recordedBlocks)) allow();
    for (let blockIndex = recordedBlocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const contentBlock = recordedBlocks[blockIndex];
      if (contentBlock?.type === "tool_use" && contentBlock.id === payload.tool_use_id) {
        isCurrentCallRecorded = true;
        continue;
      }
      if (!isCountedToolUse(contentBlock)) continue;
      if (!isCurrentCallRecorded) {
        callsRecordedAfterCurrent += 1;
        continue;
      }
      priorCalls += 1;
      denyIfBudgetSpent(priorCalls);
    }
  }

  const transcriptDescriptor = openSync(payload.transcript_path, "r");
  try {
    const transcriptSizeBytes = fstatSync(transcriptDescriptor).size;
    let unreadEndOffset = transcriptSizeBytes;
    let scannedBytes = 0;
    let incompleteLine = Buffer.alloc(0);

    while (unreadEndOffset > 0 && scannedBytes < MAX_TRANSCRIPT_SCAN_BYTES) {
      const isTranscriptEnd = unreadEndOffset === transcriptSizeBytes;
      const chunkBytes = Math.min(
        TRANSCRIPT_CHUNK_BYTES,
        unreadEndOffset,
        MAX_TRANSCRIPT_SCAN_BYTES - scannedBytes,
      );
      const chunkStartOffset = unreadEndOffset - chunkBytes;
      const transcriptChunk = Buffer.allocUnsafe(chunkBytes);
      const bytesRead = readSync(
        transcriptDescriptor,
        transcriptChunk,
        0,
        chunkBytes,
        chunkStartOffset,
      );
      if (bytesRead !== chunkBytes) allow();

      unreadEndOffset = chunkStartOffset;
      scannedBytes += bytesRead;
      const transcriptTail =
        incompleteLine.length > 0
          ? Buffer.concat([transcriptChunk, incompleteLine])
          : transcriptChunk;
      const firstNewlineOffset = transcriptTail.indexOf(0x0a);
      if (firstNewlineOffset < 0 && unreadEndOffset > 0) {
        incompleteLine = transcriptTail;
        continue;
      }

      const completeLinesStartOffset = unreadEndOffset === 0 ? 0 : firstNewlineOffset + 1;
      incompleteLine =
        unreadEndOffset === 0
          ? Buffer.alloc(0)
          : transcriptTail.subarray(0, firstNewlineOffset);
      const completeLines = transcriptTail
        .subarray(completeLinesStartOffset)
        .toString("utf8")
        .split("\n");
      if (isTranscriptEnd && completeLines.at(-1) === "") completeLines.pop();

      for (let lineIndex = completeLines.length - 1; lineIndex >= 0; lineIndex -= 1) {
        if (completeLines[lineIndex] === "") allow();
        inspectLine(completeLines[lineIndex]);
      }
    }

    if (unreadEndOffset > 0) allow();
    finishDecision();
  } finally {
    closeSync(transcriptDescriptor);
  }
}

function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== "object") allow();
  if (Object.hasOwn(payload, "agent_id")) allow();
  if (typeof payload.prompt_id !== "string" || payload.prompt_id === "") allow();
  if (typeof payload.tool_use_id !== "string" || payload.tool_use_id === "") allow();
  if (typeof payload.transcript_path !== "string" || payload.transcript_path === "") allow();
  if (!DIRECT_WORK_TOOLS.has(payload.tool_name)) allow();
  if (isExemptBash(payload.tool_name, payload.tool_input)) allow();
  enforceFromTranscript(payload);
}

try {
  main();
} catch {
  allow();
}
