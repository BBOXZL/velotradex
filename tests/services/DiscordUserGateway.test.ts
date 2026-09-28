import { EventEmitter } from 'events';
import { DiscordUserGateway } from '../../src/services/DiscordUserGateway';

function setup() {
  const sockets: any[] = [];
  const handlers = { onDispatch: jest.fn(), onReady: jest.fn(), onReconnect: jest.fn(), onError: jest.fn() };
  const gateway = new DiscordUserGateway({
    token: 'private-token',
    handlers,
    socketFactory: () => {
      const socket = Object.assign(new EventEmitter(), {
        readyState: 1, send: jest.fn(), close: jest.fn(), terminate: jest.fn(),
      });
      sockets.push(socket);
      return socket as any;
    },
  });
  const packet = (data: any) => sockets[sockets.length - 1].emit('message', Buffer.from(JSON.stringify(data)));
  return { gateway, sockets, handlers, packet };
}

describe('personal Discord Gateway transport', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('identifies without bot intents and resolves only on READY', async () => {
    const { gateway, sockets, handlers, packet } = setup();
    const connected = gateway.connect();
    packet({ op: 10, d: { heartbeat_interval: 1000 } });
    const identify = JSON.parse(sockets[0].send.mock.calls[0][0]);
    expect(identify).toMatchObject({ op: 2, d: { token: 'private-token' } });
    expect(identify.d.intents).toBeUndefined();
    packet({ op: 0, t: 'READY', s: 1, d: { session_id: 'session' } });
    await connected;
    expect(handlers.onReady).toHaveBeenCalledTimes(1);
    packet({ op: 0, t: 'MESSAGE_CREATE', s: 7, d: { id: '123' } });
    packet({ op: 1, d: null });
    expect(JSON.parse(sockets[0].send.mock.calls.at(-1)[0])).toEqual({ op: 1, d: 7 });
    await gateway.close();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('auth close rejects promptly with numeric code and no server reason or token', async () => {
    const { gateway, sockets } = setup();
    const result = expect(gateway.connect()).rejects.toThrow('4004');
    sockets[0].emit('close', 4004, Buffer.from('private-token'));
    await result;
    await gateway.close();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('connection timeout is bounded and closes socket', async () => {
    const { gateway, sockets } = setup();
    const result = expect(gateway.connect()).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(20000);
    await result;
    expect(sockets[0].terminate).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('reconnect resumes with session and last sequence; close cancels reconnect', async () => {
    const { gateway, sockets, packet, handlers } = setup();
    const connected = gateway.connect();
    packet({ op: 0, t: 'READY', s: 5, d: { session_id: 'session' } });
    await connected;
    packet({ op: 7 });
    await jest.advanceTimersByTimeAsync(2000);
    expect(sockets).toHaveLength(2);
    packet({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(JSON.parse(sockets[1].send.mock.calls[0][0])).toEqual({
      op: 6, d: { token: 'private-token', session_id: 'session', seq: 5 },
    });
    packet({ op: 0, t: 'RESUMED', s: 6, d: {} });
    expect(handlers.onReady).toHaveBeenCalledTimes(2);
    await gateway.close();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('invalidated established session fails closed instead of silently losing signals', async () => {
    const { gateway, packet, handlers } = setup();
    const connected = gateway.connect();
    packet({ op: 0, t: 'READY', s: 5, d: { session_id: 'session' } });
    await connected;
    packet({ op: 9, d: false });
    expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('reconcile') }));
    expect(jest.getTimerCount()).toBe(0);
  });

  test('missing heartbeat ACK triggers reconnect', async () => {
    const { gateway, packet, handlers } = setup();
    const connected = gateway.connect();
    packet({ op: 10, d: { heartbeat_interval: 1000 } });
    packet({ op: 0, t: 'READY', s: 5, d: { session_id: 'session' } });
    await connected;
    await jest.advanceTimersByTimeAsync(2000);
    expect(handlers.onReconnect).toHaveBeenCalled();
    await gateway.close();
  });
});
