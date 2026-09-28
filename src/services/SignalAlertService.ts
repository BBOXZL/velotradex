import SignalAlert from '../models/SignalAlert';
import logger, { formatError } from '../utils/logger';

/**
 * S8 拦截告警服务（D2 默认：先落库 + 面板红点，零新依赖）。
 * - 落库 signal_alerts（失败只记 warn，不阻塞主流程）；
 * - 面板红点 = 未读计数（GET /api/signal-alerts/unread-count）；
 * - webhook 派发沿用 auditService.log 的异步通道，不在这里重复推送。
 */
class SignalAlertService {
  public async raise(input: {
    strategyId?: number | null;
    kind: string;
    symbol?: string | null;
    routeId?: number | null;
    exchangeInstanceId?: string | null;
    reason?: string | null;
  }): Promise<void> {
    try {
      await SignalAlert.create({
        strategyId: input.strategyId ?? null,
        kind: input.kind,
        symbol: input.symbol ?? null,
        routeId: input.routeId ?? null,
        exchangeInstanceId: input.exchangeInstanceId ?? null,
        reason: input.reason ?? null,
        isRead: false,
      } as any);
    } catch (error: any) {
      logger.warn('Failed to write signal alert', formatError(error, { kind: input.kind }));
    }
  }

  public async unreadCount(): Promise<number> {
    try {
      return await SignalAlert.count({ where: { isRead: false } });
    } catch {
      return 0;
    }
  }

  public async markAllRead(): Promise<number> {
    try {
      const [affected] = await (SignalAlert as any).update(
        { isRead: true },
        { where: { isRead: false } }
      );
      return Number(affected) || 0;
    } catch {
      return 0;
    }
  }

  public async markRead(id: number): Promise<boolean> {
    try {
      const row = await SignalAlert.findByPk(id);
      if (!row) return false;
      (row as any).isRead = true;
      await row.save();
      return true;
    } catch {
      return false;
    }
  }
}

export const signalAlertService = new SignalAlertService();
export default signalAlertService;
