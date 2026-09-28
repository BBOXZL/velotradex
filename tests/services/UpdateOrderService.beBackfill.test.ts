import { GaulsParser } from '../../src/services/parsers/GaulsParser';
import { convertToStrategies, extractSymbolFromManagementMessage } from '../../src/services/parsers/RaizexbtStrategyConversion';
import { UpdateOrderService } from '../../src/services/executor/UpdateOrderService';

jest.mock('../../src/services/MarketService', () => ({
  __esModule: true,
  default: { getCurrentPrice: jest.fn().mockResolvedValue(0.42) },
}));

jest.mock('../../src/services/AIParserService', () => ({
  __esModule: true,
  default: { isConfigured: jest.fn().mockReturnValue(false), analyzeRaw: jest.fn() },
}));

jest.mock('../../src/models', () => ({
  Order: { findOne: jest.fn() },
}));

describe('S3 BE missing-symbol backfill (ai_logs#27)', () => {
  it('ai_logs#27原文回归: symbol为空+referencedSymbol=WLD+newStopLoss=breakeven => 1条 update/WLD_USDT/breakeven', async () => {
    const parser = new GaulsParser();
    const result = await parser.postProcess({
      action: 'update',
      // ai_logs#27: symbol 为空，WLD 只在 referencedSymbol 里
      referencedSymbol: 'WLD',
      newStopLoss: 'breakeven',
      confidence: 0.9,
      reasoning: 'Move SL to breakeven',
    } as any);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].action).toBe('update');
    expect(result![0].symbol).toBe('WLD_USDT');
    expect(result![0].stopLoss).toBe('breakeven');
  });

  it('close分支同样回填referencedSymbol', async () => {
    const parser = new GaulsParser();
    const result = await parser.postProcess({
      action: 'close',
      referencedSymbol: 'WLD',
      closePercentage: 100,
    } as any);

    expect(result).not.toBeNull();
    expect(result![0]).toMatchObject({ action: 'close', symbol: 'WLD_USDT', closePercentage: 100 });
  });

  it('双空仍返回null（open/close/update皆然）', async () => {
    const parser = new GaulsParser();
    await expect(parser.postProcess({ action: 'update', newStopLoss: 'breakeven' } as any)).resolves.toBeNull();
    await expect(parser.postProcess({ action: 'close', closePercentage: 100 } as any)).resolves.toBeNull();
    await expect(parser.postProcess({ action: 'open', side: 'buy', entries: [{ type: 'market' }] } as any)).resolves.toBeNull();
  });

  it('open分支不受回填影响（无symbol仍null；referencedSymbol不被误用）', async () => {
    const parser = new GaulsParser();
    await expect(
      parser.postProcess({ action: 'open', side: 'buy', referencedSymbol: 'WLD', entries: [{ type: 'market' }] } as any),
    ).resolves.toBeNull();
  });

  it('prompt update/close小节硬约束：必须同时输出一致symbol与referencedSymbol', () => {
    const prompt = new GaulsParser().buildPrompt();
    expect(prompt).toContain('symbol');
    expect(prompt).toContain('referencedSymbol');
    expect(prompt).toMatch(/close\/update[\s\S]*symbol[\s\S]*referencedSymbol/i);
  });
});

describe('S3 RaizexbtStrategyConversion同类单源补齐', () => {
  it('原文含$WLD时回填update符号为WLD_USDT', () => {
    expect(extractSymbolFromManagementMessage({ content: 'Move SL to breakeven $WLD' })).toBe('WLD_USDT');
    const strategies = convertToStrategies(
      { action: 'update', symbol: '', stopLoss: 'breakeven' } as any,
      { content: 'Move SL to breakeven $WLD' },
      'RaizexbtParser:',
    );
    expect(strategies).not.toBeNull();
    expect(strategies![0]).toMatchObject({ action: 'update', symbol: 'WLD_USDT', stopLoss: 'breakeven' });
  });

  it('无任何符号来源时仍返回null', () => {
    expect(extractSymbolFromManagementMessage({ content: 'Move SL to breakeven' })).toBeUndefined();
    expect(
      convertToStrategies({ action: 'update', symbol: '', stopLoss: 'breakeven' } as any, { content: 'hello' }, 'RaizexbtParser:'),
    ).toBeNull();
  });
});

