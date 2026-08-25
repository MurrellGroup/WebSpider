import { invariant } from '../lib/errors.js';

// Keep several small interactive writes in flight so a distant node's round-trip
// time does not become a per-keystroke queue. Once the window is full, later
// writes are coalesced into bounded batches without changing byte order.
export class TerminalInputPipeline {
  constructor({ sendBatch, acknowledge = () => {}, fail = () => {}, maxInFlight = 4, maxBatchBytes = 64 * 1024 }) {
    invariant(typeof sendBatch === 'function', 'WS_VALIDATION', 'A terminal input sender is required.');
    invariant(Number.isInteger(maxInFlight) && maxInFlight > 0, 'WS_VALIDATION', 'Terminal input window must be positive.');
    invariant(Number.isInteger(maxBatchBytes) && maxBatchBytes > 0, 'WS_VALIDATION', 'Terminal input batch size must be positive.');
    this.sendBatch = sendBatch;
    this.acknowledge = acknowledge;
    this.fail = fail;
    this.maxInFlight = maxInFlight;
    this.maxBatchBytes = maxBatchBytes;
    this.pending = [];
    this.inFlight = 0;
    this.failed = false;
  }

  enqueue(bytes, metadata = null) {
    invariant(Buffer.isBuffer(bytes) && bytes.length > 0, 'WS_VALIDATION', 'Terminal input must contain bytes.');
    invariant(bytes.length <= this.maxBatchBytes, 'WS_REQUEST_TOO_LARGE', 'Terminal input exceeds the per-frame limit.', 413);
    invariant(!this.failed, 'WS_TERMINAL_INPUT_UNCERTAIN', 'Terminal input delivery stopped after a prior failure.', 503);
    this.pending.push({ bytes, metadata });
    this.#pump();
  }

  #nextBatch() {
    const items = [];
    let length = 0;
    while (this.pending.length && length + this.pending[0].bytes.length <= this.maxBatchBytes) {
      const item = this.pending.shift();
      items.push(item);
      length += item.bytes.length;
    }
    return { items, bytes: Buffer.concat(items.map((item) => item.bytes), length) };
  }

  #pump() {
    while (!this.failed && this.inFlight < this.maxInFlight && this.pending.length) {
      const batch = this.#nextBatch();
      this.inFlight += 1;
      Promise.resolve()
        .then(() => this.sendBatch(batch.bytes, batch.items.map((item) => item.metadata)))
        .then((result) => this.acknowledge(result, batch.items.map((item) => item.metadata), batch.bytes.length))
        .catch((error) => {
          if (this.failed) return;
          this.failed = true;
          this.fail(error, batch.items.map((item) => item.metadata), batch.bytes.length);
        })
        .finally(() => {
          this.inFlight -= 1;
          this.#pump();
        });
    }
  }
}
