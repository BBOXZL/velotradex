import AILog from '../../src/models/AILog';
import Strategy from '../../src/models/Strategy';
import SignalRoute from '../../src/models/SignalRoute';
import Order from '../../src/models/Order';
import AuditLog from '../../src/models/AuditLog';
import aiParserService from '../../src/services/AIParserService';

// S7: Retry 补单显式化 + 双 guard（幂等 + RETRY_TRIGGERED_ORDER 审计）。
// RED: 后端尚无 guard 与审计，这些用例应先失败。

describe('S7 POST /logs/:id/retry triggerOrder dual guard', () => {
  let handler: Function;

  beforeAll(() => {
    const router = require('../../src/routes/aiConfig').default;
    const retryLayer = router.stack.find((l: any) => l.path === '/logs/:id/retry' && l.methods.includes('POST'));
    expect(retryLayer).toBeDefined();
    handler = retryLayer.stack[retryLayer.stack.length - 1];
  });

  function mockCtx(overrides: Record<string, any> = {}) {
    const ctx: any = {
      params: { id: '1' },
      request: { body: {} },
      body: null,
      status: 200,
    };
    return Object.assign(ctx, overrides);
  }

  function mockHappyPath() {
    jest.spyOn(AILog, 'findByPk').mockResolvedValue({
      id: 1,
      strategyId: 10,
      routeIds: JSON.stringify([5]),
      routeNames: JSON.stringify(['R5']),
      systemPrompt: 'system prompt',
      prompt: 'test prompt',
    } as any);

    jest.spyOn(aiParserService, 'retryLogAnalysis').mockResolvedValue({
      logId: 2,
      content: '{"action":"open","symbol":"XRP_USDT","side":"buy","confidence":0.9}',
      usage: { total_tokens: 10 },
    } as any);

    jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: JSON.stringify({ id: 'discord-1', channel_id: 'c1', content: 'LONG XRP' }),
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    jest.spyOn(SignalRoute, 'findByPk').mockResolvedValue({
      id: 5,
      isActive: true,
      exchangeInstanceId: 'exchange-1',
      riskSettings: '{}',
      symbolSpecificSettings: '{}',
    } as any);

    const strategyParserRegistry = require('../../src/services/parsers').default;
    const mockParser = {
      name: 'DefaultParser',
      getRiskConfig: jest.fn().mockReturnValue({ riskMode: 'fixed', riskValue: 10 }),
      parse: jest.fn().mockResolvedValue([{
        symbol: 'XRP_USDT',
        side: 'buy',
        entryPrice: 'CMP',
        targets: ['1.733'],
        stopLoss: '1.4484',
      }]),
    };
    jest.spyOn(strategyParserRegistry, 'getParserByName').mockReturnValue(mockParser);

    const parserConfigService = require('../../src/services/ParserConfigService').default;
    jest.spyOn(parserConfigService, 'getEffectiveConfig').mockResolvedValue({ riskMode: 'fixed', riskValue: 10 });

    const tradeExecutor = require('../../src/services/TradeExecutor').default;
    const executeSpy = jest.spyOn(tradeExecutor, 'execute').mockResolvedValue({
      id: 'order-123',
      status: 'filled',
      symbol: 'XRP_USDT',
      side: 'buy',
    } as any);

    // guard 默认：无重复（未 mock 的查询抛错会被 guard 内部吞掉并放行；
    // 这里显式 mock 为空，保证与 DB 状态无关）。
    jest.spyOn(Strategy, 'findOne').mockResolvedValue(null);
    jest.spyOn(Order, 'findAll').mockResolvedValue([] as any);
    jest.spyOn(Order, 'findOne').mockResolvedValue(null);
    jest.spyOn(AuditLog, 'findAll').mockResolvedValue([] as any);
    jest.spyOn(AuditLog, 'create').mockResolvedValue({ id: 100 } as any);

    return { executeSpy };
  }

  function retryAuditCalls() {
    const createSpy = AuditLog.create as unknown as jest.Mock;
    return createSpy.mock.calls.filter((call: any[]) => call[0]?.action === 'RETRY_TRIGGERED_ORDER');
  }

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('triggerOrder 成功：返回 orderResult + 写 RETRY_TRIGGERED_ORDER 成功审计', async () => {
    mockHappyPath();
    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.orderResult).toEqual(expect.objectContaining({ id: 'order-123' }));

    const audits = retryAuditCalls();
    expect(audits).toHaveLength(1);
    expect(audits[0][0].strategyId).toBe(10);
    const details = JSON.parse(audits[0][0].details);
    expect(details).toMatchObject({ aiLogId: 1, strategyId: 10, success: true });
    expect(details.symbol).toBe('XRP_USDT');
  });

  test('第二次调用：已有成功审计则被幂等拒绝，不再下单', async () => {
    const { executeSpy } = mockHappyPath();
    (AuditLog.findAll as unknown as jest.Mock).mockResolvedValue([{
      id: 100,
      action: 'RETRY_TRIGGERED_ORDER',
      details: JSON.stringify({ aiLogId: 1, strategyId: 10, success: true }),
    }] as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(false);
    expect(ctx.body.warning).toMatch(/重复|已触发|duplicate|already/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('同 messageId 已有 processed 策略：拒绝补单', async () => {
    const { executeSpy } = mockHappyPath();
    (Strategy.findOne as unknown as jest.Mock).mockResolvedValue({ id: 77 } as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(false);
    expect(ctx.body.warning).toMatch(/重复|已执行|duplicate|already/i);
    expect(ctx.body.duplicate).toMatchObject({ strategyId: 77 });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('该 strategy 已有关联订单（非 FAILED）：拒绝补单', async () => {
    const { executeSpy } = mockHappyPath();
    (Order.findAll as unknown as jest.Mock).mockResolvedValue([
      { id: 5, lifecycleStatus: 'OPEN' },
    ] as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(false);
    expect(ctx.body.warning).toMatch(/重复|已下单|duplicate|already/i);
    expect(ctx.body.duplicate).toMatchObject({ orderId: 5 });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('执行失败：warning + 写 RETRY_TRIGGERED_ORDER 失败审计（含原因）', async () => {
    mockHappyPath();
    const tradeExecutor = require('../../src/services/TradeExecutor').default;
    (tradeExecutor.execute as unknown as jest.Mock).mockRejectedValue(new Error('Exchange API error'));

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/exchange api error/i);
    expect(ctx.body).not.toHaveProperty('orderResult');

    const audits = retryAuditCalls();
    expect(audits).toHaveLength(1);
    const details = JSON.parse(audits[0][0].details);
    expect(details).toMatchObject({ aiLogId: 1, strategyId: 10, success: false });
    expect(details.reason).toMatch(/execution_failed/);
    expect(details.error).toMatch(/Exchange API error/);
  });

  test('默认仅重解析：不写 RETRY_TRIGGERED_ORDER 审计', async () => {
    mockHappyPath();
    const ctx = mockCtx();
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(retryAuditCalls()).toHaveLength(0);
  });
});
