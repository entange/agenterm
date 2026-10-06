import type { AgentProvider, SessionRecord, SpawnSessionRequest } from '@agenterm/core';
import { Button, cn, Dialog, DialogBody, DialogFooter } from '@agenterm/ui';
import { AlertTriangle, FolderOpen } from 'lucide-react';
import * as React from 'react';
import { callsign } from '../../shared/callsign.js';
import { useActions } from '../lib/actions.js';
import { api, ApiError, getBridge } from '../lib/bridge.js';
import { folderName, isLive, PROVIDER_NAMES, shortPath, splitArgs } from '../lib/format.js';
import { useUi } from '../lib/ui.js';
import { toast } from '../lib/toast.js';
import { useQueryClient } from '@tanstack/react-query';
import { keys, seedSession } from '../lib/queries.js';

const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'gemini', 'opencode', 'generic'];

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-ink-muted">{label}</span>
      {children}
      {hint === undefined ? null : <span className="mt-1 block text-[11.5px] text-ink-faint">{hint}</span>}
    </label>
  );
}

const inputClass =
  'h-8 w-full rounded-md border border-line-strong bg-raised px-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none';

/** Start an agent or command in a daemon-owned terminal. */
export function NewSessionDialog({
  open,
  onOpenChange,
  sessions,
  initialProvider
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionRecord[];
  initialProvider: AgentProvider | undefined;
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New session"
      description="Runs in a terminal owned by the agenterm daemon. Closing the window does not stop it."
    >
      {/* Mounted only while open, so every opening starts from fresh defaults. */}
      {open ? (
        <NewSessionForm sessions={sessions} initialProvider={initialProvider} onDone={() => onOpenChange(false)} />
      ) : null}
    </Dialog>
  );
}

