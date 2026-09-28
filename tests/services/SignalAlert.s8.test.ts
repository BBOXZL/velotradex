/**
 * S8: 拦截必须可观测 —— MANUAL_INTERVENTION_BLOCKED / STRATEGY_REJECTED 发生时，
 * 除日志 + 审计外，必须再写一条告警记录（落库 + 面板红点，D2 零新依赖）。
 */
describe('S8 interception alert (RED)', () => {
  test('manual-intervention block writes an alert record besides the audit row', async () => {
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const SignalAlert = require('../../src/models/SignalAlert').default;
    const alertCreate = jest.spyOn(SignalAlert, 'create').mockResolvedValue({ id: 1 });

    const { OpenPositionService } = require('../../src/services/executor/OpenPositionService');
    const svc = new OpenPositionService(
      {
        exchangeRegistry: {
          getExchange: () => ({
            getTicker: jest.fn().mockResolvedValue({ lastPrice: '84000' }),
            getMarkets: jest.fn().mockResolvedValue([{ symbol: 'BTC_USDT' }]),
            getBalance: jest.fn().mockResolvedValue({ available: '1000' }),
            getPositions: jest.fn().mockResolvedValue([{ symbol: 'BTC_USDT', size: '0.1' }]),
            getOpenOrders: jest.fn().mockResolvedValue([]),
          }),
        },
        auditService: { log: auditLog },
        orderPersistenceHandler: {},
        tradingStatsService: {},
        protectionContext: {},
      } as any,
      {} as any,
      { handleClose: jest.fn() } as any,
    );

    // 反向手工仓：交易所持有 buy 现货仓，但 DB 无同向跟踪订单
    const Order = require('../../src/models/Order').default;
    const findAllSpy = jest.spyOn(Order, 'findAll').mockResolvedValue([]);
    const preCheckerProto = require('../../src/services/OrderPreCheck').OrderPreCheck.prototype;
    const conflictSpy = jest.spyOn(preCheckerProto, 'checkConflict').mockResolvedValue({ symbol: 'BTC_USDT', size: '0.1' });
    const cleanupSpy = jest.spyOn(preCheckerProto, 'cleanupStaleOrders').mockResolvedValue(undefined);

    const result = await svc.handleOpen(
      { action: 'open', symbol: 'BTC_USDT', side: 'sell', entryPrice: '84279', stopLoss: '84851.5', targets: ['81803.7'], raw: {} } as any,
      { riskMode: 'fixed', riskValue: 5, defaultLeverage: '10', priceTolerance: 0.01, autoCloseOppositePosition: true } as any,
      'xbt-channel',
      4,
      'exchange-1',
      9,
    );

    expect(result).toBeNull();
    expect(auditLog).toHaveBeenCalledWith(4, 'MANUAL_INTERVENTION_BLOCKED', expect.anything());
    // S8 新增：告警落库
    expect(alertCreate).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 4,
      kind: expect.stringContaining('MANUAL'),
    }));

    findAllSpy.mockRestore();
    conflictSpy.mockRestore();
    cleanupSpy.mockRestore();
  });

  test('strategy rejection writes a STRATEGY_REJECTED alert besides the audit row', async () => {
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const SignalAlert = require('../../src/models/SignalAlert').default;
    const alertCreate = jest.spyOn(SignalAlert, 'create').mockResolvedValue({ id: 2 });

    const { rejectOpenStrategy } = require('../../src/services/OpenSignalValidator');
    await expect(rejectOpenStrategy(auditService, 123, 'exchange-1', {
      symbol: 'BTC_USDT',
      side: 'buy',
      entryPrice: '101',
      stopLoss: '95',
      currentPrice: 100,
      field: 'symbol',
      reason: 'Unsupported open strategy symbol: BTC_USDT',
    })).rejects.toThrow('Unsupported open strategy symbol');

    expect(auditService.log).toHaveBeenCalledWith(123, 'STRATEGY_REJECTED', expect.anything(), undefined, undefined, 'exchange-1');
    expect(alertCreate).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 123,
      kind: 'STRATEGY_REJECTED',
      symbol: 'BTC_USDT',
    }));
  });
});
