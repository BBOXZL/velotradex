import { Op } from 'sequelize';
import AIDelayQueue from '../models/AIDelayQueue';
import Strategy from '../models/Strategy';
import auditService from './AuditService';
import webhookService from './WebhookService';
import aiParserService from './AIParserService';
import logger, { formatError } from '../utils/logger';
import { safeStringify } from '../utils/json';

export interface AIDelayEnqueueInput {
  messageId: string;
  channelId: string;
  rawMessage?: any;
  routeIds?: number[];
  routeNames?: string[];
  originalTimestamp?: string | null;
  retryCount?: number;
  nextRetryAt?: Date;
}

export interface AIDelayWorkerDeps {
  deliver: (message: any) => Promise<void>;
  queue?: typeof AIDelayQueue;
  strategies?: typeof Strategy;
  audit?: typeof auditService;
  webhooks?: typeof webhookService;
  now?: () => number;
  maxAgeMs?: number;
  intervalMs?: number;
}

function parseStoredMessage(raw: string | null): any | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseNumberArray(value: string | null): number[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const numbers = parsed.map((item) => Number(item)).filter((item) => Number.isFinite(item));
    return numbers.length ? numbers : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const strings = parsed.map((item) => String(item).trim()).filter(Boolean);
    return strings.length ? strings : undefined;
  } catch {
    return undefined;
  }
}

/**
 * S6 AI 延迟重试队列。
 *
 * - 入队去重：messageId 唯一（Discord 全局唯一），重复入队直接返回现行记录，
 *   不依赖 60 秒内容哈希（G3）。
 * - worker 每分钟扫描到期的 pending 记录，重投 deliver（即 handleChannelMessage），
 *   并显式传入 routeIds/routeNames（worker 上下文里没有 AsyncLocalStorage）。
 * - 执行去重：重投前按 messageId 查 strategies 是否已有 executed/simulated 记录，
 *   有则标记 done 并跳过，避免延迟重试重复下单。
 * - 30 分钟耗尽：记 AI_RETRY_EXHAUSTED 审计 + 走 S8 通道告警（webhook dispatch），
 *   不产生 strategy。
 */
