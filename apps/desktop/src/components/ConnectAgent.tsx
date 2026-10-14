import * as React from 'react';
import { CopyBlock, CopyField, Segmented } from './controls.js';

type Target = 'claude' | 'codex' | 'other' | 'cli';

const TARGETS: Array<{ value: Target; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'other', label: 'Other agents' },
  { value: 'cli', label: 'CLI' }
];

const MCP_JSON = `{
  "mcpServers": {
    "agenterm": { "command": "agenterm", "args": ["mcp"] }
  }
}`;

const CLI_EXAMPLE = `agenterm run --id web "npm run dev"   # start, or get the running one
agenterm ls                           # what is running
agenterm logs web                     # recent output
agenterm stop web                     # Ctrl+C, then end it`;

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[12px] text-ink-muted">{children}</p>;
}

/** How to hand agenterm to an agent: one tab per kind of agent, each with the command to copy. */
export function ConnectAgent(): React.JSX.Element {
  const [target, setTarget] = React.useState<Target>('claude');
  return (
    <div className="space-y-2.5">
      <Segmented label="Agent" size="sm" value={target} options={TARGETS} onChange={setTarget} />
      {target === 'claude' ? (
        <>
          <CopyField text="claude mcp add --scope user agenterm -- agenterm mcp" label="Claude Code setup" />
          <Note>
            Run it once in a terminal. <code className="font-mono">--scope user</code> makes it available in every
            project; leave it out to add it to the current project only.
          </Note>
        </>
      ) : target === 'codex' ? (
        <>
          <CopyField text="codex mcp add agenterm -- agenterm mcp" label="Codex setup" />
          <Note>Run it once in a terminal. New Codex sessions pick it up.</Note>
        </>
      ) : target === 'other' ? (
        <>
          <CopyBlock text={MCP_JSON} label="MCP config" />
          <Note>
            Cursor, Claude Desktop, and most other agents read this shape from their MCP config file. Add the{' '}
            <code className="font-mono">agenterm</code> entry next to any servers already there. Apps opened from the
            Dock may not see your PATH; use the full path from <code className="font-mono">which agenterm</code> as the
            command if they cannot find it.
          </Note>
        </>
      ) : (
        <>
          <CopyBlock text={CLI_EXAMPLE} label="CLI example" />
          <Note>Agents that can run shell commands can use the CLI directly. It does everything the MCP tools do.</Note>
        </>
      )}
      <Note>
        The agent gets <code className="font-mono">run</code>, <code className="font-mono">list</code>,{' '}
        <code className="font-mono">logs</code>, <code className="font-mono">input</code>,{' '}
        <code className="font-mono">stop</code>, and <code className="font-mono">remove</code>. Ask it to give each
        command an id (like <code className="font-mono">web</code>) so it never starts the same one twice; the agent
        skill in <code className="font-mono">skills/agenterm</code> teaches it that.
      </Note>
      <Note>
        All of these need the <code className="font-mono">agenterm</code> command. If{' '}
        <code className="font-mono">which agenterm</code> prints nothing, install it with Node.js 22 or newer:
      </Note>
      <CopyField text="npm install -g agenterm --allow-scripts=node-pty" label="install command" />
    </div>
  );
}
