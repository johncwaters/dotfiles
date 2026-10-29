#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argumentsPassed = process.argv.slice(2);
fs.appendFileSync(process.env.CODEX_MCP_COMMAND_LOG, `${JSON.stringify(argumentsPassed)}\n`);
const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
if (configText.includes('invalid toml')) process.exit(1);
const serverSection = /\n?\[mcp_servers\.backchannels\]\n([\s\S]*?)(?=\n\[|$)/.exec(configText);
const [group, action, serverName] = argumentsPassed;
if (group !== 'mcp') process.exit(1);
if (action === 'list') {
  console.log('[]');
  process.exit(0);
}
if (action === 'get') {
  if (serverName !== 'backchannels' || !serverSection) process.exit(1);
  const url = /^url = "(.*)"$/m.exec(serverSection[1])?.[1];
  console.log(JSON.stringify({name: serverName, enabled: !serverSection[1].includes('enabled = false'), transport: {type:'streamable_http', url}}));
  process.exit(0);
}
if (action !== 'remove' || serverName !== 'backchannels' || !serverSection) process.exit(1);
if (fs.existsSync(path.join(process.env.HOME, '.fail-codex-mcp-remove'))) process.exit(1);
fs.writeFileSync(configPath, configText.replace(serverSection[0], ''));
