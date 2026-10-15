/**
 * The hero: `agenterm ls` as a split-flap departures board. Agents' commands
 * type out on the ticker underneath and the board flips to match. Scripted,
 * not live, and short enough to loop.
 */
import { animate, inView } from 'motion';

type Status = 'running' | 'failed' | 'stopped';

interface Task {
  id: string;
  status: Status;
  by: string;
  ports: string;
  /** Demo-clock second the task started. */
  startedAt: number;
}

interface Column {
  key: 'id' | 'lamp' | 'status' | 'age' | 'by' | 'ports';
  width: number;
}

// The same columns, in the same order, as `agenterm ls`.
const WIDE: Column[] = [
  { key: 'id', width: 7 },
  { key: 'lamp', width: 1 },
  { key: 'status', width: 7 },
  { key: 'age', width: 3 },
  { key: 'by', width: 11 },
  { key: 'ports', width: 5 }
];
const NARROW: Column[] = [
  { key: 'id', width: 6 },
  { key: 'lamp', width: 1 },
  { key: 'status', width: 7 },
  { key: 'age', width: 3 }
];
const LABELS: Record<Column['key'], string> = {
  id: 'ID',
  lamp: '',
  status: 'STATUS',
  age: 'AGE',
  by: 'BY',
  ports: 'PORTS'
};

const ROWS = 6;
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** Demo seconds that pass per real second. */
const SPEED = 15;
const CELL_GAP = 2;

// --- one flap -----------------------------------------------------------------

class Flap {
  readonly el = document.createElement('span');
  private readonly top: HTMLElement;
  private readonly bottom: HTMLElement;
  private readonly leafTop: HTMLElement;
  private readonly leafBottom: HTMLElement;
  private value = ' ';
  private target = ' ';
  private flipping: Promise<void> | null = null;

  constructor() {
    this.el.className = 'flap';
    this.el.innerHTML =
      '<span class="half top"><b> </b></span><span class="half bottom"><b> </b></span>' +
      '<span class="leaf top"><b></b></span><span class="leaf bottom"><b></b></span>';
    const [top, bottom, leafTop, leafBottom] = [...this.el.children] as HTMLElement[];
    this.top = top!;
    this.bottom = bottom!;
    this.leafTop = leafTop!;
    this.leafBottom = leafBottom!;
  }

  set(char: string, instant: boolean): Promise<void> {
    this.target = char;
    if (instant) {
      this.value = char;
      this.write(this.top, char);
      this.write(this.bottom, char);
      return Promise.resolve();
    }
    // A flip in progress picks up the new target when it gets there.
    this.flipping ??= this.run().finally(() => {
      this.flipping = null;
    });
    return this.flipping;
  }

  /** Riffle through a few glyphs, then land, like the real thing. */
  private async run(): Promise<void> {
    let riffle = this.target === ' ' ? 1 : 1 + Math.floor(Math.random() * 3);
    while (this.value !== this.target) {
      riffle -= 1;
      const next = riffle > 0 ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)]! : this.target;
      await this.step(next, next === this.target);
    }
  }

  private async step(next: string, landing: boolean): Promise<void> {
    const current = this.value;
    this.write(this.top, next);
    this.write(this.leafTop, current);
    this.write(this.leafBottom, next);
    this.el.classList.add('flipping');
    await animate(
      this.leafTop,
      { transform: ['rotateX(0deg)', 'rotateX(-90deg)'] },
      { duration: 0.055, ease: 'easeIn' }
    );
    await animate(
      this.leafBottom,
      {
        transform: landing
          ? ['rotateX(90deg)', 'rotateX(-10deg)', 'rotateX(0deg)']
          : ['rotateX(90deg)', 'rotateX(0deg)']
      },
      { duration: landing ? 0.16 : 0.055, ease: 'easeOut' }
    );
    this.write(this.bottom, next);
    this.value = next;
    this.el.classList.remove('flipping');
    this.leafTop.style.transform = '';
    this.leafBottom.style.transform = '';
  }

  private write(half: HTMLElement, char: string): void {
    half.firstElementChild!.textContent = char;
  }
}

/** A run of flaps showing one fixed-width field. */
class Field {
  readonly el = document.createElement('span');
  readonly flaps: Flap[];

  constructor(width: number) {
    this.el.className = 'field';
    this.flaps = Array.from({ length: width }, () => new Flap());
    this.el.append(...this.flaps.map((flap) => flap.el));
  }

