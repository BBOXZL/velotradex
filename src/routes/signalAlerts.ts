import Router from 'koa-router';
import SignalAlert from '../models/SignalAlert';
import signalAlertService from '../services/SignalAlertService';

const router = new Router();

/**
 * S8 拦截告警查询（D2：落库 + 面板红点）。
 * - GET /api/signal-alerts?isRead=false&page&limit：告警列表（默认未读优先，按时间倒序）；
 * - GET /api/signal-alerts/unread-count：面板红点计数；
 * - POST /api/signal-alerts/read：全部标已读（红点清零）；
 * - POST /api/signal-alerts/:id/read：单条标已读。
 */

// 未读计数（面板红点）
router.get('/unread-count', async (ctx) => {
  ctx.body = { unread: await signalAlertService.unreadCount() };
});

// 列表
router.get('/', async (ctx) => {
  const page = Number(ctx.query.page || 1);
  const limit = Math.min(Number(ctx.query.limit || 20), 100);
  const offset = (page - 1) * limit;
  const where: any = {};
  if (ctx.query.isRead === 'true') where.isRead = true;
  if (ctx.query.isRead === 'false') where.isRead = false;
  if (ctx.query.kind) where.kind = String(ctx.query.kind);

  const { count, rows } = await SignalAlert.findAndCountAll({
    where,
    limit,
    offset,
    order: [['createdAt', 'DESC']],
  });
  ctx.body = { total: count, page, limit, alerts: rows };
});

// 全部标已读
router.post('/read', async (ctx) => {
  const marked = await signalAlertService.markAllRead();
  ctx.body = { success: true, marked };
});

// 单条标已读
router.post('/:id/read', async (ctx) => {
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid alert id' };
    return;
  }
  const ok = await signalAlertService.markRead(id);
  if (!ok) {
    ctx.status = 404;
    ctx.body = { error: 'Alert not found' };
    return;
  }
  ctx.body = { success: true };
});

export async function listSignalAlerts(query: Record<string, any>) {
  const page = Number(query.page || 1);
  const limit = Math.min(Number(query.limit || 20), 100);
  const offset = (page - 1) * limit;
  const where: any = {};
  if (query.isRead === 'true' || query.isRead === true) where.isRead = true;
  if (query.isRead === 'false' || query.isRead === false) where.isRead = false;
  if (query.kind) where.kind = String(query.kind);
  const { count, rows } = await SignalAlert.findAndCountAll({
    where,
    limit,
    offset,
    order: [['createdAt', 'DESC']],
  });
  return { total: count, page, limit, alerts: rows };
}

export default router;
