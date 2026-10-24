/** ByteQueue：分片写入 / 按需读取 / 跨块读取的边界 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { ByteQueue } from "../src/telegram/socket.ts";

const bytes = (...values: number[]) => new Uint8Array(values);

test("ByteQueue：分片入队后按字节取", () => {
  const queue = new ByteQueue();
  queue.push(bytes(1, 2, 3));
  queue.push(bytes(4, 5));
  assert.equal(queue.bytes, 5);
  assert.deepEqual([...queue.take(3)], [1, 2, 3]);
  assert.equal(queue.bytes, 2);
  assert.deepEqual([...queue.take(2)], [4, 5]);
  assert.equal(queue.bytes, 0);
});

test("ByteQueue：跨块读取不会错位", () => {
  const queue = new ByteQueue();
  queue.push(bytes(1));
  queue.push(bytes(2, 3));
  queue.push(bytes(4));
  assert.deepEqual([...queue.take(4)], [1, 2, 3, 4]);
});

test("ByteQueue：要的比有的多时只给现有的", () => {
  const queue = new ByteQueue();
  queue.push(bytes(9, 8));
  assert.deepEqual([...queue.take(10)], [9, 8]);
  assert.equal(queue.bytes, 0);
  assert.equal(queue.take(5).length, 0);
});

test("ByteQueue：clear 之后计数归零", () => {
  const queue = new ByteQueue();
  queue.push(bytes(1, 2, 3));
  queue.clear();
  assert.equal(queue.bytes, 0);
  assert.equal(queue.take(3).length, 0);
});
