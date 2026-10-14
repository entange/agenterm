import { Button, cn, IconButton, Kbd } from '@agenterm/ui';
import { CheckCircle2, CircleAlert, Info, Search, Settings, X } from 'lucide-react';
import * as React from 'react';
import { getBridge } from '../lib/bridge.js';
import { useLive } from '../lib/live.js';
import { useToasts } from '../lib/toast.js';
import { useUi } from '../lib/ui.js';
import { shortcut } from '../lib/shortcuts.js';

/** Inset title bar: drag region, task finder, settings. */
export function TitleBar(): React.JSX.Element {
  const setPaletteOpen = useUi((state) => state.setPaletteOpen);
  const setSettingsOpen = useUi((state) => state.setSettingsOpen);
  const mac = getBridge()?.platform === 'darwin';
  return (
    <div
      className={cn(
        'drag flex h-11 shrink-0 items-center border-b border-line bg-panel pr-3',
        mac ? 'pl-[88px]' : 'pl-3'
      )}
    >
      <span className="wordmark text-[12px] text-ink-muted">agenterm</span>
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="no-drag mx-auto flex h-7 w-[380px] items-center gap-2 rounded-md border border-line bg-raised px-2.5 text-[12.5px] text-ink-faint hover:border-line-strong hover:text-ink-muted"
      >
        <Search className="size-3.5" />
        Find a task
        <Kbd className="ml-auto">{shortcut('K')}</Kbd>
      </button>
      <div className="no-drag">
        <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
          <Settings className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}

/** The daemon is up but the task list keeps failing to load. */
export function TasksErrorBanner({ error, retry }: { error: unknown; retry: () => void }): React.JSX.Element {
  return (
    <div role="alert" className="flex items-center gap-3 border-b border-fail/30 bg-fail/10 px-4 py-2 text-[12.5px]">
      <span className="size-1.5 rounded-full bg-fail" />
      <span className="flex-1 text-ink">
        Could not load tasks: {error instanceof Error ? error.message : String(error)}
      </span>
      <Button size="sm" tone="secondary" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}

/** Shown whenever the daemon is not online, with the way back. */
export function ConnectionBanner(): React.JSX.Element | null {
  const connection = useLive((state) => state.connection);
  const [busy, setBusy] = React.useState(false);
  if (connection.state === 'online') return null;
  const starting = connection.state === 'starting';
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 border-b px-4 py-2 text-[12.5px]',
        starting ? 'border-attn/30 bg-attn/10 text-ink' : 'border-fail/30 bg-fail/10 text-ink'
      )}
    >
      <span className={cn('size-1.5 rounded-full', starting ? 'bg-attn attn-breathe' : 'bg-fail')} />
      <span className="flex-1">
        {connection.detail ?? (starting ? 'Connecting to the daemon…' : 'The daemon is offline.')}
      </span>
      {connection.state === 'stopped' || connection.state === 'offline' || connection.state === 'outdated' ? (
        <Button
          size="sm"
          tone="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void getBridge()
              ?.startDaemon()
              .finally(() => setBusy(false));
          }}
        >
          {connection.state === 'outdated'
            ? busy
              ? 'Restarting…'
              : 'Restart daemon'
            : busy
              ? 'Starting…'
              : 'Start daemon'}
        </Button>
      ) : null}
    </div>
  );
}

const TOAST_ICON = { info: Info, success: CheckCircle2, error: CircleAlert };

export function Toaster(): React.JSX.Element {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[360px] flex-col gap-2">
      {toasts.map((entry) => {
        const Icon = TOAST_ICON[entry.tone];
        return (
          <div
            key={entry.id}
            role={entry.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex gap-2.5 rounded-lg border border-line-strong bg-raised p-3 shadow-xl"
          >
            <Icon
              className={cn(
                'mt-0.5 size-4 shrink-0',
                entry.tone === 'error' ? 'text-fail' : entry.tone === 'success' ? 'text-ok' : 'text-ink-muted'
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-ink">{entry.title}</p>
              {entry.detail === undefined ? null : (
                <p className="mt-0.5 text-[12px] break-words text-ink-muted">{entry.detail}</p>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(entry.id)}
              className="self-start text-ink-faint hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
