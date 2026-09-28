import { createRouter } from '../../src/routes/index';

/**
 * S8: 告警 API —— 未读计数（面板红点）与标已读。
 */
function runLayer(router: any, method: string, path: string) {
  return router.stack.find((l: any) => l.path === path && l.methods.includes(method));
}

async function runStack(layer: any, ctx: any) {
  const fns = layer.stack as any[];
  let i = -1;
  const next = async (): Promise<void> => {
    i += 1;
    if (i < fns.length) await fns[i](ctx, next);
  };
  await next();
}

describe('S8 signal alerts API', () => {
  test('GET /api/signal-alerts/unread-count returns unread badge count', async () => {
    const SignalAlert = require('../../src/models/SignalAlert').default;
    const countSpy = jest.spyOn(SignalAlert, 'count').mockResolvedValue(3);
    const router = createRouter();
    const layer = runLayer(router, 'GET', '/api/signal-alerts/unread-count');
    expect(layer).toBeDefined();
    const ctx: any = { body: undefined, status: 200, query: {}, params: {} };
    await runStack(layer, ctx);
    expect(ctx.body).toEqual({ unread: 3 });
    countSpy.mockRestore();
  });

  test('POST /api/signal-alerts/read marks all unread as read', async () => {
    const SignalAlert = require('../../src/models/SignalAlert').default;
    const updateSpy = jest.spyOn(SignalAlert, 'update').mockResolvedValue([2]);
    const router = createRouter();
    const layer = runLayer(router, 'POST', '/api/signal-alerts/read');
    expect(layer).toBeDefined();
    const ctx: any = { body: undefined, status: 200, query: {}, params: {}, request: { body: {} } };
    await runStack(layer, ctx);
    expect(ctx.body).toEqual({ success: true, marked: 2 });
    expect(updateSpy).toHaveBeenCalledWith({ isRead: true }, { where: { isRead: false } });
    updateSpy.mockRestore();
  });
});
