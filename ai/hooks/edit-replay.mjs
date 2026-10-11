import fs from "node:fs";

function applyEdit(replay, edit) {
  const { old_string: oldString, new_string: newString, replace_all: replaceAll } = edit;
  if (oldString === undefined) return replay;
  const { content, hasUnmatchedOldString } = replay;
  if (replaceAll) {
    return {
      content: content.split(oldString).join(newString ?? ""),
      hasUnmatchedOldString: hasUnmatchedOldString || !content.includes(oldString),
    };
  }
  const matchIndex = content.indexOf(oldString);
  if (matchIndex === -1) return { content, hasUnmatchedOldString: true };
  return {
    content: content.slice(0, matchIndex) + (newString ?? "") + content.slice(matchIndex + oldString.length),
    hasUnmatchedOldString,
  };
}

export function replayEdits(toolInput, filePath) {
  if (typeof toolInput.content === "string") return { content: toolInput.content, hasUnmatchedOldString: false };
  if (!toolInput.edits && toolInput.old_string === undefined) return { content: undefined, hasUnmatchedOldString: false };
  const originalReplay = {
    content: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "",
    hasUnmatchedOldString: false,
  };
  if (toolInput.edits) return toolInput.edits.reduce((replay, edit) => applyEdit(replay, edit), originalReplay);
  return applyEdit(originalReplay, toolInput);
}

export function reconstruct(toolInput, filePath) {
  return replayEdits(toolInput, filePath).content;
}
