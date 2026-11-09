# Goblins Premiere (MCP) 0.3.5

Lets your AI agent (Claude, ChatGPT/Codex, Grok, Cursor, Windsurf, Gemini CLI, opencode, or any
agent that runs MCP servers) read and edit the Premiere Pro timeline that is
open on this computer, through the **Goblins Edit Recorder** panel. Every edit is shown in the
panel first; you Apply or Reject it (or turn on Auto-apply). Nothing goes through the cloud: the
agent talks to a server on this computer, and the panel connects to it.

## Install (macOS or Windows)

Needs **Node.js 22 or newer** and the Goblins Edit Recorder panel (download it at
https://goblins-edit-recorder.vercel.app/download).

```
npx -y github:danilowhk/goblins-premiere-mcp install
```

This copies the server to your Goblins folder, installs the **Goblins CEP Helper** (razor, speed,
clip volume and XML import) into Premiere's extensions folder, lets Premiere load it
(PlayerDebugMode for CEP 11 and 12, for your user only), and adds `goblins-premiere` to every
AI agent it finds on this computer: Claude Code, Codex (also used by the ChatGPT desktop app) and
Grok through their own `mcp add` command; Claude Desktop, Cursor, Windsurf, Gemini CLI and
opencode by adding one entry to their configuration file (everything else in it is kept). For any
other agent it prints the entry to add. Chat websites (chatgpt.com, grok.com, claude.ai) cannot
reach a server on your computer.

Then restart your AI app so it sees the new server.

Then:

1. Restart Premiere Pro (and your AI app).
2. **Window › Extensions › Goblins CEP Helper** (keep it open; it can stay docked).
3. In the Goblins Edit Recorder panel: **MCP › Connect this panel to Goblins Premiere**, and
   enter the code your AI shows when you ask it to "pair with Premiere".
4. Turn on **AI edits on this project** in the same page.

## Update

Run the install command again. **Uninstall:** `npx -y github:danilowhk/goblins-premiere-mcp uninstall` (removes the
helper, the server and the entry from every agent).

## Integrity

`SHA256SUMS` lists the SHA-256 of `premiere-mcp.js` for this version.
