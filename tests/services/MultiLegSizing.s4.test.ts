import { GaulsParser } from '../../src/services/parsers/GaulsParser';
import { PositionSizer } from '../../src/services/PositionSizer';
import { applyMultiLegSizing, normalizeMultiLegSizing } from '../../src/services/MultiLegSizing';
import ParserConfigService from '../../src/services/ParserConfigService';
import fs from 'node:fs';
import path from 'node:path';

jest.mock('../../src/services/MarketService', () => ({
  __esModule: true,
  default: { getCurrentPrice: jest.fn().mockResolvedValue(0.4286) },
}));

jest.mock('../../src/services/AIParserService', () => ({
  __esModule: true,
  default: { isConfigured: jest.fn().mockReturnValue(false), analyzeRaw: jest.fn() },
}));

describe('S4 多腿风险分摊可配置 (WLD双腿)', () => {
  // WLD双腿真凭据: 市价腿(CMP, 现价~0.4286) + limit腿0.4135, SL 0.3989, 风险5U
  const WLD_SIGNAL: any = {
    action: 'open',
    side: 'buy',
    symbol: 'WLD',
    entries: [{ type: 'market' }, { type: 'limit', price: 0.4135 }],
    takeProfits: [0.4913],
    stopLoss: 0.3989,
    confidence: 0.9,
  };
  const MARKET = { symbol: 'WLD_USDT', multiplier: '1', leverageMax: '10', amountPrecision: 0 };
  const BALANCE = { total: '200', available: '200' }; // 5U风险预算: 200*5%=10? 用fixed 5U更直接
  const fixed5 = { riskMode: 'fixed' as const, riskValue: 5, defaultLeverage: '5', priceTolerance: 0.01 };

  it('默认split: GaulsParser双腿weight=0.5保持现状', async () => {
    const parser = new GaulsParser();
    const res = await parser.postProcess({ ...WLD_SIGNAL });
    expect(res).not.toBeNull();
    expect(res).toHaveLength(2);
    expect(res![0].weight).toBe(0.5);
    expect(res![1].weight).toBe(0.5);
  });

  it('full: GaulsParser直调postProcess(signal,"full")双腿weight=1; 路由层applyMultiLegSizing同样生效', async () => {
    const parser = new GaulsParser();
    const directFull = await parser.postProcess({ ...WLD_SIGNAL }, 'full');
    expect(directFull).not.toBeNull();
    expect(directFull![0].weight).toBe(1);
    expect(directFull![1].weight).toBe(1);
    const res = await parser.postProcess({ ...WLD_SIGNAL });
    expect(res).not.toBeNull();
    const full = applyMultiLegSizing(res!, 'full');
    expect(full[0].weight).toBe(1);
    expect(full[1].weight).toBe(1);
    const split = applyMultiLegSizing(res!, 'split');
    expect(split[0].weight).toBe(0.5);
    expect(split[1].weight).toBe(0.5);
    // 单腿不受影响；缺省/非法回落split
    expect(applyMultiLegSizing([{ action: 'open', symbol: 'WLD_USDT' } as any], 'full')[0].weight).toBeUndefined();
    expect(normalizeMultiLegSizing(undefined)).toBe('split');
    expect(normalizeMultiLegSizing('half' as any)).toBe('split');
    expect(normalizeMultiLegSizing('full')).toBe('full');
  });

  it('同条WLD信号跑PositionSizer: split复现腿权重减半, full市价腿翻倍', () => {
    const sizer = new PositionSizer();
    // WLD真凭据口径: 市价腿 entry 0.4286, SL 0.3989 -> R=0.0297;
    // fixed 5U: 5/0.0297=168.35 -> floor(precision 0) = 168; split(0.5) -> 84
    const splitMarket = sizer.calculate({
      balance: BALANCE, market: MARKET, entryPrice: 0.4286, stopLoss: 0.3989,
      riskConfig: { ...fixed5 }, weight: 0.5,
    });
    const fullMarket = sizer.calculate({
      balance: BALANCE, market: MARKET, entryPrice: 0.4286, stopLoss: 0.3989,
      riskConfig: { ...fixed5 }, weight: 1,
    });
    // split复现文档§6.1的数量级关系(78/5为实盘Gate口径, 此处用fixed口径验证减半语义)
    expect(splitMarket.contracts).toBe(84);
    expect(fullMarket.contracts).toBe(168);
    expect(fullMarket.contracts).toBe(splitMarket.contracts * 2);
    // limit腿同步验证
    const splitLimit = sizer.calculate({
      balance: BALANCE, market: MARKET, entryPrice: 0.4135, stopLoss: 0.3989,
      riskConfig: { ...fixed5 }, weight: 0.5,
    });
    const fullLimit = sizer.calculate({
      balance: BALANCE, market: MARKET, entryPrice: 0.4135, stopLoss: 0.3989,
      riskConfig: { ...fixed5 }, weight: 1,
    });
    expect(fullLimit.contracts).toBe(splitLimit.contracts * 2);
  });

  it('validateConfig接受split/full/空, 拒绝非法值', () => {
    expect(ParserConfigService.validateConfig({})).toBeNull();
    expect(ParserConfigService.validateConfig({ multiLegSizing: 'split' })).toBeNull();
    expect(ParserConfigService.validateConfig({ multiLegSizing: 'full' })).toBeNull();
    expect(ParserConfigService.validateConfig({ multiLegSizing: '' })).toBeNull();
    expect(ParserConfigService.validateConfig({ multiLegSizing: 'half' })).toBe('multiLegSizing must be "split" or "full".');
  });

  it('Position size calculated日志含weight且可区分weight vs riskMultiplier', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'executor', 'OpenPositionService.ts'), 'utf8');
    expect(src).toContain('weight');
    // 日志行必须同时出现 weight 与 riskMultiplier, 且注释/代码可区分两条路径
    const idx = src.indexOf('Position size calculated');
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, idx - 200), idx + 600);
    expect(window).toContain('weight');
    expect(window).toContain('riskMultiplier');
  });

  it('entrySelection与multiLegSizing先后关系有文档声明(先过滤后分摊)+G4 CMP说明', () => {
    const sel = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'EntrySelection.ts'), 'utf8');
    expect(sel).toContain('multiLegSizing');
    expect(sel).toMatch(/先过滤|过滤.*分摊|filter.*sizing/i);
    expect(sel).toMatch(/CMP|市价/);
  });

  it('面板开关旁写明full下双腿全中约2倍风险', () => {
    const vue = fs.readFileSync(
      path.join(__dirname, '..', '..', 'admin-web', 'src', 'components', 'RouteEditDialog.vue'), 'utf8');
    expect(vue).toContain('multiLegSizing');
    expect(vue).toMatch(/2\s*倍/);
  });
});
