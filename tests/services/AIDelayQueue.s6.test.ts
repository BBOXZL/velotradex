import { Op } from 'sequelize';
import { AIDelayQueueService } from '../../src/services/AIDelayQueueService';
import aiParserService from '../../src/services/AIParserService';

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  formatError: jest.fn((e: any, ctx?: any) => ({ errorMessage: e?.message, ...(ctx || {}) })),
}));

function record(overrides: Record<string, any> = {}) {
  return {
    messageId: 'm1', channelId: 'c1',
    rawMessage: JSON.stringify({ id: 'm1', channel_id: 'c1', content: 'LONG BTC', ts: 1000 }),
    routeIds: JSON.stringify([5]), routeNames: JSON.stringify(['R5']),
    originalTimestamp: '1970-01-01T00:00:01.000Z',
    retryCount: 0, createdAt: new Date(1000), nextRetryAt: new Date(1000),
    status: 'pending', lastError: null,
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function setup(deps: Record<string, any> = {}) {
  const queue = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn(), findAll: jest.fn() };
  const strategies = { findOne: jest.fn().mockResolvedValue(null) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const deliver = jest.fn().mockResolvedValue(undefined);
  const service = new AIDelayQueueService({ deliver, queue: queue as any, strategies: strategies as any,
    audit: audit as any, webhooks: webhooks as any, now: () => 60_000, ...deps });
  return { queue, strategies, audit, webhooks, deliver, service };
}

describe('S6 AI delay queue (RED)', () => {
  test('enqueue dedupes on messageId (long-lived, not 60s hash)', async () => {
    const { queue, service } = setup();
    const existing = record();
    queue.findOne.mockResolvedValue(existing);
    const result = await service.enqueue({ messageId: 'm1', channelId: 'c1' });
    expect(result).toBe(existing);
    expect(queue.create).not.toHaveBeenCalled();
  });

  test('enqueue writes explicit routeIds/routeNames and audits AI_RETRY_QUEUED', async () => {
    const { queue, audit, service } = setup();
    queue.create.mockImplementation(async (v: any) => record({ ...v }));
    await service.enqueue({ messageId: 'm1', channelId: 'c1', routeIds: [5], routeNames: ['R5'] });
    expect(queue.create).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'm1', routeIds: JSON.stringify([5]), routeNames: JSON.stringify(['R5']),
    }));
    expect(audit.log).toHaveBeenCalledWith(0, 'AI_RETRY_QUEUED', expect.objectContaining({ messageId: 'm1' }));
  });

  test('worker reposts due records with route context and audits lag (retriedAt vs original)', async () => {
    const { queue, audit, deliver, service } = setup();
    const rec = record();
    queue.findAll.mockResolvedValue([rec]);
    const runWithRouteContext = jest.spyOn(aiParserService, 'runWithRouteContext')
      .mockImplementation(async (ctx: any, fn: any) => fn());
    const result = await service.tickOnce(61_000);
    expect(result).toEqual({ processed: 1, exhausted: 0 });
    expect(runWithRouteContext).toHaveBeenCalledWith({ routeIds: [5], routeNames: ['R5'] }, expect.any(Function));
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', channel_id: 'c1' }));
    expect(audit.log).toHaveBeenCalledWith(0, 'AI_RETRY_DELIVERED',
      expect.objectContaining({ messageId: 'm1', retriedAt: expect.any(String), originalTimestamp: expect.any(String), lagMs: expect.any(Number) }));
    expect(rec.update).toHaveBeenCalledWith({ status: 'done' });
    runWithRouteContext.mockRestore();
  });

  test('worker skips repost when the messageId already executed (messageId+strategy dedup)', async () => {
    const { queue, audit, deliver, strategies, service } = setup();
    const rec = record();
    queue.findAll.mockResolvedValue([rec]);
    strategies.findOne.mockResolvedValue({ id: 77 } as any);
    const result = await service.tickOnce(61_000);
    expect(result).toEqual({ processed: 1, exhausted: 0 });
    expect(deliver).not.toHaveBeenCalled();
    expect(rec.update).toHaveBeenCalledWith({ status: 'done' });
    expect(audit.log).toHaveBeenCalledWith(0, 'AI_RETRY_DEDUPED', expect.objectContaining({ messageId: 'm1' }));
    expect(strategies.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ rawMessage: { [Op.like]: '%m1%' } }),
    }));
  });

  test('records older than 30m exhaust with AI_RETRY_EXHAUSTED + alert and no strategy', async () => {
    const { queue, audit, webhooks, deliver, service } = setup({ now: () => 31 * 60 * 1000 });
    const rec = record({ createdAt: new Date(0) });
    queue.findAll.mockResolvedValue([rec]);
    const result = await service.tickOnce(31 * 60 * 1000);
    expect(result).toEqual({ processed: 0, exhausted: 1 });
    expect(deliver).not.toHaveBeenCalled();
    expect(rec.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'exhausted' }));
    expect(audit.log).toHaveBeenCalledWith(0, 'AI_RETRY_EXHAUSTED', expect.objectContaining({ messageId: 'm1' }));
    expect(webhooks.dispatch).toHaveBeenCalledWith('AI_RETRY_EXHAUSTED', expect.objectContaining({ messageId: 'm1' }));
  });

  test('failed repost bumps retryCount and reschedules in 60s with AI_RETRY_FAILED', async () => {
    const { queue, audit, deliver, service } = setup();
    const rec = record();
    queue.findAll.mockResolvedValue([rec]);
    deliver.mockRejectedValue(new Error('still 502'));
    const runWithRouteContext = jest.spyOn(aiParserService, 'runWithRouteContext')
      .mockImplementation(async (_ctx: any, fn: any) => fn());
    await service.tickOnce(61_000);
    expect(rec.update).toHaveBeenCalledWith(expect.objectContaining({ retryCount: 1, nextRetryAt: new Date(121_000) }));
    expect(audit.log).toHaveBeenCalledWith(0, 'AI_RETRY_FAILED', expect.objectContaining({ messageId: 'm1', retryCount: 1 }));
    runWithRouteContext.mockRestore();
  });
});