export class AIDelayQueueService {
  static readonly DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
  static readonly DEFAULT_INTERVAL_MS = 60 * 1000;

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: AIDelayWorkerDeps) {}

  public async enqueue(input: AIDelayEnqueueInput): Promise<AIDelayQueue> {
    const queue = this.deps.queue || AIDelayQueue;
    const messageId = String(input.messageId || '').trim();
    if (!messageId) throw new Error('AIDelayQueue.enqueue requires messageId');
    const existing = await queue.findOne({ where: { messageId } });
    // messageId 长效去重：重复入队直接返回现行记录。
    if (existing) return existing;
    const now = this.deps.now ? this.deps.now() : Date.now();
    const record = await queue.create({
      messageId,
      channelId: String(input.channelId || ''),
      rawMessage: typeof input.rawMessage === 'string' ? input.rawMessage : safeStringify(input.rawMessage ?? null),
      routeIds: input.routeIds?.length ? JSON.stringify(input.routeIds) : null,
      routeNames: input.routeNames?.length ? JSON.stringify(input.routeNames) : null,
      originalTimestamp: input.originalTimestamp ?? null,
      retryCount: input.retryCount ?? 0,
      nextRetryAt: input.nextRetryAt ?? new Date(now + 60_000),
      status: 'pending',
    } as any);
    await (this.deps.audit || auditService).log(0, 'AI_RETRY_QUEUED', {
      messageId, channelId: input.channelId, nextRetryAt: record.nextRetryAt,
    });
    return record;
  }

  public start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.intervalMs ?? AIDelayQueueService.DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.tickOnce().catch((error: any) => {
        logger.error('AI delay queue tick failed', formatError(error));
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  public async tickOnce(nowMs?: number): Promise<{ processed: number; exhausted: number }> {
    if (this.running) return { processed: 0, exhausted: 0 };
    this.running = true;
    try {
      const queue = this.deps.queue || AIDelayQueue;
      const strategies = this.deps.strategies || Strategy;
      const audit = this.deps.audit || auditService;
      const webhooks = this.deps.webhooks || webhookService;
      const now = nowMs ?? (this.deps.now ? this.deps.now() : Date.now());
      const maxAgeMs = this.deps.maxAgeMs ?? AIDelayQueueService.DEFAULT_MAX_AGE_MS;

      const due = await queue.findAll({
        where: { status: 'pending', nextRetryAt: { [Op.lte]: new Date(now) } },
        order: [['nextRetryAt', 'ASC']],
        limit: 20,
      });

      let processed = 0;
      let exhausted = 0;
      for (const record of due) {
        const ageMs = now - new Date((record as any).createdAt || now).getTime();
        // 30 分钟耗尽：记 AI_RETRY_EXHAUSTED + 告警，不产生 strategy。
        if (ageMs >= maxAgeMs) {
          await record.update({ status: 'exhausted', lastError: 'AI retry window exhausted (30m)' });
          await audit.log(0, 'AI_RETRY_EXHAUSTED', {
            messageId: (record as any).messageId, channelId: (record as any).channelId,
            retryCount: (record as any).retryCount, ageMs,
          });
          // S8 通道告警：沿用 audit 的 webhook 派发（落库 + 面板红点之外的推送面）。
          await webhooks.dispatch('AI_RETRY_EXHAUSTED', {
            messageId: (record as any).messageId, channelId: (record as any).channelId,
            retryCount: (record as any).retryCount, ageMs,
          }).catch((error: any) => logger.error('AI_RETRY_EXHAUSTED webhook failed', formatError(error)));
          exhausted++;
          continue;
        }

        // 执行层去重：该 messageId 已有 executed/simulated strategy 则跳过重投。
        const rawMessage = parseStoredMessage((record as any).rawMessage);
        const executed = rawMessage
          ? await strategies.findOne({
              where: {
                rawMessage: { [Op.like]: `%${(record as any).messageId}%` },
                status: { [Op.in]: ['processed'] },
              },
            }).catch(() => null)
          : null;
        if (executed) {
          await record.update({ status: 'done' });
          await audit.log(0, 'AI_RETRY_DEDUPED', {
            messageId: (record as any).messageId, strategyId: (executed as any).id,
          });
          processed++;
          continue;
        }

        const message = rawMessage && typeof rawMessage === 'object'
          ? { ...rawMessage, id: (record as any).messageId, channel_id: (record as any).channelId }
          : { id: (record as any).messageId, channel_id: (record as any).channelId, content: rawMessage || '' };
        const routeIds = parseNumberArray((record as any).routeIds);
        const routeNames = parseStringArray((record as any).routeNames);
        const originalTimestamp = (record as any).originalTimestamp as string | null;
        const retriedAt = new Date(now).toISOString();
        try {
          // worker 重投显式传 routeIds/routeNames（AsyncLocalStorage 在 worker
          // 上下文里没有，走 resolveRouteLogFields 的显式参数分支）。
          await aiParserService.runWithRouteContext({ routeIds, routeNames }, () => this.deps.deliver(message));
          await record.update({ status: 'done' });
          await audit.log(0, 'AI_RETRY_DELIVERED', {
            messageId: (record as any).messageId, channelId: (record as any).channelId,
            routeIds, routeNames, retriedAt, originalTimestamp,
            lagMs: originalTimestamp ? now - Date.parse(originalTimestamp) : null,
          });
          processed++;
        } catch (error: any) {
          const retryCount = Number((record as any).retryCount || 0) + 1;
          await record.update({
            retryCount,
            lastError: String(error?.message || error),
            nextRetryAt: new Date(now + 60_000),
          });
          await audit.log(0, 'AI_RETRY_FAILED', {
            messageId: (record as any).messageId, channelId: (record as any).channelId,
            retryCount, error: String(error?.message || error), retriedAt, originalTimestamp,
          });
        }
      }
      return { processed, exhausted };
    } finally {
      this.running = false;
    }
  }
}

export default AIDelayQueueService;
