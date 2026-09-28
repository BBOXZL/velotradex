import { createRouter } from '../../src/routes/index';
import config from '../../src/config';
import { sequelize } from '../../src/models';

/**
 * 面板"开始下单"总开关：POST /api/config/trading-mode（admin）。
 * TDD RED：该路由尚不存在，先把期望行为钉死。
 */
function findLayer(router: any, method: string, path: string) {
  return router.stack.find(
    (l: any) => l.path === path && l.methods.includes(method)
  );
}

async function runLayer(layer: any, ctx: any) {
  const fns = layer.stack as any[];
  let i = -1;
  const next = async (): Promise<void> => {
    i += 1;
    if (i < fns.length) await fns[i](ctx, next);
  };
  await next();
}

function adminCtx(mode: any): any {
  return {
    path: '/api/config/trading-mode',
    method: 'POST',
    request: { body: { mode } },
    state: { user: { id: 1, username: 'admin', role: 'admin' } },
    status: 200,
    body: undefined,
  };
}

describe('POST /api/config/trading-mode', () => {
  const prevMode = config.trading.mode;

  afterEach(() => {
    config.trading.mode = prevMode;
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('registers the route', () => {
    const router = createRouter();
    expect(findLayer(router, 'POST', '/api/config/trading-mode')).toBeDefined();
  });

  it('rejects non-admin with 403', async () => {
    const router = createRouter();
    const layer = findLayer(router, 'POST', '/api/config/trading-mode');
    const ctx: any = {
      ...adminCtx('testnet'),
      state: { user: { id: 2, username: 'viewer', role: 'viewer' } },
    };
    await runLayer(layer, ctx);
    expect(ctx.status).toBe(403);
    expect(config.trading.mode).toBe(prevMode);
  });

  it('rejects invalid mode with 400', async () => {
    const router = createRouter();
    const layer = findLayer(router, 'POST', '/api/config/trading-mode');
    const ctx = adminCtx('turbo');
    await runLayer(layer, ctx);
    expect(ctx.status).toBe(400);
    expect(config.trading.mode).toBe(prevMode);
  });

  it('switches mode and flips enableTrading live', async () => {
    const router = createRouter();
    const layer = findLayer(router, 'POST', '/api/config/trading-mode');

    const ctxOpen = adminCtx('testnet');
    await runLayer(layer, ctxOpen);
    expect(ctxOpen.body).toMatchObject({ mode: 'testnet', enableTrading: true });
    expect(config.trading.mode).toBe('testnet');
    expect(config.enableTrading).toBe(true);

    const ctxClose = adminCtx('observe');
    await runLayer(layer, ctxClose);
    expect(ctxClose.body).toMatchObject({ mode: 'observe', enableTrading: false });
    expect(config.enableTrading).toBe(false);
  });
});
