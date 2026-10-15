/**
 * The hero demo: an agent's tool calls on one side, agenterm's task list
 * reacting on the other. Scripted, not live, and short enough to loop.
 */

type Status = 'starting' | 'running' | 'failed';

interface Task {
  id: string;
  status: Status;
  port: string;
  preview: string;
  /** Demo-clock second the task started. */
  startedAt: number;
  row: HTMLLIElement;
}

interface DemoOptions {
  transcript: HTMLOListElement;
  taskList: HTMLUListElement;
  running: HTMLElement;
  reducedMotion: MediaQueryList;
}

const TRANSCRIPT_LIMIT = 40;

export function startDemo(options: DemoOptions): void {
  const { transcript, taskList, running } = options;
  let instant = options.reducedMotion.matches;
  let visible = true;
  /** Demo clock in seconds; jumps forward for "40 minutes later". */
  let clock = 0;
  const tasks = new Map<string, Task>();

  // Pause while the demo is off screen or the tab is hidden.
  new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
  }).observe(taskList);

  const idle = (): boolean => !visible || document.hidden;

  async function wait(ms: number): Promise<void> {
    if (instant) return;
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, 100);
      await new Promise((resolve) => setTimeout(resolve, step));
      if (!idle()) left -= step;
    }
  }

  // --- the task list ----------------------------------------------------------

  function age(task: Task): string {
    const seconds = Math.max(0, Math.floor(clock - task.startedAt));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  }

  function renderTask(task: Task): void {
    task.row.dataset['status'] = task.status;
    const label = task.status === 'failed' ? 'failed (exit 1)' : task.preview;
    task.row.querySelector('.task-port')!.textContent = task.port;
    task.row.querySelector('.task-age')!.textContent = age(task);
    task.row.querySelector('.task-preview')!.textContent = label;
    const count = [...tasks.values()].filter((each) => each.status !== 'failed').length;
    running.textContent = `${count} running`;
  }

  function addTask(id: string): Task {
    const row = document.createElement('li');
    row.className = 'task';
    row.innerHTML =
      '<span class="task-dot"></span><span class="task-id"></span><span class="task-port"></span>' +
      '<span class="task-age"></span><span class="task-preview"></span><span class="task-badge">already running</span>';
    row.querySelector('.task-id')!.textContent = id;
    const task: Task = { id, status: 'starting', port: '', preview: 'starting…', startedAt: clock, row };
    tasks.set(id, task);
    taskList.append(row);
    renderTask(task);
    return task;
  }

  function update(id: string, change: Partial<Omit<Task, 'id' | 'row'>>): void {
    const task = tasks.get(id);
    if (task === undefined) return;
    Object.assign(task, change);
    renderTask(task);
  }

  setInterval(() => {
    if (instant || idle()) return;
    clock += 1;
    for (const task of tasks.values()) renderTask(task);
  }, 1000);

  // --- the transcript ---------------------------------------------------------

  function line(className: string, text = ''): HTMLLIElement {
    const item = document.createElement('li');
    item.className = className;
    item.textContent = text;
    transcript.append(item);
    while (transcript.children.length > TRANSCRIPT_LIMIT) transcript.firstElementChild?.remove();
    follow();
    return item;
  }

  /** Keep the newest line in view once the transcript overflows. */
  function follow(): void {
    const full = transcript.scrollHeight > transcript.clientHeight;
    transcript.classList.toggle('full', full);
    transcript.scrollTop = transcript.scrollHeight;
  }

  async function say(text: string): Promise<void> {
    line('say', text);
    await wait(700);
  }

  async function call(command: string): Promise<void> {
    const item = line('call');
    const text = document.createElement('span');
    item.append(text);
    if (instant) {
      text.textContent = command;
      follow();
      return;
    }
    item.classList.add('typing');
    for (let index = 1; index <= command.length; index += 1) {
      text.textContent = command.slice(0, index);
      follow();
      await wait(18 + Math.random() * 26);
    }
    item.classList.remove('typing');
    await wait(260);
  }

  async function result(...lines: [className: string, text: string][]): Promise<void> {
    for (const [className, text] of lines) line(`result ${className}`, text);
    await wait(900);
  }

  async function flash(id: string): Promise<void> {
    const row = tasks.get(id)?.row;
    if (row === undefined) return;
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
    if (instant) row.classList.remove('flash');
    await wait(400);
  }

  // --- the script -------------------------------------------------------------

  async function play(): Promise<void> {
    clock = 0;
    tasks.clear();
    transcript.replaceChildren();
    transcript.classList.remove('full');
    taskList.replaceChildren();
    running.textContent = '0 running';

    await say('Starting the dev server so I can check the checkout page.');
    await call('agenterm run --id web "npm run dev"');
    addTask('web');
    await wait(700);
    update('web', { status: 'running', port: ':5173', preview: 'VITE v7.1.4  ready in 388 ms' });
    await result(['ok', 'started web · running · :5173']);

    await say('And the API and a test watcher.');
    await call('agenterm run --id api "npm run dev"');
    addTask('api');
    await wait(600);
    update('api', { status: 'running', port: ':3000', preview: 'GET /api/cart 200 14ms' });
    await result(['ok', 'started api · running · :3000']);
    await call('agenterm run --id tests "npx vitest"');
    addTask('tests');
    await wait(800);
    update('tests', { status: 'running', preview: '✓ 42 passed · waiting for changes' });
    await result(['ok', 'started tests · running']);

    await wait(500);
    line('gap', '40 minutes later');
    clock += 40 * 60;
    for (const task of tasks.values()) renderTask(task);
    await wait(900);

    await say('Making sure the dev server is up before I test the fix.');
    await call('agenterm run --id web "npm run dev"');
    await flash('web');
    await result(['same', `already running web · :5173 · up ${age(tasks.get('web')!)}`]);

    update('tests', { status: 'failed' });
    await wait(900);
    await say('The tests just failed. Reading their output.');
    await call('agenterm logs tests -n 3');
    await result(
      ['fail', '✗ src/cart.test.ts › applies the discount once'],
      ['dim', 'expected 81 to be 90'],
      ['dim', 'Tests  1 failed | 41 passed']
    );
    await say('Fixed: the coupon was applied twice. Restarting the tests.');
    await call('agenterm run --id tests --restart "npx vitest"');
    update('tests', { status: 'starting', preview: 'starting…', startedAt: clock });
    await wait(900);
    update('tests', { status: 'running', preview: '✓ 42 passed · waiting for changes' });
    await result(['ok', 'restarted tests · running']);
  }

  async function loop(): Promise<void> {
    for (;;) {
      await play();
      if (instant) return;
      await wait(5000);
      transcript.classList.add('fade');
      taskList.classList.add('fade');
      await wait(500);
      transcript.classList.remove('fade');
      taskList.classList.remove('fade');
    }
  }

  options.reducedMotion.addEventListener('change', (event) => {
    instant = event.matches;
  });
  void loop();
}
