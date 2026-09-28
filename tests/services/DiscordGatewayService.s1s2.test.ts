import { EventEmitter } from 'events';
import { Events } from 'discord.js';
import { DiscordGatewayService } from '../../src/services/DiscordGatewayService';
import { DiscordConnectionError } from '../../src/services/DiscordUserGateway';
import logger from '../../src/utils/logger';
import auditService from '../../src/services/AuditService';

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  formatError: jest.fn((err: any, ctx?: any) => ({ errorMessage: err?.message, ...(ctx || {}) })),
}));

jest.mock('../../src/services/AuditService', () => ({
  __esModule: true,
  default: { log: jest.fn().mockResolvedValue(undefined) },
}));

const mockedLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
const mockedAudit = auditService as unknown as { log: jest.Mock };

const original = {
  id: '100', channel_id: '200', content: 'LONG BTC',
  timestamp: '2026-09-23T12:00:00.000Z',
  author: { id: '300', username: 'trader' },
  attachments: [],
};

function botSetup(deliverImpl?: jest.Mock) {
  const client = Object.assign(new EventEmitter(), {
    login: jest.fn().mockResolvedValue('token'),
    destroy: jest.fn().mockResolvedValue(undefined),
    rest: { get: jest.fn().mockResolvedValue(original) },
  });
  const deliver = deliverImpl || jest.fn().mockResolvedValue(undefined);
  const service = new DiscordGatewayService({
    token: 'test-token', channelIds: ['200'], deliver,
    clientFactory: () => client as any,
    rebuildDelaysMs: [0, 0, 0],
  });
  return { client, deliver, service };
}

