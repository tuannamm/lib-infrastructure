import type { HealthIndicator, IndicatorCheck, Probe } from '../types';

export interface EventLoopIndicatorOptions {
  /** Độ trễ event loop tối đa (ms) trong khoảng giữa hai lần kiểm tra. Mặc định 1000. */
  maxDelayMs?: number;
}

const TICK_MS = 20;

/**
 * Event loop bị chặn (vòng lặp đồng bộ dài) thì service trông như "treo": vẫn nhận kết nối nhưng không
 * trả lời. Một timer lặp mỗi 20ms đo xem nó bị gọi trễ bao nhiêu; `check()` báo độ trễ lớn nhất kể từ
 * lần kiểm tra trước. (Tự đo thay vì `monitorEventLoopDelay` vì kết quả của nó khó đoán với đợt chặn dài.)
 */
export class EventLoopIndicator implements HealthIndicator {
  readonly name = 'event-loop';
  readonly probes: readonly Probe[] = ['live'];
  private readonly maxDelayMs: number;
  private readonly timer: NodeJS.Timeout;
  private expected = Date.now() + TICK_MS;
  private worstLagMs = 0;

  constructor(options: EventLoopIndicatorOptions = {}) {
    this.maxDelayMs = options.maxDelayMs ?? 1000;
    this.timer = setInterval(() => {
      const now = Date.now();
      this.worstLagMs = Math.max(this.worstLagMs, now - this.expected);
      this.expected = now + TICK_MS;
    }, TICK_MS);
    this.timer.unref(); // không giữ process sống chỉ vì bộ đo
  }

  async check(): Promise<IndicatorCheck> {
    // Đang chặn ngay lúc này thì timer chưa kịp ghi: tính thêm phần trễ đang diễn ra.
    const lag = Math.max(this.worstLagMs, Date.now() - this.expected);
    this.worstLagMs = 0;
    return lag > this.maxDelayMs
      ? {
          status: 'down',
          message: `event loop delayed ${Math.round(lag)}ms (max ${this.maxDelayMs}ms)`,
        }
      : { status: 'up' };
  }

  destroy(): void {
    clearInterval(this.timer);
  }
}
