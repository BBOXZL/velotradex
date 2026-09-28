import { createRouter } from '../../src/routes/index';

/**
 * S8: SystemStatus 并入 discord 维度，且 overall 在网关非 ready 时降级。
 */
function findStatusLayer(router: any) {
  return router.stack.find((l: any) => l.path === '/api/status' && l.methods.includes('GET'));
}

describe('S8 system status discord dimension', () => {
  test('GET /api/status exposes discord and degrades overall when gateway is not ready', async () => {
    const discordGatewayManager = require('../../src/services/DiscordGatewayManager').discordGatewayManager;
    const statusSpy = jest.spyOn(discordGatewayManager, 'getStatus').mockReturnValue({
      state: 'failed',
      pending: 3,
      lastMessageAt: 1000,
      channelCount: 2,
      error: 'boom',
      lastFailureMessageId: 'm1',
    });

    const router = createRouter();
    const layer = findStatusLayer(router);
    expect(layer).toBeDefined();
    const handler = layer.stack[layer.stack.length - 1];
    const ctx: any = { body: undefined, status: 200 };
    await handler(ctx);

    expect(ctx.body.discord).toMatchObject({ state: 'failed', pending: 3 });
    expect(ctx.body.discord).toMatchObject({ error: 'boom', lastFailureMessageId: 'm1' });
    expect(ctx.body.overall).not.toBe('ok');

    statusSpy.mockRestore();
  });

  test('stopped gateway does not itself degrade overall (no discord penalty)', async () => {
    const discordGatewayManager = require('../../src/services/DiscordGatewayManager').discordGatewayManager;
    const statusSpy = jest.spyOn(discordGatewayManager, 'getStatus').mockReturnValue({
      state: 'stopped',
      pending: 0,
      lastMessageAt: null,
      channelCount: 0,
      error: null,
    });
    // Redis 在单测环境不可用（ECONNREFUSED）会导致 overall=degraded；
    // 这里只断言 discord 维度本身不产生降级：把 redis 钉成 ready 后 overall 应为 ok。
    const redisService = require('../../src/services/RedisService').default;
    const redisSpy = jest.spyOn(redisService, 'getStatus').mockReturnValue({
      connected: true,
      ready: true,
      subStatus: 'ready',
      pubStatus: 'ready',
      lastError: '',
      lastErrorAt: 0,
      lastConnectedAt: Date.now(),
    });

    const router = createRouter();
    const layer = findStatusLayer(router);
    const handler = layer.stack[layer.stack.length - 1];
    const ctx: any = { body: undefined, status: 200 };
    await handler(ctx);

    expect(ctx.body.discord).toMatchObject({ state: 'stopped' });
    expect(ctx.body.overall).toBe('ok');

    statusSpy.mockRestore();
    redisSpy.mockRestore();
  });
});
