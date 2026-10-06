import crypto from 'node:crypto';
import type { CommandRecord } from '@agenterm/core';
import { redactText } from '@agenterm/core';

/**
 * Prompt-anchored command heuristic.
 *
 * Clusters raw terminal output into command rows without shell
 * integration: a line ending in a prompt marker opens a command with
 * the text that follows the marker, and the following prompt closes
 * it with duration plus output line count. Exit codes stay null
 * without integration markers; the row says unknown instead of
 * guessing. Control sequences are stripped before matching so
 * colored prompts still anchor.
 */

const MAX_TEXT = 2000;

/** Longest line the prompt matcher inspects; TUI redraws can emit huge lines. */
const MAX_LINE = 4096;

/** Cap on buffered bytes without a newline, so full-screen TUIs cannot grow memory. */
const MAX_PENDING = 64 * 1024;

function stripSequences(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '');
}

function splitPrompt(line: string): string | null {
  const clean = stripSequences(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line).replace(/\s+$/, '');
  // Prompt marker within the first 200 chars: bounded search, no backtracking across long lines.
  const match = /^([^\n]{0,200}?[$%#>])\s+(.+)$/.exec(clean);
  if (match === null) return null;
  const text = redactText((match[2] ?? '').trim()).slice(0, MAX_TEXT);
  return text.length > 0 ? text : null;
}

export interface CommandSave {
  (record: CommandRecord): void;
}

/** Per-session tracker fed with terminal output chunks. Never throws. */
export class CommandTracker {
  private pending = '';
  private open: CommandRecord | null = null;
  private readonly finished: CommandRecord[] = [];
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly pid: number | null;
  private readonly save: CommandSave | undefined;
  private readonly now: () => number;

  constructor(options: {
    sessionId: string;
    cwd: string;
    pid?: number | null | undefined;
    save?: CommandSave | undefined;
    now?: (() => number) | undefined;
  }) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.pid = options.pid ?? null;
    this.save = options.save;
    this.now = options.now ?? Date.now;
  }

  /** Completed plus currently open rows, oldest first. */
  rows(): CommandRecord[] {
    return [...this.finished];
  }

  /** Feed one terminal output chunk. */
  feed(data: string): void {
    try {
      this.pending += data;
      const parts = this.pending.split('\n');
      this.pending = parts.pop() ?? '';
      if (this.pending.length > MAX_PENDING) this.pending = this.pending.slice(-MAX_PENDING);
      for (const part of parts) {
        this.consumeLine(part);
      }
    } catch {
      // Heuristic input never breaks the stream.
    }
  }

  private emit(record: CommandRecord): void {
    const last = this.finished[this.finished.length - 1];
    if (last !== undefined && last.id === record.id) {
      this.finished[this.finished.length - 1] = { ...record };
    } else {
      this.finished.push({ ...record });
    }
    while (this.finished.length > 200) {
      this.finished.shift();
    }
    try {
      this.save?.({ ...record });
    } catch {
      // Persistence is best effort.
    }
  }

  private consumeLine(raw: string): void {
    const text = splitPrompt(raw);
    if (text === null) {
      if (this.open !== null) {
        this.open = {
          ...this.open,
          outputLineCount: (this.open.outputLineCount ?? 0) + 1
        };
      }
      return;
    }
    const atMs = this.now();
    if (this.open !== null) {
      const closed: CommandRecord = {
        ...this.open,
        durationMs: Math.max(0, atMs - this.open.startedAtMs)
      };
      this.emit(closed);
    }
    const record: CommandRecord = {
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      text,
      cwd: this.cwd,
      pid: this.pid,
      startedAtMs: atMs,
      durationMs: null,
      exitCode: null,
      outputLineCount: 0
    };
    this.open = record;
    this.emit({ ...record });
  }

  /** Close any open command at session end. */
  closeAll(atMs?: number): void {
    if (this.open === null) return;
    const closed: CommandRecord = {
      ...this.open,
      durationMs: Math.max(0, (atMs ?? this.now()) - this.open.startedAtMs)
    };
    this.open = null;
    this.emit(closed);
  }
}
