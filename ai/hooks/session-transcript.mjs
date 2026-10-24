import { asObject, asText, contentText, isSyntheticPrompt, transcriptEntries } from "../skills/running-retros/lib/digest.ts";

const SLASH_COMMAND = /<command-name>\/?([^<\s]+)<\/command-name>/;
const TASK_NOTIFICATION_TOOL_USE_ID = /<task-notification>[\s\S]*?<tool-use-id>([^<\s]+)<\/tool-use-id>/g;

function contentBlocks(entry) {
  const content = asObject(entry.message)?.content;
  return Array.isArray(content) ? content.map(asObject) : [];
}

function* taskNotifications(value) {
  for (const notification of JSON.stringify(value ?? "").matchAll(TASK_NOTIFICATION_TOOL_USE_ID)) {
    yield { kind: "taskNotification", toolUseId: notification[1] };
  }
}

function* entryEvents(entry, skillNamesByToolUseId) {
  const content = asObject(entry.message)?.content;
  if (entry.type === "user") {
    const promptText = contentText(content).trim();
    const slashCommandName = promptText.match(SLASH_COMMAND)?.[1];
    if (slashCommandName && entry.isMeta !== true) yield { kind: "slashCommand", name: slashCommandName };
    if (!isSyntheticPrompt(promptText, entry)) yield { kind: "prompt" };
    yield* taskNotifications(content);
    for (const block of contentBlocks(entry)) {
      if (block?.type !== "tool_result") continue;
      const isError = block.is_error === true;
      const skillName = skillNamesByToolUseId.get(asText(block.tool_use_id));
      if (skillName && !isError) yield { kind: "skillRun", name: skillName };
      yield { kind: "toolResult", toolUseId: asText(block.tool_use_id), text: contentText(block.content), isError };
    }
    return;
  }
  const attachment = asObject(entry.attachment);
  if (entry.type === "attachment" && attachment?.type === "queued_command") {
    yield* taskNotifications(attachment.prompt);
    return;
  }
  if (entry.type !== "assistant") return;
  for (const block of contentBlocks(entry)) {
    if (block?.type !== "tool_use") continue;
    const input = asObject(block.input) ?? {};
    if (block.name === "Skill" && typeof input.skill === "string") skillNamesByToolUseId.set(asText(block.id), input.skill);
    yield { kind: "toolUse", id: asText(block.id), name: asText(block.name), input };
  }
}

export async function* sessionEvents(transcriptPath) {
  const skillNamesByToolUseId = new Map();
  for await (const entry of transcriptEntries(transcriptPath)) {
    if (entry) yield* entryEvents(entry, skillNamesByToolUseId);
  }
}

export function isSkillRun(event, skillName) {
  if (event.kind === "slashCommand") return event.name === skillName;
  return event.kind === "skillRun" && event.name === skillName;
}
