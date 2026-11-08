/**
 * CORE của registry client: đăng ký + heartbeat + huỷ đăng ký. Không import NestJS
 * (test chạy được không cần Nest; dùng được cả ngoài NestJS nếu cần).
 *
 * Code này nằm ở MỘT chỗ (`@org/service-discovery-client`), mọi service dùng chung qua
 * `ServiceDiscoveryModule`: đổi giao thức với registry chỉ phải sửa ở đây.
 *
 *   start() ──PUT (đăng ký)──► registry ──{ heartbeatIntervalMs }──► hẹn heartbeat kế tiếp
 *   mỗi nhịp ──PUT (y hệt)──► gia hạn lease          (heartbeat = đăng ký lại đầy đủ)
 *   stop()  ──DELETE──► gỡ ngay, gateway thôi gửi request mà không phải chờ TTL
 */

export interface RegistryClientOptions {
  /** VD "http://localhost:8500". */
  registryUrl: string;
  service: string;
  /** Định danh instance, ổn định qua các lần heartbeat. */
  instanceId: string;
  /** Địa chỉ gateway dùng để gọi tới service. KHÔNG phải 0.0.0.0. */
  advertiseHost: string;
  port: number;
  token?: string;
  metadata?: Record<string, string>;
  /** Thời gian chờ tối đa mỗi lần gọi registry. Mặc định 2000ms. */
  requestTimeoutMs?: number;
  /** Nhịp heartbeat khi chưa nhận được nhịp từ registry (registry chết). Mặc định 5000ms. */
  fallbackIntervalMs?: number;
}

export interface RegistryClientLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Trạng thái quan hệ với registry. Chỉ log khi trạng thái ĐỔI, để heartbeat mỗi 5s không làm ngập log. */
export type RegistrationState =
  'idle' | 'registered' | 'unreachable' | 'rejected';

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_FALLBACK_INTERVAL_MS = 5_000;
const silent: RegistryClientLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class RegistryClient {
  private state: RegistrationState = 'idle';
  private lastProblem?: string;
  private intervalMs: number;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly instanceUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly logger: RegistryClientLogger;

  constructor(
    private readonly options: RegistryClientOptions,
    private readonly patterns: string[],
    deps: { fetch?: typeof fetch; logger?: RegistryClientLogger } = {},
  ) {
    const base = options.registryUrl.replace(/\/+$/, '');
    this.instanceUrl = `${base}/v1/instances/${encodeURIComponent(options.instanceId)}`;
    this.intervalMs =
      options.fallbackIntervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS;
    this.fetchFn = deps.fetch ?? fetch;
    this.logger = deps.logger ?? silent;
  }

  get currentState(): RegistrationState {
    return this.state;
  }

  /**
   * Đăng ký lần đầu rồi heartbeat theo nhịp. KHÔNG ném lỗi khi registry chết:
   * service vẫn chạy bình thường (registry là phụ trợ), và tự đăng ký khi registry sống lại.
   */
  async start(): Promise<void> {
    if (this.patterns.length === 0) {
      this.logger.warn('No @MessagePattern found: nothing to register.');
      return;
    }
    this.stopped = false;
    await this.heartbeat();
    this.schedule();
  }

  /** Một lần PUT. Public để test. */
  async heartbeat(): Promise<RegistrationState> {
    let response: Response;
    try {
      response = await this.fetchFn(this.instanceUrl, {
        method: 'PUT',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          service: this.options.service,
          host: this.options.advertiseHost,
          port: this.options.port,
          patterns: this.patterns,
          ...(this.options.metadata && { metadata: this.options.metadata }),
        }),
        signal: AbortSignal.timeout(
          this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      return this.transition(
        'unreachable',
        `registry unreachable: ${(error as Error).message}`,
      );
    }

    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        status?: string;
        heartbeatIntervalMs?: unknown;
      };
      // Registry quyết định nhịp: đổi TTL ở registry không phải sửa client.
      if (
        typeof body.heartbeatIntervalMs === 'number' &&
        body.heartbeatIntervalMs > 0
      ) {
        this.intervalMs = body.heartbeatIntervalMs;
      }
      // Đang "registered" mà registry trả "created": registry vừa restart, mất RAM, và heartbeat
      // này vừa khôi phục lại bản ghi (soft state).
      if (this.state === 'registered' && body.status === 'created') {
        this.logger.warn(
          `Registry had lost this instance (restarted?); re-registered ${this.describe()}.`,
        );
      }
      return this.transition('registered');
    }

    const problem = (await response.json().catch(() => ({}))) as {
      detail?: string;
      errors?: string[];
    };
    const detail = [problem.detail, ...(problem.errors ?? [])]
      .filter(Boolean)
      .join(' ');
    if (response.status >= 500) {
      return this.transition(
        'unreachable',
        `registry error HTTP ${response.status}`,
      );
    }
    // 400 (dữ liệu sai), 401 (sai token), 409 (pattern của service khác): lỗi cấu hình, cần người sửa.
    // Vẫn thử lại ở nhịp sau (VD service kia tắt thì pattern được giải phóng), nhưng log là ERROR.
    return this.transition(
      'rejected',
      `registry rejected registration (HTTP ${response.status}): ${detail}`,
    );
  }

  /**
   * Dừng heartbeat và huỷ đăng ký. Best effort: lỗi chỉ log, không chặn service tắt.
   * Không gọi được DELETE thì lease TTL vẫn là lưới an toàn.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.state !== 'registered') return;
    try {
      await this.fetchFn(this.instanceUrl, {
        method: 'DELETE',
        headers: this.headers({}),
        signal: AbortSignal.timeout(
          this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        ),
      });
      this.logger.log(`Deregistered ${this.describe()}.`);
    } catch (error) {
      this.logger.warn(
        `Deregister failed (${(error as Error).message}); the registry will expire this instance by TTL.`,
      );
    }
    this.state = 'idle';
  }

  // ---------------------------------------------------------------------------

  private schedule(): void {
    if (this.stopped) return;
    // setTimeout nối tiếp: xong lần này mới hẹn lần sau, và luôn dùng nhịp mới nhất registry trả về.
    this.timer = setTimeout(() => {
      void this.heartbeat().finally(() => this.schedule());
    }, this.intervalMs);
    // unref: timer heartbeat KHÔNG được giữ process sống, nếu không service không tắt được.
    this.timer.unref();
  }

  private transition(
    next: RegistrationState,
    problem?: string,
  ): RegistrationState {
    const changed = next !== this.state || problem !== this.lastProblem;
    this.state = next;
    this.lastProblem = problem;
    if (!changed) return next;

    if (next === 'registered') {
      this.logger.log(
        `Registered ${this.describe()} with ${this.patterns.length} pattern(s); heartbeat every ${this.intervalMs}ms.`,
      );
    } else if (next === 'unreachable') {
      this.logger.warn(
        `${problem}. Service keeps running; retrying every ${this.intervalMs}ms.`,
      );
    } else if (next === 'rejected') {
      this.logger.error(`${problem}`);
    }
    return next;
  }

  private headers(base: Record<string, string>): Record<string, string> {
    return this.options.token
      ? { ...base, 'x-registry-token': this.options.token }
      : base;
  }

  private describe(): string {
    const o = this.options;
    return `${o.instanceId} (${o.service} @ ${o.advertiseHost}:${o.port})`;
  }
}
