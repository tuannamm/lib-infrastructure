import { connect } from 'node:net';

/**
 * Thử mở một kết nối TCP tới `host:port` rồi đóng ngay. Dùng để biết service ĐÃ THẬT SỰ nhận kết nối
 * ở địa chỉ sắp quảng bá, trước khi đăng ký lên registry.
 *
 * Thăm dò đúng địa chỉ quảng bá (không phải 127.0.0.1) vì đó là địa chỉ gateway sẽ gọi:
 * nếu chính service cũng không tới được địa chỉ đó thì gateway càng không tới được.
 */
export function canConnect(
  host: string,
  port: number,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
