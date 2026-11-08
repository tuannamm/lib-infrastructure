import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { InjectionToken, ModuleMetadata } from '@nestjs/common';
import { EventLoopIndicator } from './indicators/event-loop.indicator';
import { MemoryIndicator } from './indicators/memory.indicator';
import type { HealthIndicator } from './types';

/**
 * Cấu hình của module. TẤT CẢ đều tuỳ chọn: thiếu thì lấy từ biến môi trường, rồi từ mặc định.
 * Khi đăng ký module, health server mặc định mở cổng `9001`, không cần khai báo `HEALTH_PORT`.
 *
 * | Option       | Env                 | Mặc định                                          |
 * |--------------|---------------------|---------------------------------------------------|
 * | `port`       | `HEALTH_PORT`       | 9001                                              |
 * | `host`       | `HEALTH_HOST`       | `0.0.0.0` (để Docker/k8s probe được)              |
 * | `service`    | `SERVICE_NAME`      | `name` trong package.json (bỏ phần `@scope/`)     |
 * | `timeoutMs`  | `HEALTH_TIMEOUT_MS` | 2000 (mỗi indicator)                              |
 * | `cacheMs`    | `HEALTH_CACHE_MS`   | 1000                                              |
 * | `basePath`   | `HEALTH_PATH`       | `/health`                                         |
 * | `indicators` | -                   | thêm vào MemoryIndicator + EventLoopIndicator     |
 */
export interface HealthModuleOptions {
  port?: number;
  host?: string;
  service?: string;
  timeoutMs?: number;
  cacheMs?: number;
  basePath?: string;
  /** Indicator của service. Trùng `name` với indicator mặc định (`memory`, `event-loop`) thì bản của bạn thắng. */
  indicators?: HealthIndicator[];
}

export interface HealthModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  inject?: InjectionToken[];
  useFactory: (
    ...args: any[]
  ) => HealthModuleOptions | Promise<HealthModuleOptions>;
}

export interface ResolvedHealthOptions {
  port: number;
  host: string;
  service: string;
  timeoutMs: number;
  cacheMs: number;
  basePath: string;
  indicators: HealthIndicator[];
}

export class HealthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealthConfigError';
  }
}

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  readFile?: (file: string) => string;
}

/** Gộp cấu hình LÚC KHỞI TẠO PROVIDER (sau khi main.ts nạp `.env`), fail-fast nếu sai. */
export function resolveHealthOptions(
  options: HealthModuleOptions = {},
  deps: ResolveDeps = {},
): ResolvedHealthOptions {
  const env = deps.env ?? process.env;

  const rawPort = options.port ?? env.HEALTH_PORT;
  const port =
    rawPort === undefined || String(rawPort).trim() === ''
      ? 9001
      : parseInteger('HEALTH_PORT', rawPort, 1, 65_535);

  const userIndicators = options.indicators ?? [];
  const names = new Set<string>();
  for (const indicator of userIndicators) {
    if (names.has(indicator.name)) {
      throw new HealthConfigError(
        `Duplicate health indicator name "${indicator.name}".`,
      );
    }
    names.add(indicator.name);
  }
  const indicators = [...userIndicators];
  // Chỉ tạo indicator mặc định khi cần: EventLoopIndicator bật bộ đo, không nên tạo rồi bỏ.
  if (!names.has('memory')) indicators.unshift(new MemoryIndicator());
  if (!names.has('event-loop')) indicators.unshift(new EventLoopIndicator());

  return {
    port,
    host: (options.host ?? env.HEALTH_HOST)?.trim() || '0.0.0.0',
    service:
      (
        options.service ??
        env.SERVICE_NAME ??
        serviceNameFromPackageJson(deps)
      )?.trim() || 'unknown',
    timeoutMs: parseInteger(
      'HEALTH_TIMEOUT_MS',
      options.timeoutMs ?? env.HEALTH_TIMEOUT_MS ?? 2000,
      1,
      60_000,
    ),
    cacheMs: parseInteger(
      'HEALTH_CACHE_MS',
      options.cacheMs ?? env.HEALTH_CACHE_MS ?? 1000,
      0,
      60_000,
    ),
    basePath: normalizeBasePath(options.basePath ?? env.HEALTH_PATH),
    indicators,
  };
}

function parseInteger(
  name: string,
  raw: string | number,
  min: number,
  max: number,
): number {
  const text = String(raw).trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < min || value > max) {
    throw new HealthConfigError(
      `${name} must be an integer between ${min} and ${max}, got "${text}".`,
    );
  }
  return value;
}

function normalizeBasePath(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value || value === '/') return '/health';
  return '/' + value.replace(/^\/+|\/+$/g, '');
}

/** `@scope/user-service` → `user-service`. Đọc package.json ở thư mục chạy (cwd). */
function serviceNameFromPackageJson(deps: ResolveDeps): string | undefined {
  const read = deps.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
  try {
    const name = (
      JSON.parse(
        read(path.join(deps.cwd ?? process.cwd(), 'package.json')),
      ) as { name?: unknown }
    ).name;
    return typeof name === 'string' ? name.replace(/^@[^/]+\//, '') : undefined;
  } catch {
    return undefined;
  }
}
