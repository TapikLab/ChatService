import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** One writer; fsync before network side effects. An incomplete tail is recoverable. */
export class Journal {
  readonly records: unknown[];
  private readonly fd: number;
  private closed = false;
  private failed = false;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = openSync(`${path}.lock`, 'wx', 0o600);
    try {
      writeFileSync(lock, `${process.pid}\n`);
    } finally {
      closeSync(lock);
    }
    try {
      this.fd = openSync(path, 'a+', 0o600);
    } catch (error) {
      unlinkSync(`${path}.lock`);
      throw error;
    }
    try {
      const data = readFileSync(this.fd);
      const end = data.lastIndexOf(10) + 1;
      if (end !== data.length) {
        ftruncateSync(this.fd, end);
        fsyncSync(this.fd);
      }
      const content = data.subarray(0, end).toString('utf8');
      this.records =
        content === ''
          ? []
          : content
              .slice(0, -1)
              .split('\n')
              .map((line): unknown => JSON.parse(line));
      const directory = openSync(dirname(path), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  append(value: unknown): void {
    if (this.closed || this.failed) throw new Error('JOURNAL_UNAVAILABLE');
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(
          this.fd,
          bytes,
          offset,
          bytes.length - offset,
        );
        if (written < 1) throw new Error('JOURNAL_WRITE_FAILED');
        offset += written;
      }
      fsyncSync(this.fd);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } finally {
      unlinkSync(`${this.path}.lock`);
    }
  }
}
