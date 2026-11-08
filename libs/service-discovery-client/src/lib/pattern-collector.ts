import type { DiscoveryService, MetadataScanner } from '@nestjs/core';
import {
  PATTERN_HANDLER_METADATA,
  PATTERN_METADATA,
} from '@nestjs/microservices/constants';
import { PatternHandler } from '@nestjs/microservices/enums/pattern-handler.enum';

/**
 * Tự thu thập mọi `@MessagePattern` của app, để service không phải khai báo tay danh sách pattern
 * (khai báo tay thì sớm muộn cũng lệch với code).
 *
 * NestJS không có API "liệt kê pattern"; nhưng decorator `@MessagePattern('x')` ghi metadata lên
 * method: PATTERN_METADATA = ['x'], PATTERN_HANDLER_METADATA = MESSAGE. Ta duyệt mọi controller
 * (DiscoveryService) và mọi method (MetadataScanner) rồi đọc metadata đó.
 *
 * - Chỉ lấy MESSAGE (request/response). Bỏ `@EventPattern`: event đi qua RabbitMQ, gateway không gửi tới.
 * - Pattern dạng object (`{ cmd: 'x' }`) bị bỏ qua và cảnh báo: operationId của gateway là string.
 */
export function collectMessagePatterns(
  discovery: DiscoveryService,
  scanner: MetadataScanner,
  warn: (message: string) => void = () => undefined,
): string[] {
  const patterns = new Set<string>();

  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as object | undefined;
    if (!instance) continue;
    const prototype = Object.getPrototypeOf(instance) as Record<
      string,
      unknown
    >;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[methodName];
      if (typeof handler !== 'function') continue;
      if (
        Reflect.getMetadata(PATTERN_HANDLER_METADATA, handler) !==
        PatternHandler.MESSAGE
      )
        continue;

      const declared: unknown[] =
        Reflect.getMetadata(PATTERN_METADATA, handler) ?? [];
      for (const pattern of declared) {
        if (typeof pattern === 'string') {
          patterns.add(pattern);
        } else {
          warn(
            `Skipping non-string pattern ${JSON.stringify(pattern)} on ${wrapper.name}.${methodName}.`,
          );
        }
      }
    }
  }
  return [...patterns].sort();
}
