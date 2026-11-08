/**
 * Hai loại probe (chuẩn k8s):
 *  - `live`:  process còn sống không. Chỉ kiểm tra NỘI TẠI (event loop, bộ nhớ). KHÔNG kiểm tra
 *             dependency ngoài: DB chết mà liveness fail thì orchestrator restart oan, không cứu được gì.
 *  - `ready`: sẵn sàng nhận traffic chưa. Chạy cả indicator dependency ngoài (RabbitMQ, DB...).
 */
export type Probe = 'live' | 'ready';

export type ProbeStatus = 'up' | 'down';

/** Kết quả một lần kiểm tra. `check()` ném lỗi cũng được tính là `down`. */
export interface IndicatorCheck {
  status: ProbeStatus;
  /** Lý do ngắn gọn khi down. Hiện ra ngoài qua HTTP nên KHÔNG đưa chi tiết nhạy cảm vào đây. */
  message?: string;
}

export interface HealthIndicator {
  readonly name: string;
  /** `true` (mặc định): down thì cả probe 503. `false`: chỉ hiện trong response, không làm 503. */
  readonly critical?: boolean;
  /** Chạy ở probe nào. Mặc định `['ready']`. */
  readonly probes?: readonly Probe[];
  /** Ghi đè timeout chung (`HEALTH_TIMEOUT_MS`) cho riêng indicator này. */
  readonly timeoutMs?: number;
  check(): Promise<IndicatorCheck>;
  /** Giải phóng tài nguyên khi app tắt (tuỳ chọn). */
  destroy?(): void;
}

export interface IndicatorReport extends IndicatorCheck {
  latencyMs: number;
  critical: boolean;
}

export interface HealthReport {
  status: ProbeStatus;
  service: string;
  uptimeMs: number;
  checks: Record<string, IndicatorReport>;
}
