import { normalizeDisplayPriceScale, detectDisplayPriceScaleFactor } from '../../src/services/OpenSignalValidator';
import tradeExecutor from '../../src/services/TradeExecutor';
import exchangeRegistry from '../../src/services/exchanges';
import auditService from '../../src/services/AuditService';
import { Order } from '../../src/models';

jest.mock('../../src/services/exchanges', () => ({
  __esModule: true,
  default: { getExchange: jest.fn() },
}));

jest.mock('../../src/services/AuditService', () => ({
  __esModule: true,
  default: { log: jest.fn() },
}));

jest.mock('../../src/models', () => ({
  Order: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn() },
  Strategy: {},
  StrategyPosition: { findOne: jest.fn(), create: jest.fn() },
  AuditLog: {},
  PendingProtection: {},
  SoftStopLoss: { create: jest.fn() },
  sequelize: {},
}));

describe('S5 价格归一化逐字段化 (WLD腿2)', () => {
  // WLD 腿2真凭据: entry=4135(错位, 应为0.4135), SL=0.3989(正常), TP=0.4913(正常), 现价~0.4286
  const WLD_CURRENT = 0.4286;

  function leg2Parsed() {
    return {
      action: 'open' as const,
      symbol: 'WLD_USDT',
      side: 'buy' as const,
      entryPrice: '4135',
      stopLoss: '0.3989',
      targets: ['0.4913'],
      raw: {},
    };
  }

  it('WLD腿2: 仅entry归一化, SL/TP保持原值 (entry=0.4135/SL=0.3989/TP=0.4913)', () => {
    const res = normalizeDisplayPriceScale({
      parsed: leg2Parsed(),
      signal: { entryPrice: 4135, stopLoss: 0.3989 },
      currentPrice: WLD_CURRENT,
    });
    expect(res).not.toBeNull();
    expect(res!.parsed.entryPrice).toBe('0.4135');
    expect(res!.parsed.stopLoss).toBe('0.3989');
    expect(res!.parsed.targets).toEqual(['0.4913']);
    expect(res!.scaleFactor).toBe(10000);
  });

  it('全错位反例: entry/SL/TP全部偏离时仍整体归一化', () => {
    const res = normalizeDisplayPriceScale({
      parsed: {
        action: 'open' as const,
        symbol: 'PEPE_USDT',
        side: 'buy' as const,
        entryPrice: '0.004132',
        stopLoss: '0.004071',
        targets: ['0.0043'],
        raw: {},
      },
      signal: { entryPrice: 0.004132, stopLoss: 0.004071 },
      currentPrice: 0.000004132,
    });
    expect(res).not.toBeNull();
    expect(res!.parsed.entryPrice).toBe('0.000004132');
    expect(res!.parsed.stopLoss).toBe('0.000004071');
    expect(res!.parsed.targets).toEqual(['0.0000043']);
    expect(res!.scaleFactor).toBe(1000);
  });

  it('畸形输入: 归一化后sanity失败(SL>=entry)则拒绝归一化返回null', () => {
    // entry=4135错位, 但SL=5000归一化后(0.5)仍>=entry(0.4135) -> 多头SL<entry<TP不成立 -> 拒绝
    const res = normalizeDisplayPriceScale({
      parsed: {
        action: 'open' as const,
        symbol: 'WLD_USDT',
        side: 'buy' as const,
        entryPrice: '4135',
        stopLoss: '5000',
        targets: ['0.4913'],
        raw: {},
      },
      signal: { entryPrice: 4135, stopLoss: 5000 },
      currentPrice: WLD_CURRENT,
    });
    expect(res).toBeNull();
  });

  it('handleOpen畸形拒绝: entry错位+sanity失败 -> STRATEGY_PRICE_SCALE_REJECTED审计且按原值走后续校验', async () => {
    const mockExchange = {
      getTicker: jest.fn().mockResolvedValue({ lastPrice: String(WLD_CURRENT) }),
      getMarkets: jest.fn().mockResolvedValue([{ symbol: 'WLD_USDT', multiplier: '1', leverageMax: '10', amountPrecision: 0, pricePrecision: 4 }]),
      getBalance: jest.fn().mockResolvedValue({ total: '1000', available: '1000' }),
      getPositions: jest.fn().mockResolvedValue([]),
      getOpenOrders: jest.fn().mockResolvedValue([]),
      getPriceOrders: jest.fn().mockResolvedValue([]),
      setMarginMode: jest.fn().mockResolvedValue(true),
      setLeverage: jest.fn().mockResolvedValue(true),
      placeOrder: jest.fn().mockResolvedValue({ id: 'entry-1', status: 'open', symbol: 'WLD_USDT' }),
      waitForOrderFill: jest.fn().mockReturnValue(new Promise(() => {})),
      updateStopLoss: jest.fn(),
      closePosition: jest.fn(),
      getTradeHistory: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn(),
      cancelPriceOrder: jest.fn(),
    };
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue(mockExchange);
    (Order.findAll as jest.Mock).mockResolvedValue([]);
    (Order.create as jest.Mock).mockResolvedValue({ id: 1, symbol: 'WLD_USDT', lifecycleStatus: 'INIT', save: jest.fn() });
    (auditService.log as jest.Mock).mockClear();

    await (tradeExecutor as any).handleOpen(
      {
        action: 'open' as const,
        symbol: 'WLD_USDT',
        side: 'buy' as const,
        // entry=4135错位(→0.4135)但SL=5000(正常价, 现价0.4286附近不偏离)
        // sanity: 多头要求SL<entry, 0.4135 vs 5000不成立 -> 拒绝归一化
        entryPrice: '4135',
        stopLoss: '5000',
        targets: ['0.4913'],
        raw: {},
      },
      { riskMode: 'percentage', riskValue: 1, defaultLeverage: '5', priceTolerance: 0.01 } as any,
      'unit-test-source',
      999,
      'mock-exchange',
      77,
    ).catch(() => {});

    const rejected = (auditService.log as jest.Mock).mock.calls.filter((c: any[]) => c[1] === 'STRATEGY_PRICE_SCALE_REJECTED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0][0]).toBe(999);
    expect(rejected[0][2]).toEqual(expect.objectContaining({ symbol: 'WLD_USDT', reason: 'sanity_check_failed' }));
  });

  it('空头sanity: SL>entry>TP才接受; 反之拒绝', () => {
    const ok = normalizeDisplayPriceScale({
      parsed: {
        action: 'open' as const,
        symbol: 'WLD_USDT',
        side: 'sell' as const,
        entryPrice: '4135',
        stopLoss: '0.43',
        targets: ['0.39'],
        raw: {},
      },
      signal: { entryPrice: 4135, stopLoss: 0.43 },
      currentPrice: WLD_CURRENT,
    });
    expect(ok).not.toBeNull();
    expect(ok!.parsed.entryPrice).toBe('0.4135');

    const bad = normalizeDisplayPriceScale({
      parsed: {
        action: 'open' as const,
        symbol: 'WLD_USDT',
        side: 'sell' as const,
        entryPrice: '4135',
        stopLoss: '0.39',
        targets: ['0.43'],
        raw: {},
      },
      signal: { entryPrice: 4135, stopLoss: 0.39 },
      currentPrice: WLD_CURRENT,
    });
    expect(bad).toBeNull();
  });

  it('无错位时返回null(不归一化)', () => {
    const res = normalizeDisplayPriceScale({
      parsed: {
        action: 'open' as const,
        symbol: 'WLD_USDT',
        side: 'buy' as const,
        entryPrice: '0.4135',
        stopLoss: '0.3989',
        targets: ['0.4913'],
        raw: {},
      },
      signal: { entryPrice: 0.4135, stopLoss: 0.3989 },
      currentPrice: WLD_CURRENT,
    });
    expect(res).toBeNull();
  });

  it('单字段判定保留0.2偏差逻辑: 偏离50倍阈值内不归一化', () => {
    // ratio=40 (<50阈值) -> 不归一化
    expect(detectDisplayPriceScaleFactor(40, 1, 50)).toBeNull();
    // ratio=10000 -> factor 10000
    expect(detectDisplayPriceScaleFactor(4135, WLD_CURRENT, 50)).toBe(10000);
  });
});
