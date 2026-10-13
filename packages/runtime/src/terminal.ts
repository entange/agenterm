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
  private readonly filePath: string | null;
  private readonly maxFileBytes: number;
  private fileBytes = 0;
  /** Bytes not mirrored because the disk fell behind; noted in the log once it catches up. */
  private skippedBytes = 0;

  constructor(
    options: { maxBytes?: number | undefined; file?: string | undefined; maxFileBytes?: number | undefined } = {}
  ) {
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.maxFileBytes = options.maxFileBytes ?? MAX_LOG_FILE_BYTES;
    this.filePath = typeof options.file === 'string' ? options.file : null;
    if (this.filePath !== null) {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        try {
          this.fileBytes = fs.statSync(this.filePath).size;
        } catch {
          this.fileBytes = 0;
        }
        this.file = this.openMirror(this.filePath);
      } catch {
        this.file = null;
      }
    }
  }

  private openMirror(file: string): fs.WriteStream {
    // Opened synchronously so the file exists (and can rotate) before the first write lands.
    const fd = fs.openSync(file, 'a', 0o600);
    const stream = fs.createWriteStream(file, { fd, encoding: 'utf8' });
    stream.on('error', () => {
      if (this.file === stream) this.file = null;
    });
    return stream;
  }

  /**
   * Append to terminal.log. Past maxFileBytes the file rotates to
   * terminal.log.1 (replacing the previous one), so disk use per session
   * stays under twice the cap. When the disk cannot keep up, bytes are
   * skipped rather than buffered without bound.
   */
  private mirror(data: string, bytes: number): void {
    const file = this.file;
    if (file === null || this.filePath === null) return;
    if (file.writableLength > MAX_PENDING_WRITE_BYTES) {
      this.skippedBytes += bytes;
      return;
    }
    let text = data;
    let size = bytes;
    if (this.skippedBytes > 0) {
      const note = `\r\n[agenterm: ${this.skippedBytes} bytes of output were not saved to disk]\r\n`;
      this.skippedBytes = 0;
      text = note + data;
      size += Buffer.byteLength(note, 'utf8');
    }
    if (this.fileBytes + size > this.maxFileBytes && this.fileBytes > 0) {
      try {
        // An open stream keeps writing to the renamed file until it is ended.
        fs.renameSync(this.filePath, `${this.filePath}.1`);
        file.end();
        this.file = this.openMirror(this.filePath);
        this.fileBytes = 0;
      } catch {
        // Rotation is best effort (Windows cannot rename an open file).
      }
    }
    this.file?.write(text);
    this.fileBytes += size;
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
    const bytes = Buffer.byteLength(data, 'utf8');
    this.heldBytes += bytes;
    let drop = 0;
    while (drop < this.chunks.length - 1 && this.heldBytes > this.maxBytes) {
      const dropped = this.chunks[drop];
      if (dropped !== undefined) this.heldBytes -= Buffer.byteLength(dropped.data, 'utf8');
      drop++;
    }
    if (drop > 0) this.chunks.splice(0, drop);
    this.mirror(data, bytes);
    return chunk;
  }

  private released = false;

  /**
   * Drop the in-memory ring of an ended session whose bytes are on disk.
   * With hundreds of sessions, ended rings would otherwise pin memory.
   */
  release(): void {
    this.released = true;
    this.chunks = [];
    this.heldBytes = 0;
  }

  isReleased(): boolean {
    return this.released;
  }

  /** Everything the ring still holds, oldest first. */
  text(): string {
    return this.chunks.map((chunk) => chunk.data).join('');
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

  /** Stop mirroring. Resolves once buffered bytes are flushed and the file is closed. */
  close(): Promise<void> {
    const file = this.file;
    this.file = null;
    if (file === null || file.closed) return Promise.resolve();
    return new Promise((resolve) => {
      file.once('close', () => resolve());
      file.once('error', () => resolve());
      file.end();
    });
  }
}

/** terminal.log rotates past this size; one previous generation is kept. */
export const MAX_LOG_FILE_BYTES = 16 * 1024 * 1024;

/** Mirror bytes waiting on the disk beyond which new output is skipped. */
const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;

/**
 * Read the tail of a terminal.log mirror from disk.
 *
 * Backs scrollback for sessions whose PTY is gone (daemon restarted or
 * session ended before the ring was kept). Returns null when the file is
 * missing. Starts on a line boundary where one exists so the first row
 * is not a torn escape sequence.
 */
export function readLogTail(file: string, maxBytes = 65_536): string | null {
  return tailText(file, maxBytes, (fd, buffer, position) => fs.readSync(fd, buffer, 0, buffer.length, position));
}

/** readLogTail without blocking the event loop, for scans across many sessions. */
export async function readLogTailAsync(file: string, maxBytes = 65_536): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, 'r');
    const size = (await handle.stat()).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    if (length < maxBytes && !file.endsWith('.1')) {
      const before = await readLogTailAsync(`${file}.1`, maxBytes - length);
      if (before !== null) return before + text;
    }
    return fromLineBoundary(text, length < size);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function fromLineBoundary(text: string, clipped: boolean): string {
  if (!clipped) return text;
  const newline = text.indexOf('\n');
  return newline !== -1 && newline < text.length - 1 ? text.slice(newline + 1) : text;
}

function tailText(
  file: string,
  maxBytes: number,
  read: (fd: number, buffer: Buffer, position: number) => number
): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    read(fd, buffer, size - length);
    const text = buffer.toString('utf8');
    if (length < maxBytes && !file.endsWith('.1')) {
      const before = tailText(`${file}.1`, maxBytes - length, read);
      if (before !== null) return before + text;
    }
    return fromLineBoundary(text, length < size);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
