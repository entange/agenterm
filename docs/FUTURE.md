# Future

Ideas worth building that are not planned yet. Each one says what it would do, what we know, and what is still open.

## The conversation that started a task

Today a task records the agent that started it by name and pid (`startedBy: claude`, `startedByPid: 18638`). With ten
Claude Code windows open, that cannot tell which conversation a dev server belongs to. Some agents hand their thread
id to every command they run, so `agenterm run` could record the conversation as well.

### What agents expose (checked 2026-10-17)

| Agent       | To commands it runs                                       | To MCP servers it starts                                |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------- |
| Claude Code | `CLAUDE_CODE_SESSION_ID`, the transcript id               | the same variable                                       |
| Codex       | `CODEX_THREAD_ID` (since 0.125)                           | no; [openai/codex#19937] was closed as not planned      |
| Gemini CLI  | only `GEMINI_CLI=1`; `GEMINI_SESSION_ID` reaches hooks    | not checked                                             |
| Others      | nothing documented (opencode, Cursor, Amp, and the rest)  | not checked                                             |

Claude Code also sets `AI_AGENT` (for example `claude-code_2-1-286_agent`) and `CLAUDE_PID`.

[openai/codex#19937]: https://github.com/openai/codex/issues/19937

### How it would work

Precise where an agent tells us, and still useful where it does not:

1. **Known variables.** The CLI reads a small table of variables from its own environment (`CLAUDE_CODE_SESSION_ID`
   → Claude Code, `CODEX_THREAD_ID` → Codex) and sends the id with the task as `startedBySession`. Supporting a new
   agent is one row. Nothing is read from `~/.claude`, `~/.codex`, or any other agent folder.
2. **`AGENTERM_SESSION`.** Any agent, script, or person can set it; it wins over the table. The skill would tell
   agents to set it when they know their id.
3. **The agent process.** For every other agent, the pid plus the process start time names one running agent
   exactly. It is less precise than a thread id: one process can switch conversations with `/clear` or `/resume`.
4. **Outside commands.** For `agenterm ps` and the Outside tab, the daemon could read the same variables from a
   process's environment (`ps eww` on macOS for your own processes, `/proc/<pid>/environ` on Linux), keeping only
   the ids in the table and nothing else. An orphan would then say "left by Claude Code, session dbe62738".

### What it would enable

- `agenterm ls --mine`, and MCP `list` defaulting to the calling conversation's tasks.
- Grouping tasks by conversation in the app, next to grouping by project and agent.
- **Resume conversation**: copy `claude --resume <id>` or `codex resume <id>` from a task.
- Stopping a conversation's tasks when it ends, finer than today's stop-with-agent.

### Open questions

- Codex MCP calls carry no thread id, so tasks started through Codex's MCP tools would fall back to the process.
  Does that make `--mine` confusing for Codex users?
- Does a Claude Code MCP server keep the first session's id after `/clear` starts a new one?
- Should the app show the raw id, or only use it for grouping and resume?
