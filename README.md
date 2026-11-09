# Goblins Premiere (MCP) 0.3.3

Lets your AI agent (Claude Code, Claude Desktop) read and edit the Premiere Pro timeline that is
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
(PlayerDebugMode for CEP 11 and 12, for your user only), and adds `goblins-premiere` to Claude
Code. It prints the Claude Desktop configuration too.

Then:

1. Restart Premiere Pro.
2. **Window › Extensions › Goblins CEP Helper** (keep it open; it can stay docked).
3. In the Goblins Edit Recorder panel: **MCP › Connect this panel to Goblins Premiere**, and
   enter the code your AI shows when you ask it to "pair with Premiere".
4. Turn on **AI edits on this project** in the same page.

## Update

Run the install command again. **Uninstall:** `npx -y github:danilowhk/goblins-premiere-mcp uninstall`.

## Integrity

`SHA256SUMS` lists the SHA-256 of `premiere-mcp.js` for this version.
