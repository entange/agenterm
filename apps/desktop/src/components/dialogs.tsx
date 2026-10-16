import type { Settings } from '@agenterm/core';
import { Button, Dialog, DialogBody, DialogFooter } from '@agenterm/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import * as React from 'react';
import type { Preferences } from '../../shared/bridge.js';
import { hideOutside } from '../lib/actions.js';
import { api, getBridge } from '../lib/bridge.js';
import { useLive } from '../lib/live.js';
import { keys, useHealth, useSettings } from '../lib/queries.js';
import { toastError } from '../lib/toast.js';
import { useUi, type ThemePreference } from '../lib/ui.js';
import { ConnectAgent } from './ConnectAgent.js';
import { Segmented, Switch } from './controls.js';

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
];

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="space-y-3 border-b border-line py-4 first:pt-0 last:border-b-0 last:pb-0">
      <h3 className="eyebrow text-ink-faint">{title}</h3>
      {children}
    </section>
  );
}

/** How to connect an agent, then the few choices there are: what happens when an agent exits, notifications, theme, and the daemon. */
export function SettingsDialog(): React.JSX.Element {
  const open = useUi((state) => state.settingsOpen);
  const setOpen = useUi((state) => state.setSettingsOpen);
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const connection = useLive((state) => state.connection);
  const client = useQueryClient();
  const settings = useSettings(open);
  const health = useHealth(open);
  const preferences = useQuery({
    queryKey: ['preferences'],
    queryFn: async (): Promise<Preferences> => (await getBridge()?.preferences()) ?? { notifications: true },
    enabled: open
  });

  const updateSettings = (patch: Partial<Settings>): void => {
    const previous = settings.data;
    // A fetch still in flight would land after the optimistic value and undo it.
    void client.cancelQueries({ queryKey: keys.settings });
    if (previous !== undefined) client.setQueryData(keys.settings, { ...previous, ...patch });
    void api('updateSettings', patch)
      .then((next) => client.setQueryData(keys.settings, next))
      .catch((error: unknown) => {
        if (previous !== undefined) client.setQueryData(keys.settings, previous);
        toastError('Could not save the setting', error);
      });
  };

  const hidden = settings.data?.hiddenCommands ?? [];

  const setNotifications = (notifications: boolean): void => {
    void getBridge()
      ?.setPreferences({ notifications })
      .then((next) => client.setQueryData(['preferences'], next));
  };

  const online = connection.state === 'online';

  return (
    <Dialog open={open} onOpenChange={setOpen} title="Settings">
      <DialogBody className="scroll-thin max-h-[68vh] overflow-y-auto">
        <Section title="Connect an agent">
          <ConnectAgent />
        </Section>
        <Section title="Tasks">
          <Switch
            label="Stop a task when the agent that started it exits"
            detail={
              <>
                Off: tasks keep running until you or an agent stops them. On: once the program that ran{' '}
                <code className="font-mono">agenterm run</code> (or its MCP server) exits, its tasks are stopped too.
              </>
            }
            checked={settings.data?.stopWithAgent ?? false}
            disabled={!online || settings.data === undefined}
            onChange={(stopWithAgent) => updateSettings({ stopWithAgent })}
          />
        </Section>
        <Section title="Hidden from Outside">
          <p className="text-[12px] text-ink-muted">
            Commands you keep running on purpose, listed under Hidden at the bottom of Outside. Use Hide on one to add
            it.
          </p>
          {hidden.length === 0 ? (
            <p className="text-[12px] text-ink-faint">None hidden.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {hidden.map((name) => (
                <li
                  key={name}
                  className="inline-flex h-6 items-center gap-1 rounded border border-line-strong pr-0.5 pl-2 font-mono text-[11.5px] text-ink-muted"
                >
                  {name}
                  <button
                    type="button"
                    aria-label={`List ${name} again`}
                    title={`List ${name} again`}
                    disabled={!online}
                    onClick={() => void hideOutside(client, name, false)}
                    className="grid size-5 place-items-center rounded text-ink-faint hover:bg-sunken hover:text-ink"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Notifications">
          <Switch
            label="Notify me when a task fails"
            detail="Only while agenterm is in the background."
            checked={preferences.data?.notifications ?? true}
            disabled={preferences.data === undefined}
            onChange={setNotifications}
          />
        </Section>
        <Section title="Appearance">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-ink">Theme</span>
            <Segmented label="Theme" value={theme} options={THEMES} onChange={setTheme} />
          </div>
        </Section>
        <Section title="Daemon">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12.5px] text-ink-muted">
              {online
                ? `Running${health.data?.version === undefined ? '' : ` v${health.data.version}`}${health.data?.pid === undefined ? '' : ` · pid ${health.data.pid}`}${health.data?.running === undefined ? '' : ` · ${health.data.running} ${health.data.running === 1 ? 'task' : 'tasks'} running`}`
                : (connection.detail ?? 'Not running.')}
            </span>
            {online ? (
              <Button size="sm" tone="danger" onClick={() => void getBridge()?.stopDaemon()}>
                Stop daemon…
              </Button>
            ) : (
              <Button size="sm" onClick={() => void getBridge()?.startDaemon()}>
                Start daemon
              </Button>
            )}
          </div>
        </Section>
      </DialogBody>
    </Dialog>
  );
}

/** Asks before stopping and removing a running task. */
export function ConfirmDialog(): React.JSX.Element {
  const confirmation = useUi((state) => state.confirmation);
  const close = (): void => useUi.getState().confirm(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      title={confirmation?.title ?? ''}
      description={confirmation?.detail}
      width="sm"
    >
      <DialogFooter>
        <Button tone="quiet" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          tone="danger"
          disabled={busy}
          autoFocus
          onClick={() => {
            if (confirmation === null) return;
            setBusy(true);
            void Promise.resolve(confirmation.run()).finally(() => {
              setBusy(false);
              close();
            });
          }}
        >
          {busy ? 'Working…' : (confirmation?.action ?? 'OK')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
