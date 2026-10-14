import type { AgentermEvent, TaskOutputChunk, TaskRecord } from '@agenterm/core';
import { IconButton } from '@agenterm/ui';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import * as React from 'react';
import { api, getBridge } from '../lib/bridge.js';
import { useLive } from '../lib/live.js';
import { useUi } from '../lib/ui.js';

const DARK: ITheme = {
  background: '#0b0b0c',
  foreground: '#e4e4e7',
  cursor: '#ededee',
  cursorAccent: '#0b0b0c',
  selectionBackground: '#ffffff33',
  black: '#27272a',
  red: '#ef6f6c',
  green: '#6ccb9a',
  yellow: '#f2b84b',
  blue: '#5fb3f9',
  magenta: '#c49cf4',
  cyan: '#59d0d6',
  white: '#d4d4d8',
  brightBlack: '#71717a',
  brightRed: '#ff8f8b',
  brightGreen: '#8fe0b5',
  brightYellow: '#ffd07a',
  brightBlue: '#8ccaff',
  brightMagenta: '#dab8ff',
  brightCyan: '#86e6ea',
  brightWhite: '#f2f5f9'
};

const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#18181b',
  cursor: '#18181b',
  cursorAccent: '#ffffff',
  selectionBackground: '#18181b26',
  black: '#18181b',
  red: '#c9423f',
  green: '#2f8f5b',
  yellow: '#a06a12',
  blue: '#1f6fc1',
  magenta: '#8a4fc7',
  cyan: '#13858b',
  white: '#8a8a93',
  brightBlack: '#52525b',
  brightRed: '#e0524e',
  brightGreen: '#38a86b',
  brightYellow: '#b7791f',
  brightBlue: '#2f86e0',
  brightMagenta: '#a066e0',
  brightCyan: '#1aa1a8',
  brightWhite: '#09090b'
};

function currentTheme(): ITheme {
  return document.documentElement.classList.contains('dark') ? DARK : LIGHT;
}

const MAC = navigator.platform.startsWith('Mac');

/**
 * App shortcuts go to the menu, everything else to the program. macOS app
 * keys use Cmd; elsewhere they use Ctrl+Shift (or Alt+digit), so readline
 * keys like Ctrl+K, Ctrl+N, Ctrl+F, and Ctrl+[ always reach the terminal.
 */
function isAppShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  if (MAC) return event.metaKey && !event.ctrlKey && /^[kf[\],1-9]$/.test(key);
  if (event.altKey && !event.ctrlKey && /^[1-9]$/.test(key)) return true;
  if (event.ctrlKey && !event.shiftKey && !event.altKey && key === ',') return true;
  return event.ctrlKey && event.shiftKey && !event.altKey && /^[kf[\]{}]$/.test(key);
}

function isFindShortcut(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || event.key.toLowerCase() !== 'f') return false;
  return MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey;
}

const TAIL_BYTES = 512 * 1024;
/** Output older than this is history: terminal queries in it were answered long ago. */
const REPLAY_AGE_MS = 2000;

/**
 * Live terminal for one task. Typing goes straight to the program while
 * it runs; an ended task shows its output read-only.
 *
 * Ordering is the hard part: subscribe first and buffer live chunks,
 * page in the full retained scrollback, then flush only buffered chunks
 * newer than what was written. After a reconnect, catch up from the last
 * written seq and say so if the ring already dropped some of it.
 *
 * Replayed history can contain terminal queries (cursor position, device
 * attributes). xterm answers them through onData, so answers to old
 * output are dropped instead of being typed into the program.
 */