describe('S3/G2 mock持仓走handleUpdate调到updateStopLoss且有UPDATING_SL审计', () => {
  it('BE update经UpdateOrderService落到updateStopLoss并记录UPDATING_SL+BE_SL_PLACED', async () => {
    const { Order } = require('../../src/models');
    (Order.findOne as jest.Mock).mockResolvedValue(null);

    const updateStopLoss = jest.fn().mockResolvedValue('sl-be-1');
    const exchange = {
      getPositions: jest.fn().mockResolvedValue([{ symbol: 'WLD_USDT', size: '10', entryPrice: '0.42' }]),
      getMarkets: jest.fn().mockResolvedValue([{ symbol: 'WLD_USDT', pricePrecision: 4 }]),
      updateStopLoss,
    };
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const services: any = {
      exchangeRegistry: { getExchange: jest.fn().mockReturnValue(exchange) },
      auditService: { log: auditLog },
      orderPersistenceHandler: { getOrderTrackedAmount: jest.fn().mockReturnValue(0) },
      protectionContext: { getProtectionManager: jest.fn() },
    };
    const svc = new UpdateOrderService(services, { handleClose: jest.fn() } as any);

    const result = await svc.handleUpdate(
      { action: 'update', symbol: 'WLD_USDT', stopLoss: 'breakeven', raw: {} } as any,
      27,
      'mock-exchange',
    );

    expect(result).toEqual(expect.objectContaining({ id: 'update-sl', status: 'filled', symbol: 'WLD_USDT' }));
    expect(updateStopLoss).toHaveBeenCalledWith(
      'WLD_USDT', 'buy', '0.4200', 't-sl-pos-WLD_USDT-sell', '10',
    );
    const actions = auditLog.mock.calls.map((c: any[]) => c[1]);
    expect(actions).toContain('UPDATING_SL');
    expect(actions).toContain('BE_SL_PLACED');
  });

  it('BE挂单失败走兜底全平并记录BE_FALLBACK_CLOSED（G2行为本身不变）', async () => {
    const { Order } = require('../../src/models');
    (Order.findOne as jest.Mock).mockResolvedValue(null);

    const exchange = {
      getPositions: jest.fn().mockResolvedValue([{ symbol: 'WLD_USDT', size: '10', entryPrice: '0.42' }]),
      getMarkets: jest.fn().mockResolvedValue([{ symbol: 'WLD_USDT', pricePrecision: 4 }]),
      updateStopLoss: jest.fn().mockResolvedValue(null),
    };
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const handleClose = jest.fn().mockResolvedValue({ id: 'close-1', status: 'filled', symbol: 'WLD_USDT' });
    const services: any = {
      exchangeRegistry: { getExchange: jest.fn().mockReturnValue(exchange) },
      auditService: { log: auditLog },
      orderPersistenceHandler: { getOrderTrackedAmount: jest.fn().mockReturnValue(0) },
      protectionContext: { getProtectionManager: jest.fn() },
    };
    const svc = new UpdateOrderService(services, { handleClose } as any);

    const result = await svc.handleUpdate(
      { action: 'update', symbol: 'WLD_USDT', stopLoss: 'breakeven', raw: {} } as any,
      27,
      'mock-exchange',
    );

    expect(handleClose).toHaveBeenCalled();
    expect(handleClose.mock.calls[0][0]).toMatchObject({ action: 'close', symbol: 'WLD_USDT', closePercentage: 100 });
    const actions = auditLog.mock.calls.map((c: any[]) => c[1]);
    expect(actions).toContain('BE_FALLBACK_CLOSED');
    expect(result).toEqual(expect.objectContaining({ id: 'close-1', status: 'filled' }));
  });
});
