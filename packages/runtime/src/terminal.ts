import fs from 'node:fs';
import path from 'node:path';
import type { SessionOutputChunk } from '@agenterm/core';

export interface ReadOutputOptions {
  /** Return chunks with seq greater than this value. Defaults to 0. */
  sinceSeq?: number;
  /** Cap on bytes returned from the tail. Defaults to 65536. */
  tailBytes?: number;
  /** Cap on chunk count. Defaults to 200. */
  limit?: number;
}

export interface ReadOutputResult {
  chunks: SessionOutputChunk[];
  resumeAfterSeq: number | null;
  hasMore: boolean;
}

/**
 * Per-session terminal store.
 *
 * Holds the in-memory ring (capped bytes) plus an append-only file mirror
 * at sessions/<id>/terminal.log. Sequence numbers rise monotonically per
 * session starting at 1. Slow consumers re-fetch with the resume cursor.
 * The PTY writer is never blocked by readers.
 */
export class TerminalLog {
  private chunks: SessionOutputChunk[] = [];
  private heldBytes = 0;
  private seq = 0;
  private readonly maxBytes: number;
  private file: fs.WriteStream | null = null;

  constructor(options: { maxBytes?: number | undefined; dir?: string | undefined; sessionId?: string | undefined } = {}) {
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    if (typeof options.dir === 'string' && typeof options.sessionId === 'string') {
      const file = path.join(options.dir, options.sessionId, 'terminal.log');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.file = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
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
    while (this.chunks.length > 0 && this.heldBytes > this.maxBytes) {
      const dropped = this.chunks.shift();
      if (dropped !== undefined) {
        this.heldBytes -= Buffer.byteLength(dropped.data, 'utf8');
      }
    }
    this.file?.write(data);
    return chunk;
  }

  /** Highest sequence assigned so far, or 0 when empty. */
  latestSeq(): number {
    return this.seq;
  }

  /** Read paged scrollback with resume-cursor support. */
  read(options: ReadOutputOptions = {}): ReadOutputResult {
    const sinceSeq = options.sinceSeq ?? 0;
    const tailBytes = options.tailBytes ?? 65_536;
    const limit = options.limit ?? 200;
    const fresh = this.chunks.filter((entry) => entry.seq > sinceSeq);
    let bytes = 0;
    const tailed: SessionOutputChunk[] = [];
    for (let i = fresh.length - 1; i >= 0; i--) {
      const entry = fresh[i];
      if (entry === undefined) continue;
      const size = Buffer.byteLength(entry.data, 'utf8');
      if (bytes + size > tailBytes && tailed.length > 0) break;
      bytes += size;
      tailed.unshift(entry);
    }
    const hasMore = tailed.length < fresh.length;
    const page = tailed.slice(0, limit);
    const pageHasMore = hasMore || page.length < tailed.length;
    const last = page[page.length - 1];
    return {
      chunks: page,
      resumeAfterSeq: last === undefined ? null : last.seq,
      hasMore: pageHasMore
    };
  }

  close(): void {
    this.file?.end();
    this.file = null;
  }
}
