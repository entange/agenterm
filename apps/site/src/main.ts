import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/martian-mono/wdth.css';
import './style.css';
import { animate, scroll } from 'motion';
import { startBoard } from './board.js';

declare const __VERSION__: string;

const REPO = 'entange/agenterm';

// --- downloads ----------------------------------------------------------------

/** Point every download link at the DMG for its architecture in a given release. */
function linkDownloads(version: string): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-download]')) {
    const arch = link.dataset['download'];
    link.href = `https://github.com/${REPO}/releases/download/v${version}/agenterm-${version}-${arch}-mac.dmg`;
  }
  for (const label of document.querySelectorAll<HTMLElement>('[data-version]')) label.textContent = `v${version}`;
}

linkDownloads(__VERSION__);

// A release may be newer than this build of the page.
void fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
  headers: { Accept: 'application/vnd.github+json' }
})
  .then((response) => (response.ok ? (response.json() as Promise<{ tag_name?: string }>) : null))
  .then((release) => {
    const version = release?.tag_name?.replace(/^v/, '');
    if (version !== undefined && /^\d+\.\d+\.\d+$/.test(version)) linkDownloads(version);
  })
  .catch(() => {
    // Offline or rate limited: the build's version stands.
  });

// --- copy buttons -------------------------------------------------------------

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', () => {
    const text = button.dataset['copy'] ?? '';
    void navigator.clipboard.writeText(text).then(() => {
      button.dataset['copied'] = '';
      const state = button.querySelector('.copy-state') ?? button;
      const before = state.textContent;
      state.textContent = 'copied';
      window.setTimeout(() => {
        delete button.dataset['copied'];
        state.textContent = before;
      }, 1400);
    });
  });
}

// --- agent tabs ---------------------------------------------------------------

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

function selectTab(tab: HTMLButtonElement, focus: boolean): void {
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    other.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(other.getAttribute('aria-controls') ?? '');
    if (panel !== null) panel.hidden = !selected;
  }
  if (focus) tab.focus();
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab, false));
  tab.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next !== undefined) selectTab(next, true);
  });
}

// --- the app screenshot --------------------------------------------------------

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const app = document.querySelector<HTMLElement>('[data-app]');
const shot = document.querySelector<HTMLImageElement>('[data-shot-img]');
const frame = document.querySelector<HTMLElement>('[data-window]');
const stage = document.querySelector<HTMLElement>('[data-stage]');

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-shot]')) {
  button.addEventListener('click', () => {
    const theme = button.dataset['shot'] ?? 'dark';
    if (shot === null || shot.src.endsWith(`/app-${theme}.jpg`)) return;
    for (const other of document.querySelectorAll<HTMLButtonElement>('[data-shot]')) {
      other.setAttribute('aria-pressed', String(other === button));
    }
    app?.classList.toggle('light', theme === 'light');
    if (reducedMotion.matches) {
      shot.src = `/app-${theme}.jpg`;
      return;
    }
    // Dip the screenshot while the band changes color around it.
    void animate(shot, { opacity: [1, 0.15] }, { duration: 0.18 }).then(() => {
      shot.src = `/app-${theme}.jpg`;
      void animate(shot, { opacity: [0.15, 1] }, { duration: 0.32 });
    });
  });
}
// Fetch the other theme early so the switch is instant.
new Image().src = '/app-light.jpg';

// The window tips up into place as it scrolls in.
if (frame !== null && stage !== null && !reducedMotion.matches) {
  scroll(
    animate(
      frame,
      { transform: ['rotateX(24deg) scale(0.88)', 'rotateX(0deg) scale(1)'], opacity: [0.4, 1] },
      { ease: 'linear' }
    ),
    { target: stage, offset: ['start end', 'start 0.2'] }
  );
}

// --- the board ----------------------------------------------------------------

const board = document.querySelector<HTMLElement>('[data-board]');
const rows = document.querySelector<HTMLElement>('[data-board-rows]');
const head = document.querySelector<HTMLElement>('[data-board-head]');
const clock = document.querySelector<HTMLElement>('[data-clock]');
const agent = document.querySelector<HTMLElement>('[data-ticker-agent]');
const command = document.querySelector<HTMLElement>('[data-ticker-command]');
const output = document.querySelector<HTMLElement>('[data-ticker-output]');
if (board && rows && head && clock && agent && command && output) {
  startBoard({ board, rows, head, clock, ticker: { agent, command, output }, reducedMotion });
}
