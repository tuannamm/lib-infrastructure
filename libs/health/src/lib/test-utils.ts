import { createServer } from 'node:net';

/** Hỏi OS một cổng trống (chỉ dùng trong test). */
export function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.once('error', reject);
  });
}
