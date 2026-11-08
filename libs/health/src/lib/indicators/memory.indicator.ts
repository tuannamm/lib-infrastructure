import { getHeapStatistics } from 'node:v8';
import type { HealthIndicator, IndicatorCheck, Probe } from '../types';

export interface MemoryIndicatorOptions {
  /** Ngưỡng heap đang dùng (MB). Mặc định: 90% giới hạn heap của V8. */
  maxHeapMb?: number;
}

/** Heap đang dùng vượt ngưỡng thì down. Chạy ở cả live và ready: cạn heap thì restart mới có ích. */
export class MemoryIndicator implements HealthIndicator {
  readonly name = 'memory';
  readonly probes: readonly Probe[] = ['live', 'ready'];
  private readonly maxHeapBytes: number;

  constructor(options: MemoryIndicatorOptions = {}) {
    this.maxHeapBytes =
      options.maxHeapMb !== undefined
        ? options.maxHeapMb * 1024 * 1024
        : getHeapStatistics().heap_size_limit * 0.9;
  }

  async check(): Promise<IndicatorCheck> {
    const used = getHeapStatistics().used_heap_size;
    return used > this.maxHeapBytes
      ? {
          status: 'down',
          message: `heap ${toMb(used)}MB exceeds ${toMb(this.maxHeapBytes)}MB`,
        }
      : { status: 'up' };
  }
}

const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024);
