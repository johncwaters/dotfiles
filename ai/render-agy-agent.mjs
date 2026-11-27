import fs from "node:fs";

const [claudeAgentPath, destinationPath] = process.argv.slice(2);
const AGY_TOOL_BY_CLAUDE_TOOL = { Read: "read_file", Grep: "run_command", Glob: "run_command", Bash: "run_command", Edit: "edit_file", Write: "write_file" };

const claudeAgentText = fs.readFileSync(claudeAgentPath, "utf8");
const frontmatterMatch = claudeAgentText.match(/^---\n([\s\S]*?)\n---\n/);
if (!frontmatterMatch) throw new Error(`no frontmatter: ${claudeAgentPath}`);
const fieldByName = Object.fromEntries(
  frontmatterMatch[1].split("\n").map((line) => line.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map(([, name, value]) => [name, value]),
);
for (const requiredField of ["name", "description", "tools"]) {
  if (!fieldByName[requiredField] || /^[>|]/.test(fieldByName[requiredField])) throw new Error(`${requiredField} must be a one-line value in ${claudeAgentPath}`);
}
const agyToolNames = [...new Set(fieldByName.tools.split(",").map((claudeToolName) => {
  const agyToolName = AGY_TOOL_BY_CLAUDE_TOOL[claudeToolName.trim()];
  if (!agyToolName) throw new Error(`no agy tool for ${claudeToolName.trim()} in ${claudeAgentPath}`);
  return agyToolName;
}))];

const agyFrontmatter = [
  "---",
  `name: ${JSON.stringify(fieldByName.name)}`,
  `description: ${JSON.stringify(fieldByName.description)}`,
  "tools:",
  ...agyToolNames.map((toolName) => `  - ${toolName}`),
  "subagent: true",
  "mainAgent: false",
  "model: inherit",
  "---",
  "",
].join("\n");
fs.writeFileSync(destinationPath, agyFrontmatter + claudeAgentText.slice(frontmatterMatch[0].length));