function NewSessionForm({
  sessions,
  initialProvider,
  onDone
}: {
  sessions: SessionRecord[];
  initialProvider: AgentProvider | undefined;
  onDone: () => void;
}): React.JSX.Element {
  const recentCwds = useUi((state) => state.recentCwds);
  const client = useQueryClient();
  const [provider, setProvider] = React.useState<AgentProvider>(initialProvider ?? 'claude');
  const [cwd, setCwd] = React.useState(() => {
    const selectedId = useUi.getState().selectedId;
    return sessions.find((session) => session.id === selectedId)?.cwd ?? recentCwds[0] ?? '';
  });
  const [command, setCommand] = React.useState('');
  const [args, setArgs] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; hint?: string | undefined } | null>(null);

  const folders = [...new Set([...recentCwds, ...sessions.map((session) => session.cwd)])]
    .filter((dir) => dir !== '/')
    .slice(0, 6);
  const sharing = sessions.filter((session) => isLive(session) && session.cwd === cwd.trim());
  const generic = provider === 'generic';
  const absolute = /^(\/|[A-Za-z]:[\\/])/.test(cwd.trim());
  const canStart = absolute && (!generic || command.trim().length > 0) && !busy;

  const start = async (): Promise<void> => {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    const commandParts = generic ? splitArgs(command.trim()) : [];
    const request: SpawnSessionRequest = {
      provider,
      cwd: cwd.trim(),
      args: [...commandParts.slice(1), ...splitArgs(args)],
      cols: 120,
      rows: 32
    };
    if (generic && commandParts[0] !== undefined) request.command = commandParts[0];
    if (title.trim().length > 0) request.title = title.trim();
    try {
      const { session } = await api('spawn', request);
      useUi.getState().rememberCwd(request.cwd);
      seedSession(client, session);
      void client.invalidateQueries({ queryKey: keys.sessions });
      useUi.getState().select(session.id, 'terminal');
      toast('success', `Started ${callsign(session)}`, session.title);
      onDone();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? { message: caught.message, hint: caught.hint } : { message: String(caught) }
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <DialogBody className="space-y-4">
        <div
          role="radiogroup"
          aria-label="Agent"
          className="grid grid-cols-5 gap-1 rounded-lg border border-line bg-sunken p-1"
        >
          {PROVIDERS.map((entry) => (
            <button
              key={entry}
              type="button"
              role="radio"
              aria-checked={provider === entry}
              onClick={() => setProvider(entry)}
              className={cn(
                'h-8 rounded-md text-[12.5px] transition-colors',
                provider === entry ? 'bg-raised font-medium text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
              )}
            >
              {PROVIDER_NAMES[entry]}
            </button>
          ))}
        </div>

        <Field label="Folder">
          <div className="flex gap-2">
            <input
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder="/path/to/project"
              spellCheck={false}
              className={cn(inputClass, 'font-mono text-[12.5px]')}
              autoFocus
            />
            <Button
              onClick={() => {
                void getBridge()
                  ?.pickDirectory(cwd.trim() || undefined)
                  .then((picked) => {
                    if (picked !== null) setCwd(picked);
                  });
              }}
            >
              <FolderOpen className="size-3.5" /> Choose…
            </Button>
          </div>
          {folders.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {folders.map((dir) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => setCwd(dir)}
                  title={dir}
                  className={cn(
                    'rounded border px-2 py-0.5 font-mono text-[11px]',
                    dir === cwd.trim() ? 'border-accent text-ink' : 'border-line text-ink-muted hover:text-ink'
                  )}
                >
                  {folderName(dir)}
                </button>
              ))}
            </div>
          ) : null}
        </Field>

        {generic ? (
          <Field label="Command" hint="Runs directly, not through a shell. Example: bun run dev">
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="bun run dev"
              spellCheck={false}
              className={cn(inputClass, 'font-mono text-[12.5px]')}
            />
          </Field>
        ) : (
          <Field
            label="Arguments"
            hint={`Optional. Passed to ${provider}, for example --model or a starting prompt in quotes.`}
          >
            <input
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder={provider === 'claude' ? '--model opus' : ''}
              spellCheck={false}
              className={cn(inputClass, 'font-mono text-[12.5px]')}
            />
          </Field>
        )}

        <Field label="Title">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={`${generic ? 'command' : provider} · ${folderName(cwd.trim() || 'folder')}`}
            maxLength={200}
            className={inputClass}
          />
        </Field>

        {sharing.length > 0 ? (
          <p className="flex gap-2 rounded-md border border-attn/40 bg-attn/10 px-3 py-2 text-[12.5px] text-ink">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-attn" />
            <span>
              {sharing.map(callsign).join(', ')} {sharing.length === 1 ? 'is' : 'are'} already running in this folder.
              Agents editing the same files can overwrite each other's work.
            </span>
          </p>
        ) : null}

        {error === null ? null : (
          <div role="alert" className="rounded-md border border-fail/40 bg-fail/10 px-3 py-2 text-[12.5px]">
            <p className="text-fail">{error.message}</p>
            {error.hint === undefined ? null : <p className="mt-0.5 text-ink-muted">{error.hint}</p>}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button tone="quiet" onClick={onDone}>
          Cancel
        </Button>
        <Button tone="primary" type="submit" disabled={!canStart}>
          {busy ? 'Starting…' : `Start ${PROVIDER_NAMES[provider]}`}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Kill and attach confirmations. Both name the exact process affected. */
export function PendingDialogs(): React.JSX.Element | null {
  const dialog = useUi((state) => state.dialog);
  const openDialog = useUi((state) => state.openDialog);
  const act = useActions();
  const [typedPid, setTypedPid] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setTypedPid('');
    setTitle('');
    setBusy(false);
  }, [dialog]);

  const close = (): void => openDialog(null);

  if (dialog?.kind === 'kill') {
    const { session } = dialog;
    const attached = session.origin === 'attached';
    const confirmed = !attached || Number(typedPid) === session.pid;
    return (
      <Dialog
        open
        onOpenChange={(open) => (open ? undefined : close())}
        width="sm"
        title={`Kill ${callsign(session)}?`}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!confirmed || busy) return;
            setBusy(true);
            void act.kill(session, attached ? session.pid : undefined).then((ok) => (ok ? close() : setBusy(false)));
          }}
        >
          <DialogBody className="space-y-3 text-[13px] text-ink">
            <p>
              Ends <span className="font-mono text-[12.5px]">{session.commandLine[0] ?? 'the process'}</span> (pid{' '}
              {session.pid}) and every process it started, including dev servers.{' '}
              {attached ? '' : 'The session stays in history with its output.'}
            </p>
            {attached ? (
              <Field label={`agenterm did not start this process. Type its pid (${session.pid}) to kill it.`}>
                <input
                  autoFocus
                  inputMode="numeric"
                  value={typedPid}
                  onChange={(event) => setTypedPid(event.target.value.replace(/\D/g, ''))}
                  className={cn(inputClass, 'font-mono')}
                />
              </Field>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button tone="quiet" onClick={close} autoFocus={!attached}>
              Cancel
            </Button>
            <Button tone="danger" type="submit" disabled={!confirmed || busy}>
              {busy ? 'Killing…' : `Kill ${callsign(session)}`}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    );
  }

  if (dialog?.kind === 'attach') {
    const { candidate } = dialog;
    return (
      <Dialog
        open
        onOpenChange={(open) => (open ? undefined : close())}
        width="sm"
        title={`Attach to ${PROVIDER_NAMES[candidate.provider]} (pid ${candidate.pid})?`}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void act.attach(candidate.pid, title.trim().length > 0 ? title.trim() : undefined).then(close);
          }}
        >
          <DialogBody className="space-y-3 text-[13px] text-ink">
            <p>
              agenterm will watch its process tree, open ports, and changes in{' '}
              <span className="font-mono text-[12.5px]">
                {candidate.cwd === null ? 'its folder' : shortPath(candidate.cwd)}
              </span>
              . It will not type into this process or stop it.
            </p>
            <p className="truncate font-mono text-[11.5px] text-ink-faint" title={candidate.commandLine}>
              {candidate.commandLine}
            </p>
            <Field label="Title (optional)">
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                className={inputClass}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button tone="quiet" onClick={close}>
              Cancel
            </Button>
            <Button tone="primary" type="submit" disabled={busy}>
              Attach read-only
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    );
  }
  return null;
}
