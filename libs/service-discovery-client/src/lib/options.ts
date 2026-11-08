import { readFileSync } from 'node:fs';
import {
  hostname,
  networkInterfaces,
  type NetworkInterfaceInfo,
} from 'node:os';
import path from 'node:path';

/**
 * Cấu hình của module. TẤT CẢ đều tuỳ chọn: thiếu thì lấy từ biến môi trường, rồi từ giá trị mặc định.
 * Tối thiểu cần `REGISTRY_URL` (hoặc option `registryUrl`) và `PORT`; không có `REGISTRY_URL` thì module
 * TẮT (service chạy như thường, không đăng ký).
 *
 * | Option          | Env                       | Mặc định                                                |
 * |-----------------|---------------------------|---------------------------------------------------------|
 * | `registryUrl`   | `REGISTRY_URL`            | không có → tắt                                          |
 * | `port`          | `PORT`                    | bắt buộc khi bật: cổng TCP service đang nghe            |
 * | `service`       | `SERVICE_NAME`            | `name` trong package.json (bỏ phần `@scope/`)           |
 * | `advertiseHost` | `SERVICE_ADVERTISE_HOST`  | IPv4 đầu tiên không phải loopback; không có → 127.0.0.1 |
 * | `instanceId`    | `SERVICE_INSTANCE_ID`     | `<service>-<hostname>-<port>`                           |
 * | `token`         | `REGISTRY_TOKEN`          | không có                                                |
 */
export interface ServiceDiscoveryOptions {
  registryUrl?: string;
  port?: number;
  service?: string;
  advertiseHost?: string;
  instanceId?: string;
  token?: string;
  metadata?: Record<string, string>;
}

/** Kết quả sau khi đã gộp options + env + mặc định, đã kiểm tra hợp lệ. */
export interface ResolvedServiceDiscoveryOptions {
  /** `undefined` = module tắt (các field còn lại không có nghĩa). */
  registryUrl?: string;
  port: number;
  service: string;
  advertiseHost: string;
  /** Cách `advertiseHost` có được, để log cho người vận hành biết có đang "đoán" hay không. */
  advertiseHostSource: 'configured' | 'detected' | 'fallback';
  instanceId: string;
  token?: string;
  metadata?: Record<string, string>;
}

export class ServiceDiscoveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceDiscoveryConfigError';
  }
}

/** Giống tên DNS label; khớp với luật kiểm tra của Service Registry. */
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UNROUTABLE_HOSTS = new Set(['0.0.0.0', '::', '[::]']);
const FALLBACK_HOST = '127.0.0.1';

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  hostname?: string;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  readFile?: (file: string) => string;
}

/**
 * Gộp cấu hình. Chạy LÚC KHỞI TẠO PROVIDER (trong NestFactory.create), không phải lúc gọi `forRoot()`:
 * `forRoot()` chạy khi file module được import, thường TRƯỚC khi main.ts kịp nạp `.env`.
 * Chạy ở đây còn cho kết quả fail-fast: cấu hình sai thì service không khởi động, trước khi mở cổng.
 */
export function resolveServiceDiscoveryOptions(
  options: ServiceDiscoveryOptions = {},
  deps: ResolveDeps = {},
): ResolvedServiceDiscoveryOptions {
  const env = deps.env ?? process.env;
  const registryUrl = normalizeRegistryUrl(
    options.registryUrl ?? env.REGISTRY_URL,
  );

  if (!registryUrl) {
    // Tắt: không cần cổng, tên service hay địa chỉ, và không được lỗi chỉ vì thiếu chúng.
    return {
      port: 0,
      service: '',
      advertiseHost: '',
      advertiseHostSource: 'configured',
      instanceId: '',
    };
  }

  const port = parsePort(options.port ?? env.PORT);

  const service = (
    options.service ??
    env.SERVICE_NAME ??
    serviceNameFromPackageJson(deps)
  )?.trim();
  if (!service) {
    throw new ServiceDiscoveryConfigError(
      'Cannot determine the service name: set SERVICE_NAME, or the "service" option, or a "name" in package.json.',
    );
  }
  if (!SERVICE_NAME.test(service)) {
    throw new ServiceDiscoveryConfigError(
      `Service name "${service}" is invalid: use lowercase letters, digits and "-" (set SERVICE_NAME).`,
    );
  }

  const configuredHost = (
    options.advertiseHost ?? env.SERVICE_ADVERTISE_HOST
  )?.trim();
  const host = configuredHost
    ? { host: configuredHost, source: 'configured' as const }
    : detectAdvertiseHost(deps.interfaces ?? networkInterfaces);
  if (UNROUTABLE_HOSTS.has(host.host)) {
    throw new ServiceDiscoveryConfigError(
      `SERVICE_ADVERTISE_HOST must be an address other services can reach (e.g. an IP or the Docker service name), not "${host.host}".`,
    );
  }

  const instanceId =
    (options.instanceId ?? env.SERVICE_INSTANCE_ID)?.trim() ||
    defaultInstanceId(service, deps.hostname ?? hostname(), port);

  return {
    registryUrl,
    port,
    service,
    advertiseHost: host.host,
    advertiseHostSource: host.source,
    instanceId,
    token: (options.token ?? env.REGISTRY_TOKEN)?.trim() || undefined,
    metadata: options.metadata,
  };
}

function normalizeRegistryUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceDiscoveryConfigError(
      `REGISTRY_URL "${value}" is not a valid URL.`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServiceDiscoveryConfigError(
      `REGISTRY_URL must use http or https, got "${url.protocol}".`,
    );
  }
  return url.toString().replace(/\/+$/, '');
}

function parsePort(raw: string | number | undefined): number {
  const text = String(raw ?? '').trim();
  const port = Number(text);
  if (!text) {
    throw new ServiceDiscoveryConfigError(
      'PORT is required to register with the registry: set PORT to the TCP port this service listens on.',
    );
  }
  if (!/^\d+$/.test(text) || port < 1 || port > 65_535) {
    throw new ServiceDiscoveryConfigError(
      `PORT must be an integer between 1 and 65535, got "${text}".`,
    );
  }
  return port;
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

/** `<service>-<hostname>-<port>`, chỉ giữ ký tự registry chấp nhận. */
export function defaultInstanceId(
  service: string,
  host: string,
  port: number,
): string {
  const safeHost = host.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${service}-${safeHost}-${port}`.slice(0, 128);
}

/**
 * IPv4 đầu tiên không phải loopback và không phải link-local (169.254.x.x).
 * - Máy local: IP LAN, gateway cùng máy vẫn gọi được.
 * - Docker / Kubernetes: IP của container/pod trong mạng nội bộ.
 * - Máy có nhiều card mạng (VPN) có thể chọn nhầm: khi đó đặt SERVICE_ADVERTISE_HOST.
 * - Không có card nào (offline) thì lùi về 127.0.0.1 (chỉ gateway cùng máy gọi được).
 */
export function detectAdvertiseHost(
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces,
): { host: string; source: 'detected' | 'fallback' } {
  for (const list of Object.values(interfaces())) {
    for (const info of list ?? []) {
      // Node cũ trả `family` là số 4, Node mới trả chuỗi 'IPv4'.
      const isV4 = info.family === 'IPv4' || (info.family as unknown) === 4;
      if (isV4 && !info.internal && !info.address.startsWith('169.254.')) {
        return { host: info.address, source: 'detected' };
      }
    }
  }
  return { host: FALLBACK_HOST, source: 'fallback' };
}
