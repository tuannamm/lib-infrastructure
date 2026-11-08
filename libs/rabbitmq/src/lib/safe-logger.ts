import { Logger } from '@nestjs/common';

function redact(value: string): string {
  return value
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, '$1[REDACTED]@')
    .replace(
      /\b(password|passwd|secret|token|authorization)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      '$1$2[REDACTED]',
    );
}

/** Keep diagnostics, but never serialize arbitrary connection/config objects. */
export function formatRabbitMQLog(...args: unknown[]): string {
  const seen = new WeakSet<object>();
  const describe = (value: unknown): string => {
    if (typeof value === 'string') return redact(value);
    if (!value || typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    const record = value as Record<string, unknown>;
    const details = [
      'message',
      'code',
      'syscall',
      'hostname',
      'address',
      'port',
    ].flatMap((key) => {
      const field = record[key];
      return typeof field === 'string' || typeof field === 'number'
        ? [
            key === 'message'
              ? redact(String(field))
              : `${key}=${redact(String(field))}`,
          ]
        : [];
    });
    for (const key of ['err', 'error', 'cause']) {
      const nested = describe(record[key]);
      if (nested) details.push(nested);
    }
    if (Array.isArray(record.errors)) {
      for (const error of record.errors) {
        const nested = describe(error);
        if (nested) details.push(nested);
      }
    }
    return details.join('; ');
  };
  return (
    [...new Set(args.map(describe).filter(Boolean))].join(' | ') ||
    'RabbitMQ transport failure (no diagnostic details)'
  );
}

export class RabbitMQLogger extends Logger {
  override error(...args: unknown[]): void {
    super.error(formatRabbitMQLog(...args));
  }
  override warn(...args: unknown[]): void {
    super.warn(formatRabbitMQLog(...args));
  }
}