export function TerminalPane({ task }: { task: TaskRecord }): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<SearchAddon | null>(null);
  const termRef = React.useRef<Terminal | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const taskId = task.id;
  const interactive = task.status === 'running';
  // Read through a ref so a task ending does not tear down and reload the terminal.
  const interactiveRef = React.useRef(interactive);
  interactiveRef.current = interactive;
  const wantsFocus = useUi((state) => state.wantsFocus);

  React.useEffect(() => {
    const host = hostRef.current;
    const bridge = getBridge();
    if (host === null || bridge === null) return undefined;
    let disposed = false;
    let ready = false;
    let lastSeq = 0;
    let buffered: Array<{ seq: number; data: string; createdAtMs: number }> = [];
    let muted = 0;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono Variable', ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.22,
      letterSpacing: 0,
      cursorBlink: interactiveRef.current,
      cursorStyle: interactiveRef.current ? 'block' : 'underline',
      cursorInactiveStyle: 'outline',
      disableStdin: !interactiveRef.current,
      scrollback: 20_000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: currentTheme()
    });
    termRef.current = term;
    const fit = new FitAddon();
    const search = new SearchAddon();
    searchRef.current = search;
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(
      new WebLinksAddon((_event, url) => {
        void bridge.openExternal(url);
      })
    );
    term.open(host);
    term.attachCustomKeyEventHandler((event) => {
      if (isFindShortcut(event)) {
        setSearchOpen(true);
        return false;
      }
      return !isAppShortcut(event);
    });

    const write = (chunk: { seq: number; data: string; createdAtMs?: number }): void => {
      if (chunk.seq <= lastSeq) return;
      lastSeq = chunk.seq;
      if (chunk.createdAtMs !== undefined && Date.now() - chunk.createdAtMs > REPLAY_AGE_MS) {
        // xterm parses writes in order and calls back once this one is parsed.
        muted += 1;
        term.write(chunk.data, () => {
          muted -= 1;
        });
        return;
      }
      term.write(chunk.data);
    };

    const pageFrom = async (cursor: number | null): Promise<void> => {
      let next: number | null = cursor;
      for (;;) {
        const page = await api(
          'output',
          taskId,
          next === null ? { tailBytes: TAIL_BYTES, limit: 1000 } : { sinceSeq: next, limit: 1000 }
        );
        if (disposed) return;
        if (next !== null && page.firstSeq !== null && page.firstSeq > next + 1 && lastSeq > 0) {
          term.write('\r\n\x1b[2m— output dropped while disconnected —\x1b[0m\r\n');
        }
        page.chunks.forEach((chunk: TaskOutputChunk) => write(chunk));
        if (!page.hasMore || page.resumeAfterSeq === null) return;
        next = page.resumeAfterSeq;
      }
    };

    const offEvent = bridge.onEvent((event: AgentermEvent) => {
      if (event.kind !== 'terminal.output' || event.taskId !== taskId) return;
      if (!ready) {
        buffered.push({ seq: event.seq, data: event.data, createdAtMs: Date.now() });
        return;
      }
      if (event.seq > lastSeq + 1) {
        // A gap means events were missed; fetch it in order.
        ready = false;
        buffered.push({ seq: event.seq, data: event.data, createdAtMs: Date.now() });
        void catchUp();
        return;
      }
      write(event);
    });
    bridge.subscribeOutput(taskId);

    let retry: ReturnType<typeof setTimeout> | null = null;
    const catchUp = async (): Promise<void> => {
      try {
        await pageFrom(lastSeq);
      } catch {
        // Keep buffering and try again: flushing now would skip the missing range for good.
        if (!disposed) retry = setTimeout(() => void catchUp(), 1000);
        return;
      }
      if (disposed) return;
      buffered.sort((a, b) => a.seq - b.seq).forEach(write);
      buffered = [];
      ready = true;
    };

    void (async () => {
      try {
        await pageFrom(null);
      } catch {
        if (!disposed) term.write('\x1b[2mThe output of this task is not available.\x1b[0m\r\n');
      }
      if (disposed) return;
      buffered.sort((a, b) => a.seq - b.seq).forEach(write);
      buffered = [];
      ready = true;
      setLoading(false);
      // Take focus when a click asked for it or nothing else has it, so typing elsewhere is not stolen.
      const active = document.activeElement;
      const idle = active === null || active === document.body || host.contains(active);
      if (interactiveRef.current && (idle || useUi.getState().wantsFocus)) term.focus();
      useUi.getState().clearFocusRequest();
    })();

    const offConnection = useLive.subscribe((state, previous) => {
      if (state.connection.state === 'online' && previous.connection.state !== 'online' && ready) {
        ready = false;
        void catchUp();
      }
    });

    const inputDisposable = term.onData((data) => {
      if (muted === 0 && interactiveRef.current) bridge.sendInput(taskId, data);
    });
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (!interactiveRef.current) return;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void api('resize', taskId, { cols, rows }).catch(() => undefined);
      }, 120);
    });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
      });
    });
    observer.observe(host);
    const themeObserver = new MutationObserver(() => {
      term.options.theme = currentTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      disposed = true;
      if (retry !== null) clearTimeout(retry);
      offEvent();
      offConnection();
      bridge.unsubscribeOutput(taskId);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      searchRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [taskId]);

  React.useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.disableStdin = !interactive;
    term.options.cursorBlink = interactive;
    term.options.cursorStyle = interactive ? 'block' : 'underline';
  }, [interactive]);

  // Clicking the task again (or its row) after load puts the cursor back in the terminal.
  React.useEffect(() => {
    if (!wantsFocus || loading) return;
    if (interactive) termRef.current?.focus();
    useUi.getState().clearFocusRequest();
  }, [wantsFocus, loading, interactive]);

  return (
    <div className="relative h-full min-h-0 bg-term">
      <div ref={hostRef} className="selectable absolute inset-0" />
      {loading ? <div className="absolute top-3 right-4 text-[11px] text-ink-faint">Loading output…</div> : null}
      {searchOpen ? (
        <TerminalSearch
          search={searchRef.current}
          onClose={() => {
            setSearchOpen(false);
            searchRef.current?.clearDecorations();
            termRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

const FIND_OPTIONS = {
  decorations: {
    matchBackground: '#f2b84b55',
    matchOverviewRuler: '#f2b84b',
    activeMatchBackground: '#f2b84b',
    activeMatchColorOverviewRuler: '#f2b84b'
  }
};

function TerminalSearch({ search, onClose }: { search: SearchAddon | null; onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const [found, setFound] = React.useState<boolean | null>(null);
  const options = FIND_OPTIONS;
  const run = (direction: 'next' | 'previous'): void => {
    if (search === null || query.length === 0) return;
    setFound(direction === 'next' ? search.findNext(query, options) : search.findPrevious(query, options));
  };
  return (
    <div className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-md border border-line-strong bg-raised p-1 shadow-lg">
      <input
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setFound(
            event.target.value.length === 0
              ? null
              : (search?.findNext(event.target.value, { ...options, incremental: true }) ?? null)
          );
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') run(event.shiftKey ? 'previous' : 'next');
          if (event.key === 'Escape') onClose();
        }}
        placeholder="Find in output"
        aria-label="Find in output"
        className="h-6 w-52 rounded border border-line bg-sunken px-2 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
      />
      <span className="w-14 text-center text-[11px] text-ink-faint">{found === false ? 'No match' : ''}</span>
      <IconButton label="Previous match" shortcut="⇧↩" onClick={() => run('previous')}>
        <ChevronUp className="size-3.5" />
      </IconButton>
      <IconButton label="Next match" shortcut="↩" onClick={() => run('next')}>
        <ChevronDown className="size-3.5" />
      </IconButton>
      <IconButton label="Close search" shortcut="esc" onClick={onClose}>
        <X className="size-3.5" />
      </IconButton>
    </div>
  );
}
