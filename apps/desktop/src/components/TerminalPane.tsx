import type { AgentermEvent, SessionOutputChunk, SessionRecord } from '@agenterm/core';
import { IconButton } from '@agenterm/ui';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import * as React from 'react';
import { api, getBridge } from '../lib/bridge.js';
import { useLive } from '../lib/live.js';

const DARK: ITheme = {
  background: '#0d1218',
  foreground: '#d5dde8',
  cursor: '#9db2ff',
  cursorAccent: '#0d1218',
  selectionBackground: '#9db2ff40',
  black: '#1c2430',
  red: '#ef6f6c',
  green: '#6ccb9a',
  yellow: '#f2b84b',
  blue: '#5fb3f9',
  magenta: '#c49cf4',
  cyan: '#59d0d6',
  white: '#c4ccd8',
  brightBlack: '#5e6b7d',
  brightRed: '#ff8f8b',
  brightGreen: '#8fe0b5',
  brightYellow: '#ffd07a',
  brightBlue: '#8ccaff',
  brightMagenta: '#dab8ff',
  brightCyan: '#86e6ea',
  brightWhite: '#f2f5f9'
};

const LIGHT: ITheme = {
  background: '#fbfcfd',
  foreground: '#1d2733',
  cursor: '#3d5bd9',
  cursorAccent: '#fbfcfd',
  selectionBackground: '#3d5bd933',
  black: '#1d2733',
  red: '#c9423f',
  green: '#2f8f5b',
  yellow: '#a06a12',
  blue: '#1f6fc1',
  magenta: '#8a4fc7',
  cyan: '#13858b',
  white: '#8694a6',
  brightBlack: '#556375',
  brightRed: '#e0524e',
  brightGreen: '#38a86b',
  brightYellow: '#b7791f',
  brightBlue: '#2f86e0',
  brightMagenta: '#a066e0',
  brightCyan: '#1aa1a8',
  brightWhite: '#16202b'
};

function currentTheme(): ITheme {
  return document.documentElement.classList.contains('dark') ? DARK : LIGHT;
}

/** Keys that belong to the app, not the program running in the terminal. */
function isAppShortcut(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  if (!event.metaKey && navigator.platform.startsWith('Mac')) return false;
  return /^[knj[\]1-9f]$/i.test(event.key) || (event.shiftKey && event.key.toLowerCase() === 'h');
}

const TAIL_BYTES = 512 * 1024;

/**
 * Live terminal for one session.
 *
 * Ordering is the hard part: subscribe first and buffer live chunks,
 * page in the full retained scrollback, then flush only buffered chunks
 * newer than what was written. After a reconnect, catch up from the last
 * written seq and say so if the ring already dropped some of it.
 */
export function TerminalPane({
  session,
  interactive
}: {
  session: SessionRecord;
  interactive: boolean;
}): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<SearchAddon | null>(null);
  const termRef = React.useRef<Terminal | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const sessionId = session.id;

  React.useEffect(() => {
    const host = hostRef.current;
    const bridge = getBridge();
    if (host === null || bridge === null) return undefined;
    let disposed = false;
    let ready = false;
    let lastSeq = 0;
    let buffered: Array<{ seq: number; data: string }> = [];
    const term = new Terminal({
      fontFamily: "'JetBrains Mono Variable', ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.22,
      letterSpacing: 0,
      cursorBlink: interactive,
      cursorStyle: interactive ? 'block' : 'underline',
      cursorInactiveStyle: 'outline',
      disableStdin: !interactive,
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
      if (event.type === 'keydown' && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        setSearchOpen(true);
        return false;
      }
      return !isAppShortcut(event);
    });

    const write = (chunk: { seq: number; data: string }): void => {
      if (chunk.seq <= lastSeq) return;
      term.write(chunk.data);
      lastSeq = chunk.seq;
    };

    const pageFrom = async (cursor: number | null): Promise<void> => {
      let next: number | null = cursor;
      for (;;) {
        const page = await api(
          'output',
          sessionId,
          next === null ? { tailBytes: TAIL_BYTES, limit: 1000 } : { sinceSeq: next, limit: 1000 }
        );
        if (disposed) return;
        if (next !== null && page.firstSeq !== null && page.firstSeq > next + 1 && lastSeq > 0) {
          term.write('\r\n\x1b[2m— output dropped while disconnected —\x1b[0m\r\n');
        }
        page.chunks.forEach((chunk: SessionOutputChunk) => write(chunk));
        if (!page.hasMore || page.resumeAfterSeq === null) return;
        next = page.resumeAfterSeq;
      }
    };

    const offEvent = bridge.onEvent((event: AgentermEvent) => {
      if (event.kind !== 'terminal.output' || event.sessionId !== sessionId) return;
      if (!ready) {
        buffered.push({ seq: event.seq, data: event.data });
        return;
      }
      if (event.seq > lastSeq + 1) {
        // A gap means events were missed; fetch it in order.
        ready = false;
        buffered.push({ seq: event.seq, data: event.data });
        void catchUp();
        return;
      }
      write(event);
    });
    bridge.subscribeOutput(sessionId);

    const catchUp = async (): Promise<void> => {
      try {
        await pageFrom(lastSeq);
      } catch {
        // Reconnect will retry.
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
        if (!disposed) term.write('\x1b[2mScrollback is not available for this session.\x1b[0m\r\n');
      }
      if (disposed) return;
      buffered.sort((a, b) => a.seq - b.seq).forEach(write);
      buffered = [];
      ready = true;
      setLoading(false);
      if (interactive) term.focus();
    })();

    const offConnection = useLive.subscribe((state, previous) => {
      if (state.connection.state === 'online' && previous.connection.state !== 'online' && ready) {
        ready = false;
        void catchUp();
      }
    });

    const inputDisposable = interactive ? term.onData((data) => bridge.sendInput(sessionId, data)) : null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (!interactive) return;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void api('resize', sessionId, { cols, rows }).catch(() => undefined);
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
      offEvent();
      offConnection();
      bridge.unsubscribeOutput(sessionId);
      inputDisposable?.dispose();
      resizeDisposable.dispose();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      searchRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [sessionId, interactive]);

  return (
    <div className="relative h-full min-h-0 bg-term">
      <div ref={hostRef} className="selectable absolute inset-0" />
      {loading ? <div className="absolute top-3 right-4 text-[11px] text-ink-faint">Loading scrollback…</div> : null}
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

function TerminalSearch({ search, onClose }: { search: SearchAddon | null; onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const [found, setFound] = React.useState<boolean | null>(null);
  const options = {
    decorations: {
      matchBackground: '#f2b84b55',
      matchOverviewRuler: '#f2b84b',
      activeMatchBackground: '#f2b84b',
      activeMatchColorOverviewRuler: '#f2b84b'
    }
  };
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
