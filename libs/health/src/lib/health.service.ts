import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { RESOLVED_OPTIONS } from './tokens';
import type { ResolvedHealthOptions } from './options';
import type {
  HealthIndicator,
  HealthReport,
  IndicatorReport,
  Probe,
} from './types';

/**
 * Chạy các indicator và gộp thành báo cáo.
 *  - Chạy SONG SONG; mỗi indicator có timeout riêng; lỗi/timeout = down (không bao giờ ném ra ngoài).
 *  - Cache kết quả `cacheMs` (cả lần chạy đang dở được dùng chung) để probe dồn dập không đè lên DB.
 *  - Sau `startShutdown()`, readiness down NGAY (drain) còn liveness vẫn theo kết quả thật.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger('Health');
  private readonly startedAt = Date.now();
  private readonly cache = new Map<
    Probe,
    { at: number; report: Promise<HealthReport> }
  >();
  private shuttingDown = false;

  constructor(
    @Inject(RESOLVED_OPTIONS) private readonly options: ResolvedHealthOptions,
  ) {}

  startShutdown(): void {
    this.shuttingDown = true;
  }

  onModuleDestroy(): void {
    for (const indicator of this.options.indicators) indicator.destroy?.();
  }

  check(probe: Probe): Promise<HealthReport> {
    if (probe === 'ready' && this.shuttingDown) {
      return Promise.resolve(
        this.report(
          {
            shutdown: {
              status: 'down',
              message: 'shutting down',
              latencyMs: 0,
              critical: true,
            },
          },
        ),
      );
    }
    const cached = this.cache.get(probe);
    if (cached && Date.now() - cached.at < this.options.cacheMs) {
      return cached.report;
    }
    const report = this.run(probe);
    this.cache.set(probe, { at: Date.now(), report });
    return report;
  }

  private async run(probe: Probe): Promise<HealthReport> {
    const selected = this.options.indicators.filter((indicator) =>
      (indicator.probes ?? ['ready']).includes(probe),
    );
    const entries = await Promise.all(
      selected.map(
        async (indicator) =>
          [indicator.name, await this.runOne(indicator)] as const,
      ),
    );
    return this.report(Object.fromEntries(entries));
  }

  private async runOne(indicator: HealthIndicator): Promise<IndicatorReport> {
    const critical = indicator.critical ?? true;
    const timeoutMs = indicator.timeoutMs ?? this.options.timeoutMs;
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        indicator.check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
      return { ...result, latencyMs: Date.now() - started, critical };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Chi tiết lỗi chỉ vào log; response chỉ có thông điệp ngắn.
      this.logger.warn(`Indicator "${indicator.name}" failed: ${reason}`);
      return {
        status: 'down',
        message: reason.startsWith('timeout') ? reason : 'check failed',
        latencyMs: Date.now() - started,
        critical,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private report(checks: Record<string, IndicatorReport>): HealthReport {
    const down = Object.values(checks).some(
      (check) => check.critical && check.status === 'down',
    );
    return {
      status: down ? 'down' : 'up',
      service: this.options.service,
      uptimeMs: Date.now() - this.startedAt,
      checks,
    };
  }
}
