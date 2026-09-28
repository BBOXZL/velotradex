import { listAILogs } from '../../src/routes/aiConfig';
import AILog from '../../src/models/AILog';

/**
 * S8 信号收件箱视角 —— ai_logs 加 "已忽略" 筛选（action=ignore，带 reasoning），
 * 不污染 strategies 状态机；改判逐条复用 S7 triggerOrder。
 */
describe('S8 signal inbox ignored tab', () => {
  test('listAILogs supports action=ignored filter with reasoning visible (ETH x3)', async () => {
    const findAndCountAll = jest.spyOn(AILog, 'findAndCountAll').mockResolvedValue({
      count: 3,
      rows: [
        { id: 33, response: JSON.stringify({ action: 'ignore', reasoning: 'watchlist 计划、PA 不明、无主动入场', confidence: 0.96 }) },
        { id: 34, response: JSON.stringify({ action: 'ignore', reasoning: '只有 setup 评论、无明确入场意图', confidence: 0.78 }) },
        { id: 35, response: JSON.stringify({ action: 'ignore', reasoning: '无明确入场' }) },
      ],
    } as any);

    // S8: 已忽略页签按 action=ignored 过滤（response LIKE %ignore%），且 reasoning 可见。
    const result = await listAILogs({ action: 'ignored', page: '1', limit: '20' } as any);

    expect(findAndCountAll).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ response: expect.anything() }),
    }));
    expect(result.total).toBe(3);
    expect(result.logs).toHaveLength(3);
    // reasoning 可见：每行都带可展示的 reasoning（ETH 三条）
    for (const row of result.logs as any[]) {
      expect(String(JSON.stringify(row))).toMatch(/reasoning/);
    }

    findAndCountAll.mockRestore();
  });
});
