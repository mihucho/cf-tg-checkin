/**
 * 把 Cloudflare Workers 的 TCP socket（cloudflare:sockets）适配成 teleproto 需要的
 * SocketInterface（read / readExactly / write / close）。
 *
 * teleproto 默认用 node:net 的 Socket，但 Workers 里没有 node:net，
 * 所以我们自己实现一个 transport，把 connection 层接到这里。
 */
import { connect as cfConnect } from "cloudflare:sockets";
import { Buffer } from "node:buffer";

type CfSocketHandle = ReturnType<typeof cfConnect>;

export interface PacketReader {
  read(n: number): Promise<Buffer>;
  readExactly(n: number): Promise<Buffer>;
}

export interface SocketInterface extends PacketReader {
  connect(port: number, ip: string, testServers?: boolean): Promise<unknown>;
  write(data: Buffer | Uint8Array): void;
  close(): Promise<void>;
  lastDataAt?: number;
}

class SocketClosedError extends Error {
  constructor(message = "Socket was closed") {
    super(message);
    this.name = "SocketClosedError";
  }
}

export class ByteQueue {
  private chunks: Uint8Array[] = [];
  private head = 0;
  private offset = 0;
  bytes = 0;

  push(data: Uint8Array) {
    if (!data.length) return;
    this.chunks.push(data);
    this.bytes += data.length;
  }

  take(count: number): Buffer {
    count = Math.min(count, this.bytes);
    const out = Buffer.allocUnsafe(count);
    let written = 0;
    while (written < count) {
      const chunk = this.chunks[this.head];
      const n = Math.min(count - written, chunk.length - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + n), written);
      written += n;
      this.offset += n;
      if (this.offset === chunk.length) {
        this.chunks[this.head++] = new Uint8Array(0);
        this.offset = 0;
      }
    }
    this.bytes -= count;
    if (this.head >= 256 || !this.bytes) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    return out;
  }

  clear() {
    this.chunks = [];
    this.head = 0;
    this.offset = 0;
    this.bytes = 0;
  }
}

const CONNECT_TIMEOUT_MS = 15_000;

export class CloudflareSocket implements SocketInterface {
  private queue = new ByteQueue();
  private handle?: CfSocketHandle;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private writeChain: Promise<unknown> = Promise.resolve();
  private error?: Error;
  /** 多个读者可能同时等（read / readExactly），逐个唤醒，不能只留一个槽 */
  private waiters = new Set<() => void>();
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  lastDataAt = 0;

  get closed() {
    return this.error !== undefined;
  }

  async connect(port: number, ip: string, _testServers = false): Promise<unknown> {
    this.queue = new ByteQueue();
    this.error = undefined;

    const hostname = ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip;
    const handle = cfConnect({ hostname, port });
    this.handle = handle;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`connect timeout ${hostname}:${port}`)), CONNECT_TIMEOUT_MS);
    });
    try {
      await Promise.race([handle.opened, timeout]);
    } catch (error) {
      // 连接超时 / 失败要主动关掉底层 socket，否则会一直挂着占资源
      await handle.close().catch(() => undefined);
      this.handle = undefined;
      this.end(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }

    this.writer = handle.writable.getWriter();
    const reader = handle.readable.getReader();
    this.reader = reader;
    const pump = async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            this.lastDataAt = Date.now();
            this.queue.push(value);
            this.notify();
          }
        }
        this.end(new SocketClosedError());
      } catch (error) {
        this.end(error instanceof Error ? error : new Error(String(error)));
      }
    };
    void pump();
    return handle;
  }

  private end(error: Error = new SocketClosedError()) {
    this.error ??= error;
    this.notify();
  }

  private notify() {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  private async waitFor(n: number) {
    while (this.queue.bytes < n) {
      if (this.error) throw this.error;
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
  }

  async read(n: number): Promise<Buffer> {
    await this.waitFor(1);
    return this.queue.take(n);
  }

  async readExactly(n: number): Promise<Buffer> {
    await this.waitFor(n);
    return this.queue.take(n);
  }

  write(data: Buffer | Uint8Array): void {
    if (this.closed || !this.writer) throw new SocketClosedError("CloudflareSocket was closed");
    const payload = new Uint8Array(data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : new Uint8Array(data));
    const writer = this.writer;
    this.writeChain = this.writeChain.then(() => writer.write(payload)).catch((error) => {
      this.end(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    this.end();
    this.queue.clear();
    // reader 不 cancel 会一直持有底层流
    const reader = this.reader;
    this.reader = undefined;
    if (reader) await reader.cancel().catch(() => undefined);
    try {
      // 拒绝所有挂起的 write，避免 close 卡住
      await Promise.race([this.writeChain, new Promise((r) => setTimeout(r, 1_000))]);
    } catch {
      /* ignore */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* ignore */
    }
    if (!handle) return;
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
  }

  toString() {
    return "CloudflareSocket";
  }
}

export const CloudflareSocketFactory = CloudflareSocket as unknown as new (keepAliveInterval?: number) => SocketInterface;
