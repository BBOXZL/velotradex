import aiParserService from '../../src/services/AIParserService';
import { AILog } from '../../src/models';

describe('S6 analyzeRaw upstream retry + ai_logs per attempt (RED)', () => {
  const service = aiParserService as any;

  beforeEach(() => {
    jest.spyOn(AILog, 'create').mockResolvedValue({ id: 1 } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    service.client = null;
    service.config = null;
  });

  function setupFailingThenSuccess() {
    const err502 = Object.assign(new Error('Upstream request failed'), { response: { status: 502, data: {} } });
    const post = jest.fn()
      .mockRejectedValueOnce(err502)
      .mockRejectedValueOnce(err502)
      .mockResolvedValue({
        data: {
          choices: [{ message: { content: '{"action":"ignore"}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });
    service.client = { post };
    service.config = {
      textModel: 'text-model', visionModel: 'vision-model', stripChinese: false,
      baseUrl: 'https://api.example.com/v1', extraPayload: null, requestTimeoutMs: 60000,
    };
    return { post };
  }

  test('two 502s then success: 3 upstream calls and 2 error + 1 success ai_logs', async () => {
    const { post } = setupFailingThenSuccess();
    // S6 requires configurable backoff; test injects zero delays so it runs fast.
    const result = await aiParserService.analyzeRaw({
      userContent: 'hello', retryDelaysMs: [0, 0, 0],
    } as any);
    expect(post).toHaveBeenCalledTimes(3);
    expect(result?.content).toContain('ignore');
    const creates = (AILog.create as jest.Mock).mock.calls;
    const statuses = creates.map(args => (args[0] as any).status);
    expect(statuses).toEqual(['error', 'error', 'success']);
  });

  test('4xx does not retry: single call, single error log', async () => {
    const err400 = Object.assign(new Error('Bad request'), { response: { status: 400, data: {} } });
    const post = jest.fn().mockRejectedValue(err400);
    service.client = { post };
    service.config = {
      textModel: 'text-model', visionModel: 'vision-model', stripChinese: false,
      baseUrl: 'https://api.example.com/v1', extraPayload: null, requestTimeoutMs: 60000,
    };
    await expect(aiParserService.analyzeRaw({ userContent: 'hello', retryDelaysMs: [0, 0, 0] } as any))
      .rejects.toThrow('Bad request');
    expect(post).toHaveBeenCalledTimes(1);
    expect((AILog.create as jest.Mock).mock.calls.map(a => (a[0] as any).status)).toEqual(['error']);
  });

  test('persistent 502 exhausts and enqueues a delay-queue record instead of throwing away', async () => {
    const err502 = Object.assign(new Error('Upstream request failed'), { response: { status: 502, data: {} } });
    const post = jest.fn().mockRejectedValue(err502);
    service.client = { post };
    service.config = {
      textModel: 'text-model', visionModel: 'vision-model', stripChinese: false,
      baseUrl: 'https://api.example.com/v1', extraPayload: null, requestTimeoutMs: 60000,
    };
    const enqueue = jest.fn().mockResolvedValue(undefined);
    (service as any).delayQueue = { enqueue };
    await expect(aiParserService.analyzeRaw({
      userContent: 'hello', retryDelaysMs: [0, 0, 0],
      delayContext: { messageId: 'm1', channelId: 'c1', routeIds: [5], routeNames: ['R5'] },
    } as any)).rejects.toThrow('Upstream request failed');
    expect(post).toHaveBeenCalledTimes(3);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1', channelId: 'c1' }));
  });
});
