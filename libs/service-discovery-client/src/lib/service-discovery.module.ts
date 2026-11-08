import {
  Inject,
  Injectable,
  Logger,
  Module,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
} from '@nestjs/core';
import {
  resolveServiceDiscoveryOptions,
  type ResolvedServiceDiscoveryOptions,
  type ServiceDiscoveryOptions,
} from './options';
import { collectMessagePatterns } from './pattern-collector';
import { canConnect } from './reachability';
import { RegistryClient } from './registry-client';

const RESOLVED_OPTIONS = Symbol('SERVICE_DISCOVERY_RESOLVED_OPTIONS');

/** Sau chừng này mà địa chỉ vẫn chưa nhận kết nối thì cảnh báo (vẫn tiếp tục thử, không đăng ký bừa). */
const WARN_AFTER_MS = 10_000;
const PROBE_INTERVAL_MS = 250;
const PROBE_MAX_INTERVAL_MS = 2_000;

/**
 * Tự đăng ký service lên Service Registry, gắn vào vòng đời của app NestJS:
 *
 *  - `onApplicationBootstrap`: chạy NỀN (không chặn việc khởi động): thăm dò đến khi địa chỉ quảng bá
 *    nhận được kết nối TCP, rồi mới đăng ký + heartbeat. Lúc này cổng chưa chắc đã mở
 *    (với microservice, `app.listen()` chạy SAU hook này), nên không thể đăng ký ngay.
 *  - `beforeApplicationShutdown`: huỷ đăng ký (DELETE) TRƯỚC khi đóng cổng, để gateway thôi gửi
 *    request mới trong lúc service còn xử lý nốt request đang chạy. Cần `app.enableShutdownHooks()`.
 */
@Injectable()
export class ServiceDiscoveryRegistration
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('ServiceDiscovery');
  private client?: RegistryClient;
  private stopped = false;
  private wakeUp?: () => void;

  constructor(
    @Inject(RESOLVED_OPTIONS)
    private readonly options: ResolvedServiceDiscoveryOptions,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.registryUrl) {
      // Nói rõ chế độ đang chạy: im lặng ở đây khiến người chạy tưởng đã đăng ký mà không phải.
      this.logger.warn(
        'Service discovery disabled (REGISTRY_URL not set): this instance will NOT be discoverable. ' +
          'Set REGISTRY_URL (and PORT) to register with the Service Registry.',
      );
      return;
    }
    // Không await: không chặn khởi động; mọi lỗi được xử lý bên trong.
    void this.registerWhenReachable();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.wakeUp?.();
    await this.client?.stop();
  }

  private async registerWhenReachable(): Promise<void> {
    const {
      advertiseHost,
      port,
      registryUrl,
      service,
      instanceId,
      token,
      metadata,
    } = this.options;
    const startedAt = Date.now();
    let interval = PROBE_INTERVAL_MS;
    let warned = false;

    while (!this.stopped && !(await canConnect(advertiseHost, port))) {
      if (!warned && Date.now() - startedAt >= WARN_AFTER_MS) {
        warned = true;
        this.logger.warn(
          `${advertiseHost}:${port} does not accept connections yet; not registering until it does. ` +
            `If the service listens elsewhere, check PORT and SERVICE_ADVERTISE_HOST.`,
        );
      }
      await this.sleep(interval);
      interval = Math.min(interval * 2, PROBE_MAX_INTERVAL_MS);
    }
    if (this.stopped) return;

    const patterns = collectMessagePatterns(this.discovery, this.scanner, (m) =>
      this.logger.warn(m),
    );
    this.logger.log(`Message patterns: ${patterns.join(', ') || '(none)'}`);
    const note =
      this.options.advertiseHostSource === 'configured'
        ? ''
        : ` (${this.options.advertiseHostSource === 'detected' ? 'auto-detected' : 'no network interface found, using loopback'}; set SERVICE_ADVERTISE_HOST to override)`;
    this.logger.log(`Advertising ${advertiseHost}:${port}${note}`);

    this.client = new RegistryClient(
      {
        registryUrl: registryUrl!,
        service,
        instanceId,
        advertiseHost,
        port,
        token,
        metadata,
      },
      patterns,
      { logger: this.logger },
    );
    await this.client.start();
  }

  /** Ngủ nhưng dậy ngay khi app đang tắt (không giữ shutdown chờ hết khoảng nghỉ). */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

/**
 * Thêm vào `imports` của AppModule là đủ:
 *
 * ```ts
 * @Module({ imports: [ServiceDiscoveryModule.forRoot()], controllers: [...] })
 * export class AppModule {}
 * ```
 *
 * Cấu hình qua biến môi trường (xem `ServiceDiscoveryOptions`): `REGISTRY_URL` và `PORT`.
 * Nên gọi `forRoot()` không tham số: biến môi trường được đọc khi app khởi động, sau khi main.ts đã nạp `.env`.
 */
@Module({})
export class ServiceDiscoveryModule {
  static forRoot(options: ServiceDiscoveryOptions = {}): DynamicModule {
    return {
      module: ServiceDiscoveryModule,
      imports: [DiscoveryModule],
      providers: [
        // useFactory: gộp cấu hình LÚC KHỞI TẠO PROVIDER, không phải lúc import file này.
        {
          provide: RESOLVED_OPTIONS,
          useFactory: () => resolveServiceDiscoveryOptions(options),
        },
        ServiceDiscoveryRegistration,
      ],
    };
  }
}
