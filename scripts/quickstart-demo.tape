# The README's demo: Claude Code on the quickstart's sample database.
# Recorded with VHS (https://github.com/charmbracelet/vhs), from a plain
# terminal (not inside another Claude Code session), from the repository's
# root:
#
#   1. Clone this repository to ~/midplane, so Claude Code's header reads
#      ~/midplane/examples/quickstart, and run its quickstart through step 3
#      there: the database, a key, a fresh token (a take taints its grant)
#      and the gateway on 127.0.0.1:7433.
#   2. In that folder, write mcp.json for the token:
#      {"mcpServers": {"midplane": {"type": "http",
#        "url": "http://127.0.0.1:7433/mcp",
#        "headers": {"Authorization": "Bearer <token>"}}}}
#   3. Start `claude` there once and trust the folder.
#   4. vhs scripts/quickstart-demo.tape
#   5. With ffmpeg, play the stretches where Claude is working at 4x and cut
#      the final hold to 6s; each answer still shows its real time. A take's
#      times differ, so find them first (a static stretch is identical
#      frames in the GIF).
#
# The appended system prompt only keeps answers short enough to read.

Output docs/images/quickstart-demo.gif
Set Shell zsh
Set FontSize 15
Set FontFamily "Menlo"
Set Width 1000
Set Height 900
Set Padding 18
Set WindowBar Colorful
Set BorderRadius 8
Set TypingSpeed 35ms

Hide
Type `cd ~/midplane/examples/quickstart; PROMPT='$ '; export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1; alias claude='command claude --mcp-config mcp.json --strict-mcp-config --allowedTools mcp__midplane --model sonnet --setting-sources project,local --permission-mode default --append-system-prompt "This is a short screen recording. Answer in at most three short lines, plus a compact table only when you list rows. No closing remarks."'; clear` Enter
Sleep 1s
Type "claude" Enter
Sleep 7s
Ctrl+L
Sleep 1s
Show

Sleep 1s
Type "List our customers with their emails and phone numbers."
Sleep 400ms
Enter
Sleep 3s
# VHS reads the screen from the top of the scrollback, so wait for each
# answer's "done" line, not for the prompt at the bottom.
Wait+Screen@90s /done/
Sleep 4s

Type "Summarize ticket 1."
Sleep 400ms
Enter
Sleep 3s
Wait+Screen@90s /done[\s\S]*done/
Sleep 4s

Type "Now show me the API keys."
Sleep 400ms
Enter
# This answer ends below the rows VHS reads: give it time, then hold.
Sleep 21s