function userSetup(deliverImpl?: jest.Mock) {
  let handlers: any = null;
  const connection = {
    rest: { get: jest.fn().mockResolvedValue(original) },
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const deliver = deliverImpl || jest.fn().mockResolvedValue(undefined);
  const service = new DiscordGatewayService({
    token: 'personal-token', tokenMode: 'user', channelIds: ['200'], deliver,
    userGatewayFactory: (_token: string, h: any) => { handlers = h; return connection as any; },
    rebuildDelaysMs: [0, 0, 0],
  });
  return { connection, deliver, service, handlers: () => handlers };
}

const errorCalls = () => mockedLogger.error.mock.calls.map(args => String(args[0]));

describe('S1+S2 delivery isolation and failure context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auditService as unknown as { log: jest.Mock }).log.mockResolvedValue(undefined);
  });

  test('a poison message does not halt the chain; later messages still deliver', async () => {
    const { client, deliver, service } = botSetup();
    deliver.mockRejectedValueOnce(new Error('downstream unavailable'));
    await service.start();
    client.emit(Events.ClientReady);
    client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: original });
    client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { ...original, id: '101' } });
    await service.drain();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(service.getStatus().state).toBe('ready');
    expect(errorCalls().some(m => m.includes('Discord message delivery failed'))).toBe(true);
    const auditCalls = mockedAudit.log.mock.calls;
    expect(auditCalls.some(([, action, details]: any[]) =>
      action === 'DISCORD_DELIVERY_FAILED' && JSON.stringify(details).includes('100'))).toBe(true);
    await service.stop();
  });

  test('delivery failure log carries messageId/channelId/packetType/pending', async () => {
    const { client, deliver, service } = botSetup();
    deliver.mockRejectedValueOnce(new Error('boom'));
    await service.start();
    client.emit(Events.ClientReady);
    client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: original });
    await service.drain();
    const call = mockedLogger.error.mock.calls.find(args => String(args[0]).includes('Discord message delivery failed'));
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ messageId: '100', channelId: '200', packetType: 'MESSAGE_CREATE' });
    expect(call![1]).toHaveProperty('pending');
    await service.stop();
  });

  test('5 consecutive failures enter degraded with socket left open', async () => {
    const { client, deliver, service } = botSetup();
    deliver.mockRejectedValue(new Error('persistent outage'));
    await service.start();
    client.emit(Events.ClientReady);
    for (let i = 0; i < 5; i++) {
      client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { ...original, id: `d${i}` } });
    }
    await service.drain();
    expect(service.getStatus().state).toBe('degraded');
    expect(client.destroy).not.toHaveBeenCalled();
    expect(errorCalls().some(m => m.includes('degraded'))).toBe(true);
    // degraded: incoming messages are audited but skip execution
    deliver.mockClear();
    mockedAudit.log.mockClear();
    client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { ...original, id: 'skipped-1' } });
    await service.drain();
    expect(deliver).not.toHaveBeenCalled();
    expect(service.getStatus().state).toBe('degraded');
    // degraded state does NOT close the socket on gateway-level noise either
    await service.stop();
  });

  test('an in-flight success after degraded returns the service to ready', async () => {
    const { client, deliver, service } = botSetup();
    await service.start();
    client.emit(Events.ClientReady);
    // 5 poison messages trip degraded; the 6th was already queued (pending path)
    // so its success drives degraded -> ready through the real queue path.
    for (let i = 0; i < 5; i++) {
      (deliver as jest.Mock).mockRejectedValueOnce(new Error(`fail-${i}`));
    }
    for (let i = 0; i < 6; i++) {
      client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { ...original, id: `r${i}` } });
    }
    await service.drain();
    expect(deliver).toHaveBeenCalledTimes(6);
    expect(errorCalls().some(m => m.includes('degraded'))).toBe(true);
    expect(service.getStatus().state).toBe('ready');
    expect(service.getStatus().consecutiveDeliverFailures).toBe(0);
    expect(mockedLogger.info.mock.calls.some(args => String(args[0]).includes('recovered from degraded'))).toBe(true);
    await service.stop();
  });

  test('gateway ready recovers a degraded service without reconnect (socket stays open)', async () => {
    const { client, service } = botSetup();
    await service.start();
    client.emit(Events.ClientReady);
    (service as any).state = 'degraded';
    (service as any).consecutiveDeliverFailures = 5;
    client.emit(Events.ClientReady);
    expect(service.getStatus().state).toBe('ready');
    expect(client.destroy).not.toHaveBeenCalled();
    await service.stop();
  });

  test('one success resets the consecutive-failure count back to ready baseline', async () => {
    const { client, deliver, service } = botSetup();
    deliver.mockImplementation(async () => undefined);
    await service.start();
    client.emit(Events.ClientReady);
    // 4 consecutive poison messages (counter = 4, still ready), then a success resets to 0.
    for (let i = 0; i < 4; i++) {
      (deliver as jest.Mock).mockRejectedValueOnce(new Error(`fail-${i}`));
      client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { ...original, id: `f${i}` } });
    }
    client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { ...original, id: 'ok' } });
    await service.drain();
    expect(service.getStatus().state).toBe('ready');
    // Counter was reset by the success, so 4 more failures stay ready.
    for (let i = 0; i < 4; i++) {
      (deliver as jest.Mock).mockRejectedValueOnce(new Error(`fail2-${i}`));
      client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { ...original, id: `g${i}` } });
    }
    await service.drain();
    expect(service.getStatus().state).toBe('ready');
    // The 5th consecutive failure trips degraded.
    (deliver as jest.Mock).mockRejectedValueOnce(new Error('fail2-4'));
    client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { ...original, id: 'g4' } });
    await service.drain();
    expect(service.getStatus().state).toBe('degraded');
    await service.stop();
  });

  test('queue overflow fails with the overflow copy and lastFailureMessageId', async () => {
    const { client, service } = botSetup();
    await service.start();
    client.emit(Events.ClientReady);
    (service as any).pending = 1000;
    client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: original });
    await service.drain();
    expect(errorCalls().some(m => m.includes('Discord queue overflow'))).toBe(true);
    expect(service.getStatus().lastFailureMessageId).toBe('100');
    await service.stop();
  });

  test('opcode 9 / 4011 style gateway error recovers to ready within 3 rebuilds', async () => {
    const { connection, service, handlers } = userSetup();
    await service.start();
    handlers().onReady();
    (service as any).lastMessageAt = 1727250000000;
    connection.connect.mockResolvedValue(undefined);
    handlers().onError(new DiscordConnectionError('Discord Gateway closed (code 4011)'));
    expect(service.getStatus().state).toBe('reconnecting');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    // rebuild attempted exactly once and recovered to ready
    expect(connection.connect).toHaveBeenCalledTimes(2); // start + 1 rebuild
    expect(service.getStatus().state).toBe('ready');
    const reconcile = mockedLogger.info.mock.calls.find(args => String(args[0]).includes('reconcile'));
    expect(reconcile).toBeDefined();
    expect(reconcile![1]).toMatchObject({ since: new Date(1727250000000).toISOString() });
    // fail() carried the original context
    const failCall = mockedLogger.error.mock.calls.find(args => String(args[0]).includes('Discord message delivery failed'));
    expect(failCall).toBeDefined();
    expect(String(failCall![1]?.message || '')).toContain('4011');
    await service.stop();
  });

  test('threshold is configurable via degradedAfterConsecutiveFailures', async () => {
    const client = Object.assign(new EventEmitter(), {
      login: jest.fn().mockResolvedValue('token'),
      destroy: jest.fn().mockResolvedValue(undefined),
      rest: { get: jest.fn().mockResolvedValue(original) },
    });
    const deliver = jest.fn().mockRejectedValue(new Error('outage'));
    const service = new DiscordGatewayService({
      token: 'test-token', channelIds: ['200'], deliver,
      clientFactory: () => client as any,
      degradedAfterConsecutiveFailures: 2,
      rebuildDelaysMs: [0, 0, 0],
    });
    await service.start();
    client.emit(Events.ClientReady);
    client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { ...original, id: 'c0' } });
    client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { ...original, id: 'c1' } });
    await service.drain();
    expect(service.getStatus().state).toBe('degraded');
    await service.stop();
  });

  test('rebuild gives up after 3 attempts and stays failed for manual recovery', async () => {
    const { connection, service, handlers } = userSetup();
    await service.start();
    handlers().onReady();
    connection.connect.mockRejectedValue(new Error('network down'));
    handlers().onError(new DiscordConnectionError('Discord user Gateway network error'));
    expect(service.getStatus().state).toBe('reconnecting');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    // 1 initial + 3 rebuild attempts
    expect(connection.connect).toHaveBeenCalledTimes(4);
    expect(service.getStatus().state).toBe('failed');
    expect(errorCalls().some(m => m.includes('rebuild exhausted'))).toBe(true);
    await service.stop();
  });
});
