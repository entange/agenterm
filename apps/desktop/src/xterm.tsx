import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { getBridge } from './daemon.js';

/**
 * Single xterm instance per open session tab.
 *
 * Mount fetches tail then subscribes from the returned sequence number.
 * Unmount disposes locally; the daemon keeps truth in terminal.log plus
 * the in-memory ring. Input is throttled on a short flush timer; resize
 * posts debounced columns and rows from the fit proposal. Attached
 * sessions render read-only with no PTY takeover.
 */
export function XTermView({ sessionId, readOnly }: { sessionId: string; readOnly: boolean }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const bridge = getBridge();
    const term = new Terminal({ cursorBlink: !readOnly, fontSize: 13, disableStdin: readOnly });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(host);
    fit.fit();
    let cursor = 0;
    let alive = true;
    let pending = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const flushInput = (): void => {
      flushTimer = null;
      if (pending.length === 0 || !alive) {
        pending = '';
        return;
      }
      const data = pending;
      pending = '';
      void bridge?.input(sessionId, data).catch(() => undefined);
    };

    void (async () => {
      try {
        const tail = await bridge?.output(sessionId);
        if (!alive || tail === undefined) return;
        for (const chunk of tail.chunks) {
          term.write(chunk.data);
          cursor = Math.max(cursor, chunk.seq);
        }
      } catch {
        if (alive) term.writeln('Scrollback unavailable for this session.');
      }
    })();

    const unsubscribe = bridge?.onEvent((event) => {
      if (!alive) return;
      if (event.kind !== 'terminal.output') return;
      if (event.sessionId !== sessionId || event.seq <= cursor) return;
      cursor = event.seq;
      term.write(event.data);
    });

    if (!readOnly) {
      term.onData((data: string) => {
        pending += data;
        if (flushTimer === null) {
          flushTimer = setTimeout(flushInput, 30);
        }
      });
    }

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Fit can throw during teardown; safe to ignore.
      }
      if (readOnly) return;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        const dims = fit.proposeDimensions();
        if (dims !== undefined && alive) {
          void bridge?.resize(sessionId, dims.cols, dims.rows).catch(() => undefined);
        }
      }, 300);
    });
    observer.observe(host);

    return () => {
      alive = false;
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      observer.disconnect();
      unsubscribe?.();
      term.dispose();
    };
  }, [sessionId, readOnly]);

  return <div ref={hostRef} className="h-96 w-full overflow-hidden rounded-md bg-black" />;
}
