import { Button } from '@agenterm/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import type { CliStatus } from '../../shared/bridge.js';
import { getBridge } from '../lib/bridge.js';
import { CopyBlock, CopyField, Segmented } from './controls.js';

type Target = 'claude' | 'codex' | 'other' | 'cli';

const TARGETS: Array<{ value: Target; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'other', label: 'Other agents' },
  { value: 'cli', label: 'CLI' }
];

/** Apps opened from the Dock do not get the shell's PATH, so the config names the command by its full path when known. */
function mcpJson(command: string): string {
  return `{
  "mcpServers": {
    "agenterm": { "command": ${JSON.stringify(command)}, "args": ["mcp"] }
  }
}`;
}

const CLI_EXAMPLE = `agenterm run --id web "npm run dev"   # start, or get the running one
agenterm ls                           # what is running
agenterm logs web                     # recent output
agenterm stop web                     # Ctrl+C, then end it`;

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[12px] text-ink-muted">{children}</p>;
}

const UNAVAILABLE: CliStatus = { state: 'unavailable', path: null };

/** Whether terminals and agents can run `agenterm`, with a button to add the app's copy. */
function CommandStatus({ status }: { status: CliStatus }): React.JSX.Element | null {
  const client = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const install = (): void => {
    setBusy(true);
    void getBridge()
      ?.installCli()
      .then((next) => client.setQueryData(['cli'], next))
      .finally(() => setBusy(false));
  };
  if (status.state === 'unavailable') return null;
  if (status.state === 'installed') {
    return (
      <Note>
        The <code className="font-mono">agenterm</code> command is installed at{' '}
        <code className="font-mono">{status.path}</code> and updates with this app.
      </Note>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[12px] text-ink-muted">
        {status.state === 'missing' ? (
          <>
            Agents need the <code className="font-mono">agenterm</code> command. Add it to{' '}
            <code className="font-mono">/usr/local/bin</code>; macOS asks for your password.
          </>
        ) : (
          <>
            <code className="font-mono">agenterm</code> runs <code className="font-mono">{status.path}</code>, a
            separate install. To use the copy that updates with this app, run{' '}
            <code className="font-mono whitespace-nowrap">npm uninstall -g agenterm</code>, then add it here.
          </>
        )}
      </p>
      <Button size="sm" disabled={busy} onClick={install}>
        {busy ? 'Adding…' : 'Add command'}
      </Button>
    </div>
  );
}

/** How to hand agenterm to an agent: one tab per kind of agent, each with the command to copy. */
export function ConnectAgent(): React.JSX.Element {
  const [target, setTarget] = React.useState<Target>('claude');
  const cli = useQuery({
    queryKey: ['cli'],
    queryFn: async (): Promise<CliStatus> => (await getBridge()?.cliStatus()) ?? UNAVAILABLE
  });
  const status = cli.data ?? UNAVAILABLE;
  const command = status.state === 'installed' || status.state === 'other' ? (status.path ?? 'agenterm') : 'agenterm';
  return (
    <div className="space-y-2.5">
      <CommandStatus status={status} />
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
          <CopyBlock text={mcpJson(command)} label="MCP config" />
          <Note>
            Cursor, Claude Desktop, and most other agents read this shape from their MCP config file. Add the{' '}
            <code className="font-mono">agenterm</code> entry next to any servers already there.
            {command === 'agenterm' ? (
              <>
                {' '}
                Apps opened from the Dock may not see your PATH; use the full path from{' '}
                <code className="font-mono">which agenterm</code> as the command if they cannot find it.
              </>
            ) : null}
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
      {status.state === 'unavailable' ? (
        <>
          <Note>
            All of these need the <code className="font-mono">agenterm</code> command. If{' '}
            <code className="font-mono">which agenterm</code> prints nothing, install it with Node.js 22 or newer:
          </Note>
          <CopyField text="npm install -g agenterm" label="install command" />
        </>
      ) : null}
    </div>
  );
}
