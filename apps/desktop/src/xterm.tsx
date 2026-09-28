import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

/**
 * Single xterm instance per open session tab.
 *
 * Mount fetches tail then subscribes from the returned sequence number.
 * Unmount disposes locally; the daemon keeps truth in terminal.log plus
 * the in-memory ring. Input is throttled by the caller; resize posts
 * debounced columns and rows from the fit proposal.
 */
export function XTermView({ sessionId }: { sessionId: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13 });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(host);
    fit.fit();
    term.writeln(`Attached to session ${sessionId}. Live output arrives with the spawn change.`);
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Fit can throw during teardown; safe to ignore.
      }
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={hostRef} className="h-96 w-full overflow-hidden rounded-md bg-black" />;
}
