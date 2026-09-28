import { GaulsParser } from '../../../src/services/parsers/GaulsParser';
import aiParserService from '../../../src/services/AIParserService';
import { AILog } from '../../../src/models';

jest.mock('../../../src/services/MarketService', () => ({
  __esModule: true,
  default: { getCurrentPrice: jest.fn().mockResolvedValue(100) },
}));

jest.mock('../../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  formatError: jest.fn((e: any, ctx?: any) => ({ errorMessage: e?.message, ...(ctx || {}) })),
}));

const message: any = { id: 'm1', channel_id: 'c1', content: '$XRP long CMP', ts: '2026-09-25T00:45:44.000Z' };

describe('S6 GaulsParser analyzeWithRetry', () => {
  afterEach(() => jest.restoreAllMocks());

  test('two 502s then success: upstream retried inside analyzeRaw, strategy parsed', async () => {
    const err502 = Object.assign(new Error('Upstream request failed'), { response: { status: 502, data: {} } });
    // analyzeRaw is the real implementation with mocked transport below.
    const service = aiParserService as any;
    const post = jest.fn()
      .mockRejectedValueOnce(err502)
      .mockRejectedValueOnce(err502)
      .mockResolvedValue({ data: { choices: [{ message: { content: '{"action":"open","side":"buy","symbol":"XRP","entries":[{"type":"market"}],"takeProfits":[1.733],"stopLoss":1.4484}' } }], usage: {} } });
    service.client = { post };
    service.config = {
      textModel: 't', visionModel: 'v', stripChinese: false,
      baseUrl: 'https://api.example.com/v1', extraPayload: null, requestTimeoutMs: 60000,
    };
    const createSpy = jest.spyOn(AILog, 'create').mockResolvedValue({ id: 1 } as any);
    const parser = new GaulsParser();
    const strategies = await parser.parse(message);
    expect(post).toHaveBeenCalledTimes(3);
    expect(strategies).not.toBeNull();
    expect(strategies![0]).toMatchObject({ action: 'open', symbol: 'XRP_USDT' });
    const statuses = createSpy.mock.calls.map(a => (a[0] as any).status);
    expect(statuses).toEqual(['error', 'error', 'success']);
    service.client = null;
    service.config = null;
  });

  test('persistent 502: returns null (no strategy) and enqueues delay record', async () => {
    const service = aiParserService as any;
    const post = jest.fn().mockRejectedValue(
      Object.assign(new Error('Upstream request failed'), { response: { status: 502, data: {} } }));
    service.client = { post };
    service.config = {
      textModel: 't', visionModel: 'v', stripChinese: false,
      baseUrl: 'https://api.example.com/v1', extraPayload: null, requestTimeoutMs: 60000,
    };
    jest.spyOn(AILog, 'create').mockResolvedValue({ id: 1 } as any);
    const enqueue = jest.fn().mockResolvedValue(undefined);
    service.delayQueue = { enqueue };
    const parser = new GaulsParser();
    const analyzeRawSpy = jest.spyOn(aiParserService, 'analyzeRaw');
    const strategies = await parser.parse(message);
    expect(strategies).toBeNull();
    // strict attempt exhausts (3 upstream calls), json_object fallback exhausts (3 more)
    expect(post.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(analyzeRawSpy).toHaveBeenCalledWith(expect.objectContaining({
      delayContext: expect.objectContaining({ messageId: 'm1', channelId: 'c1' }),
    }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1', channelId: 'c1' }));
    service.client = null;
    service.config = null;
    service.delayQueue = null;
  });

  test('400 does not retry upstream: single strict call, no fallback, null strategy', async () => {
    const service = aiParserService as any;
    const post = jest.fn().mockRejectedValue(
      Object.assign(new Error('Bad request'), { response: { status: 400, data: {} } }));
    service.client = { post };
    service.config = {
      textModel: 't', visionModel: 'v', stripChinese: false,
      baseUrl: 'https://api.example.com/v1', extraPayload: null, requestTimeoutMs: 60000,
    };
    jest.spyOn(AILog, 'create').mockResolvedValue({ id: 1 } as any);
    const parser = new GaulsParser();
    const strategies = await parser.parse(message);
    expect(strategies).toBeNull();
    // 400 is not retriable and not "unparseable-200", so no json_object fallback.
    expect(post).toHaveBeenCalledTimes(1);
    service.client = null;
    service.config = null;
  });
});
