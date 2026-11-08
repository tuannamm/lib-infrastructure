import { createServer } from 'node:net';
import { EventLoopIndicator } from './event-loop.indicator';
import { MemoryIndicator } from './memory.indicator';
import { TcpIndicator } from './tcp.indicator';

describe('MemoryIndicator', () => {
  it('is up under a generous limit and down over a tiny one', async () => {
    expect((await new MemoryIndicator({ maxHeapMb: 100_000 }).check()).status).toBe('up');
    expect((await new MemoryIndicator({ maxHeapMb: 1 }).check()).status).toBe('down');
  });
});

describe('EventLoopIndicator', () => {
  it('is up when idle and down after the loop was blocked', async () => {
    const i = new EventLoopIndicator({ maxDelayMs: 50 });
    await new Promise((r) => setTimeout(r, 60));
    expect((await i.check()).status).toBe('up');
    const end = Date.now() + 200;
    while (Date.now() < end); // chặn event loop
    await new Promise((r) => setTimeout(r, 60));
    expect((await i.check()).status).toBe('down');
    i.destroy();
  });
});

describe('TcpIndicator', () => {
  it('up when the port accepts, down when it does not', async () => {
    const server = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    expect((await new TcpIndicator('x', { host: '127.0.0.1', port }).check()).status).toBe('up');
    await new Promise((r) => server.close(r));
    const down = await new TcpIndicator('x', { host: '127.0.0.1', port }).check();
    expect(down).toMatchObject({ status: 'down', message: 'ECONNREFUSED' });
  });
});