  set(text: string, instant: boolean, delay: number): Promise<void> {
    const chars = text.toUpperCase().padEnd(this.flaps.length).slice(0, this.flaps.length);
    return Promise.all(
      this.flaps.map(async (flap, index) => {
        if (!instant) await sleep(delay + index * 28);
        await flap.set(chars[index]!, instant);
      })
    ).then(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- the board ----------------------------------------------------------------

interface BoardOptions {
  board: HTMLElement;
  rows: HTMLElement;
  head: HTMLElement;
  clock: HTMLElement;
  ticker: { agent: HTMLElement; command: HTMLElement; output: HTMLElement };
  reducedMotion: MediaQueryList;
}

function age(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function clockText(seconds: number): string {
  const minutes = Math.floor(seconds / 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}`;
}

export function startBoard(options: BoardOptions): void {
  const { board, rows, head, clock: clockEl, ticker } = options;
  let instant = options.reducedMotion.matches;
  let visible = false;
  const narrow = matchMedia('(max-width: 640px)');

  /** Demo clock in seconds since midnight. */
  let now = 10 * 3600 + 42 * 60;
  let tasks: (Task | null)[] = [];
  let columns: Column[] = [];
  let fields: Map<Column['key'], Field>[] = [];
  let rowEls: HTMLElement[] = [];
  const clockFields = [new Field(2), new Field(2)];
  clockEl.replaceChildren(
    clockFields[0]!.el,
    Object.assign(document.createElement('i'), { textContent: ':' }),
    clockFields[1]!.el
  );

  inView(board, () => {
    visible = true;
    return () => {
      visible = false;
    };
  });
  const idle = (): boolean => !visible || document.hidden;

  async function wait(ms: number): Promise<void> {
    if (instant) return;
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, 100);
      await sleep(step);
      if (!idle()) left -= step;
    }
  }

  // --- layout -------------------------------------------------------------------

  function build(): void {
    columns = narrow.matches ? NARROW : WIDE;
    head.replaceChildren(
      ...columns.map((column) => {
        const label = document.createElement('span');
        label.className = 'label';
        label.style.setProperty('--w', String(column.width));
        label.textContent = LABELS[column.key];
        return label;
      })
    );
    fields = [];
    rowEls = [];
    rows.replaceChildren();
    for (let index = 0; index < ROWS; index += 1) {
      const row = document.createElement('li');
      row.className = 'row';
      const byKey = new Map<Column['key'], Field>();
      for (const column of columns) {
        if (column.key === 'lamp') {
          const lamp = document.createElement('span');
          lamp.className = 'lamp';
          row.append(lamp);
          continue;
        }
        const field = new Field(column.width);
        byKey.set(column.key, field);
        row.append(field.el);
      }
      row.append(Object.assign(document.createElement('span'), { className: 'sweep' }));
      rows.append(row);
      rowEls.push(row);
      fields.push(byKey);
    }
    size();
    for (let index = 0; index < ROWS; index += 1) void renderRow(index, true);
  }

  /** Cell width from the board's width, so the flaps always fill it exactly. */
  function size(): void {
    const cells = columns.reduce((sum, column) => sum + column.width, 0);
    const groupGap = narrow.matches ? 8 : 14;
    const width = rows.clientWidth;
    const cell = (width - (cells - columns.length) * CELL_GAP - (columns.length - 1) * groupGap) / cells;
    board.style.setProperty('--cell', `${Math.floor(cell * 100) / 100}px`);
    board.style.setProperty('--group-gap', `${groupGap}px`);
  }

  new ResizeObserver(size).observe(rows);
  narrow.addEventListener('change', build);

  // --- rendering ----------------------------------------------------------------

  function renderRow(index: number, quick = instant, stagger = 0): Promise<void> {
    const task = tasks[index] ?? null;
    const row = rowEls[index];
    if (row === undefined) return Promise.resolve();
    row.dataset['status'] = task?.status ?? '';
    const values: Record<string, string> = {
      id: task?.id ?? '',
      status: task?.status ?? '',
      age: task === null ? '' : age(now - task.startedAt),
      by: task?.by ?? '',
      ports: task?.ports ?? ''
    };
    const map = fields[index]!;
    let delay = stagger;
    const flips: Promise<void>[] = [];
    for (const column of columns) {
      const field = map.get(column.key);
      if (field === undefined) continue;
      flips.push(field.set(values[column.key] ?? '', quick, delay));
      delay += column.width * 28;
    }
    return Promise.all(flips).then(() => undefined);
  }

  function renderClock(quick = instant): void {
    const text = clockText(now);
    void clockFields[0]!.set(text.slice(0, 2), quick, 0);
    void clockFields[1]!.set(text.slice(2), quick, 0);
  }

  /** Only the age column and the clock change as time passes. */
  function tick(): void {
    renderClock();
    for (const [index, task] of tasks.entries()) {
      if (task === null || task.status !== 'running') continue;
      void fields[index]?.get('age')?.set(age(now - task.startedAt), instant, 0);
    }
  }

  setInterval(() => {
    if (instant || idle()) return;
    const before = Math.floor(now / 60);
    now += SPEED;
    // Ages under a minute show seconds; everything else changes once a minute.
    const fresh = tasks.some((task) => task !== null && task.status === 'running' && now - task.startedAt < 75);
    if (fresh || Math.floor(now / 60) !== before) tick();
  }, 1000);

  function set(index: number, task: Task | null): Promise<void> {
    tasks[index] = task;
    return renderRow(index);
  }

  function find(id: string): number {
    return tasks.findIndex((task) => task?.id === id);
  }

  function sweep(index: number): void {
    const el = rowEls[index]?.querySelector('.sweep');
    if (el === null || el === undefined || instant) return;
    void animate(
      el,
      { opacity: [0.9, 0], transform: ['scaleX(0.2)', 'scaleX(1)'] },
      { duration: 1.1, ease: 'easeOut' }
    );
  }

  // --- the ticker -----------------------------------------------------------------

  async function command(agent: string, text: string): Promise<void> {
    ticker.agent.textContent = agent;
    ticker.output.textContent = '';
    if (instant) {
      ticker.command.textContent = text;
      return;
    }
    ticker.command.parentElement?.classList.add('typing');
    for (let index = 1; index <= text.length; index += 1) {
      ticker.command.textContent = text.slice(0, index);
      await wait(22 + Math.random() * 30);
    }
    ticker.command.parentElement?.classList.remove('typing');
    await wait(280);
  }

  function output(text: string, tone: '' | 'ok' | 'fail' = ''): void {
    ticker.output.textContent = text;
    ticker.output.dataset['tone'] = tone;
    if (!instant)
      void animate(ticker.output, { opacity: [0, 1], transform: ['translateY(4px)', 'none'] }, { duration: 0.25 });
  }

  // --- the script -----------------------------------------------------------------

  function opening(): (Task | null)[] {
    return [
      { id: 'web', status: 'running', by: 'claude code', ports: ':5173', startedAt: now - 40 * 60 },
      { id: 'api', status: 'running', by: 'claude code', ports: ':3000', startedAt: now - 40 * 60 },
      { id: 'tests', status: 'running', by: 'codex', ports: '', startedAt: now - 38 * 60 },
      { id: 'worker', status: 'running', by: 'you', ports: '', startedAt: now - 2 * 3600 - 9 * 60 },
      { id: 'db', status: 'running', by: 'you', ports: ':5432', startedAt: now - 26 * 3600 },
      null
    ];
  }

  async function play(): Promise<void> {
    await command('Codex', 'agenterm run --id web "npm run dev"');
    const web = find('web');
    sweep(web);
    output('already running: web (npm run dev). Not started again.', 'ok');
    await wait(3200);

    const tests = find('tests');
    await set(tests, { ...tasks[tests]!, status: 'failed' });
    await wait(1400);
    await command('Claude Code', 'agenterm logs tests -n 3');
    output('✗ cart.test.ts  applies the discount once: expected 81 to be 90', 'fail');
    await wait(3000);
    await command('Claude Code', 'agenterm run --id tests --restart "npx vitest"');
    await set(tests, { id: 'tests', status: 'running', by: 'claude code', ports: '', startedAt: now });
    output('started tests: npx vitest', 'ok');
    await wait(2600);

    await command('Codex', 'agenterm run --id docs "npm run docs"');
    await set(5, { id: 'docs', status: 'running', by: 'codex', ports: ':4000', startedAt: now });
    output('started docs: npm run docs', 'ok');
    await wait(2600);

    await command('Claude Code', 'agenterm stop worker');
    const worker = find('worker');
    await set(worker, { ...tasks[worker]!, status: 'stopped' });
    output('worker: stopped');
    await wait(4200);
  }

  async function loop(): Promise<void> {
    // Power on: every row flips in from blank. With reduced motion the board is simply there.
    tasks = instant ? opening() : Array.from({ length: ROWS }, () => null);
    build();
    renderClock(true);
    if (instant) {
      ticker.agent.textContent = 'Codex';
      ticker.command.textContent = 'agenterm run --id web "npm run dev"';
      output('already running: web (npm run dev). Not started again.', 'ok');
      return;
    }
    await wait(250);
    for (;;) {
      await Promise.all(
        opening().map((task, index) => {
          tasks[index] = task;
          return renderRow(index, false, index * 90);
        })
      );
      await wait(900);
      await play();
      ticker.agent.textContent = '';
      ticker.command.textContent = '';
      ticker.output.textContent = '';
    }
  }

  options.reducedMotion.addEventListener('change', (event) => {
    instant = event.matches;
  });
  void loop();
}
