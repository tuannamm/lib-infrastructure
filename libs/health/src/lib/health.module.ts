import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { HealthServer } from './health.server';
import { HealthService } from './health.service';
import {
  resolveHealthOptions,
  type HealthModuleAsyncOptions,
  type HealthModuleOptions,
} from './options';
import { RAW_OPTIONS, RESOLVED_OPTIONS } from './tokens';

/**
 * Thêm vào `imports` của AppModule là đủ:
 *
 * ```ts
 * @Module({ imports: [HealthModule.forRoot({ indicators: [new TcpIndicator(...)] })] })
 * export class AppModule {}
 * ```
 *
 * Mặc định mở cổng `9001`; có thể ghi đè qua option `port` hoặc `HEALTH_PORT`.
 * Cần `app.enableShutdownHooks()` ở main.ts để readiness chuyển down khi nhận SIGTERM.
 */
@Module({})
export class HealthModule {
  static forRoot(options: HealthModuleOptions = {}): DynamicModule {
    return this.build([], { provide: RAW_OPTIONS, useValue: options });
  }

  /** Khi indicator cần thứ được inject (connection DB, ConfigService...). */
  static forRootAsync(options: HealthModuleAsyncOptions): DynamicModule {
    return this.build(options.imports ?? [], {
      provide: RAW_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    });
  }

  private static build(
    imports: NonNullable<HealthModuleAsyncOptions['imports']>,
    raw: Provider,
  ): DynamicModule {
    return {
      module: HealthModule,
      imports,
      providers: [
        raw,
        // Gộp cấu hình LÚC KHỞI TẠO PROVIDER, sau khi main.ts đã nạp `.env`.
        {
          provide: RESOLVED_OPTIONS,
          useFactory: (rawOptions: HealthModuleOptions) =>
            resolveHealthOptions(rawOptions),
          inject: [RAW_OPTIONS],
        },
        HealthService,
        HealthServer,
      ],
      exports: [HealthService],
    };
  }
}
