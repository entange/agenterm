import fs from 'node:fs';
import path from 'node:path';
import type { SessionOutputChunk } from '@agenterm/core';

export interface ReadOutputOptions {
  /** Return chunks with seq greater than this value. Absent means read the tail. */
  sinceSeq?: number | undefined;
  /** Cap on bytes for a tail read without a cursor. Defaults to 65536. */
  tailBytes?: number | undefined;
  /** Cap on chunk count. Defaults to 200. */
  limit?: number | undefined;
}

export interface ReadOutputResult {
  chunks: SessionOutputChunk[];
  resumeAfterSeq: number | null;
  hasMore: boolean;
  /** Oldest seq still held, or null when empty. A cursor below firstSeq - 1 lost data. */
  firstSeq: number | null;
}

/**
 * Per-session terminal store.
 *
 * Holds the in-memory ring (capped bytes) plus an append-only file mirror
 * at sessions/<id>/terminal.log. Sequence numbers rise monotonically per
 * session starting at 1. Slow consumers re-fetch with the resume cursor.
 * The PTY writer is never blocked by readers, and a failing mirror (disk
 * full, removed dir) is dropped instead of crashing the daemon.
 */
export class TerminalLog {
  private chunks: SessionOutputChunk[] = [];
  private heldBytes = 0;
  private seq = 0;
  private readonly maxBytes: number;
  private file: fs.WriteStream | null = null;

  constructor(options: { maxBytes?: number | undefined; file?: string | undefined } = {}) {
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    if (typeof options.file === 'string') {
      try {
        fs.mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
        const stream = fs.createWriteStream(options.file, { flags: 'a', encoding: 'utf8', mode: 0o600 });
        stream.on('error', () => {
          if (this.file === stream) this.file = null;
        });
        this.file = stream;
      } catch {
        this.file = null;
      }
    }
  }

  /** Append one output chunk. Assigns the following sequence number. */
  append(data: string): SessionOutputChunk {
    const chunk: SessionOutputChunk = {
      seq: this.seq + 1,
      data,
      createdAtMs: Date.now()
    };
    this.seq = chunk.seq;
    this.chunks.push(chunk);
    this.heldBytes += Buffer.byteLength(data, 'utf8');
    let drop = 0;
    while (drop < this.chunks.length - 1 && this.heldBytes > this.maxBytes) {
      const dropped = this.chunks[drop];
      if (dropped !== undefined) this.heldBytes -= Buffer.byteLength(dropped.data, 'utf8');
      drop++;
    }
    if (drop > 0) this.chunks.splice(0, drop);
    this.file?.write(data);
    return chunk;
  }

  /** Highest sequence assigned so far, or 0 when empty. */
  latestSeq(): number {
    return this.seq;
  }

  /**
   * Read paged scrollback.
   *
   * Without a cursor: take the newest tailBytes, then page forward from
   * the oldest chunk of that tail. With a cursor: page forward from the
   * first chunk after it, ignoring tailBytes, so a client looping on
   * resumeAfterSeq never skips data the ring still holds.
   */
  read(options: ReadOutputOptions = {}): ReadOutputResult {
    const tailBytes = options.tailBytes ?? 65_536;
    const limit = options.limit ?? 200;
    const firstSeq = this.chunks[0]?.seq ?? null;
    let start: number;
    if (typeof options.sinceSeq === 'number') {
      const cursor = options.sinceSeq;
      start = this.chunks.findIndex((entry) => entry.seq > cursor);
      if (start === -1) start = this.chunks.length;
    } else {
      let bytes = 0;
      start = this.chunks.length;
      for (let i = this.chunks.length - 1; i >= 0; i--) {
        const entry = this.chunks[i];
        if (entry === undefined) continue;
        const size = Buffer.byteLength(entry.data, 'utf8');
        if (bytes + size > tailBytes && start < this.chunks.length) break;
        bytes += size;
        start = i;
      }
    }
    const page = this.chunks.slice(start, start + limit);
    const last = page[page.length - 1];
    return {
      chunks: page,
      resumeAfterSeq: last === undefined ? null : last.seq,
      hasMore: start + page.length < this.chunks.length,
      firstSeq
    };
  }

  close(): void {
    this.file?.end();
    this.file = null;
  }
}

/**
 * Read the tail of a terminal.log mirror from disk.
 *
 * Backs scrollback for sessions whose PTY is gone (daemon restarted or
 * session ended before the ring was kept). Returns null when the file is
 * missing. Starts on a line boundary where one exists so the first row
 * is not a torn escape sequence.
 */
export function readLogTail(file: string, maxBytes = 65_536): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    if (length < size) {
      const newline = text.indexOf('\n');
      if (newline !== -1 && newline < text.length - 1) text = text.slice(newline + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
