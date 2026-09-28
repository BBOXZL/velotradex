import { Client, Events, GatewayIntentBits, Routes } from 'discord.js';
import logger from '../utils/logger';
import auditService from './AuditService';
import {
  DiscordUserGateway,
  DiscordUserGatewayConnection,
  DiscordUserGatewayHandlers,
  DiscordConnectionError,
} from './DiscordUserGateway';

export interface DiscordGatewayOptions {
  token: string;
  channelIds: string[];
  deliver: (message: any) => Promise<void>;
  tokenMode?: 'bot' | 'user';
  clientFactory?: () => Client;
  userGatewayFactory?: (token: string, handlers: DiscordUserGatewayHandlers) => DiscordUserGatewayConnection;
  degradedAfterConsecutiveFailures?: number;
  rebuildDelaysMs?: number[];
}

export function normalizeDiscordMessage(raw: any, kind: 'new' | 'edit' = 'new'): any {
  const author = raw.author || {};
  const timestamp = raw.timestamp || raw.edited_timestamp;
  return {
    ...raw,
    id: String(raw.id),
    channel_id: String(raw.channel_id),
    content: typeof raw.content === 'string' ? raw.content : '',
    ts: Date.parse(timestamp) || Date.now(),
    username: author.username || author.global_name || '',
    author_id: author.id || '',
    reply_to: raw.message_reference?.message_id || '',
    kind,
    attachments: (raw.attachments || []).map((attachment: any) => ({
      ...attachment,
      is_image: String(attachment.content_type || '').startsWith('image/')
        || /\.(png|jpe?g|gif|webp)(?:\?|$)/i.test(attachment.filename || attachment.url || ''),
    })),
    embeds: raw.embeds || [],
  };
}

export interface DiscordFailureContext {
  message?: string;
  stack?: string;
  channelId?: string;
  messageId?: string;
  packetType?: string;
  pending?: number;
}

export class DiscordGatewayService {
  static readonly DEFAULT_DEGRADED_AFTER_CONSECUTIVE_FAILURES = 5;
  static readonly MAX_REBUILD_ATTEMPTS = 3;
  static readonly DEFAULT_REBUILD_DELAYS_MS = [1000, 2000, 4000];

  private client: Client | null = null;
  private userGateway: DiscordUserGatewayConnection | null = null;
  private channels: Set<string>;
  private cache = new Map<string, any>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private state: 'stopped' | 'connecting' | 'ready' | 'reconnecting' | 'degraded' | 'failed' = 'stopped';
  private lastMessageAt: number | null = null;
  private lastError: string | null = null;
  private lastFailureMessageId: string | null = null;
  private consecutiveDeliverFailures = 0;
  private rebuildAttempts = 0;
  private rebuildTimer: NodeJS.Timeout | null = null;

  constructor(private options: DiscordGatewayOptions) {
    this.channels = new Set(options.channelIds);
    if (options.tokenMode === 'user') {
      const handlers: DiscordUserGatewayHandlers = {
        onDispatch: packet => this.enqueue(packet),
        onReady: () => {
          if (this.state !== 'failed' && this.state !== 'stopped') this.state = 'ready';
          logger.info('Discord user Gateway ready', { channelCount: this.channels.size });
        },
        onReconnect: () => {
          if (this.state !== 'failed' && this.state !== 'stopped') this.state = 'reconnecting';
        },
        onError: error => {
          if (this.state === 'stopped') return;
          this.lastError = error instanceof DiscordConnectionError ? error.message : 'Discord user Gateway connection error';
          this.fail(error);
        },
      };
      this.userGateway = options.userGatewayFactory?.(options.token, handlers)
        || new DiscordUserGateway({ token: options.token, handlers });
    } else {
      this.client = options.clientFactory?.() || new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      });
      this.client.on(Events.Raw, packet => this.enqueue(packet));
      this.client.on(Events.ClientReady, () => {
        if (this.state === 'stopped') return;
        if (this.state !== 'failed') this.state = 'ready';
        logger.info('Discord Gateway ready', { channelCount: this.channels.size });
      });
      this.client.on(Events.ShardReconnecting, () => {
        if (this.state === 'stopped' || this.state === 'failed') return;
        this.state = 'reconnecting';
      });
      this.client.on(Events.ShardResume, () => {
        if (this.state === 'stopped' || this.state === 'failed') return;
        this.state = 'ready';
      });
      this.client.on(Events.Error, (error: unknown) => {
        if (this.state === 'stopped') return;
        this.lastError = error instanceof Error ? error.message : 'Discord client error';
        this.fail(error);
      });
      this.client.on(Events.ShardError, (error: unknown) => {
        if (this.state === 'stopped') return;
        this.lastError = error instanceof Error ? error.message : 'Discord Gateway connection error';
        this.fail(error);
      });
    }
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') return;
    if (!this.options.token || !this.channels.size) throw new Error('Discord token and channel allowlist are required');
    this.state = 'connecting';
    try {
      await this.connectTransport();
    } catch (error) {
      this.state = 'failed';
      await this.userGateway?.close().catch(() => undefined);
      await this.client?.destroy().catch(() => undefined);
      if (error instanceof DiscordConnectionError) throw error;
      throw new Error(this.options.tokenMode === 'user'
        ? 'Discord user Gateway login failed; verify the user token and account channel access'
        : 'Discord bot login failed; verify the bot token and Message Content Intent');
    }
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    await this.userGateway?.close();
    await this.client?.destroy();
    await this.drain();
  }

  async drain(): Promise<void> {
    await this.queue;
  }

  getStatus() {
    return { state: this.state, pending: this.pending, lastMessageAt: this.lastMessageAt,
      channelCount: this.channels.size, error: this.lastError,
      lastFailureMessageId: this.lastFailureMessageId,
      consecutiveDeliverFailures: this.consecutiveDeliverFailures };
  }

  async verifyChannelAccess(): Promise<void> {
    for (const channelId of this.channels) {
      if (this.userGateway) await this.userGateway.rest.get(`/channels/${channelId}/messages?limit=1`);
      else await this.client!.rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '1' }) });
    }
  }

  getTokenMode(): 'bot' | 'user' {
    return this.options.tokenMode || 'bot';
  }

  private enqueue(packet: any): void {
    if (this.state === 'stopped' || this.state === 'failed') return;
    const raw = packet.d;
    if (!this.channels.has(raw?.channel_id)) return;
    if (packet.t === 'MESSAGE_DELETE' || packet.t === 'MESSAGE_DELETE_BULK') {
      logger.warn('Discord message deleted; deletion alone is not a trading instruction', {
        channelId: raw.channel_id, messageId: raw.id,
      });
      return;
    }
    if (!['MESSAGE_CREATE', 'MESSAGE_UPDATE'].includes(packet.t)) return;
    if (this.pending >= 1000) {
      this.fail(undefined, { channelId: String(raw?.channel_id), messageId: String(raw?.id),
        packetType: String(packet.t), pending: this.pending });
      return;
    }
    // Socket stays open in degraded mode: we only skip execution here, so a
    // later success can bring the service back to ready without reconnecting.
    // Manual recovery path: an operator-triggered reload()/start() while degraded
    // re-arms the service; the next successful delivery clears the counter.
    if (this.state === 'degraded') {
      void auditService.log(0, 'DISCORD_DELIVERY_SKIPPED_DEGRADED', {
        channelId: String(raw?.channel_id), messageId: String(raw?.id),
        packetType: String(packet.t), pending: this.pending,
      }).catch(() => undefined);
      return;
    }
    this.pending++;
    // Serial delivery preserves open -> stop update -> close ordering, including
    // asynchronous AI parsing. We do not replay historical opens on startup.
    this.queue = this.queue.then(async () => {
      if (this.state === 'failed' || this.state === 'stopped') return;
      const key = `${raw.channel_id}:${raw.id}`;
      const previous = this.cache.get(key);
      let complete = raw;
      if (packet.t === 'MESSAGE_UPDATE') {
        const base = previous || await (this.userGateway
          ? this.userGateway.rest.get(`/channels/${raw.channel_id}/messages/${raw.id}`)
          : this.client!.rest.get(Routes.channelMessage(raw.channel_id, raw.id)));
        complete = { ...base, ...raw };
      }
      const message = normalizeDiscordMessage(complete, packet.t === 'MESSAGE_UPDATE' ? 'edit' : 'new');
      if (previous && this.fingerprint(previous) === this.fingerprint(complete)) return;
      try {
        await this.options.deliver(message);
      } catch (error) {
        this.consecutiveDeliverFailures++;
        this.lastFailureMessageId = String(raw?.id ?? '');
        const context = { channelId: String(raw?.channel_id), messageId: String(raw?.id),
          packetType: String(packet.t), pending: this.pending };
        logger.error('Discord message delivery failed', { ...this.toFailureContext(error, context) });
        void auditService.log(0, 'DISCORD_DELIVERY_FAILED', { ...context,
          errorMessage: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? String(error.stack || '').slice(0, 500) : undefined,
        }).catch(() => undefined);
        if (this.consecutiveDeliverFailures >= this.degradedAfterFailures()) {
          this.state = 'degraded';
          logger.error('Discord Gateway degraded after consecutive delivery failures; socket stays online, messages are audited but skipped', {
            consecutiveFailures: this.consecutiveDeliverFailures, ...context,
          });
        }
        return;
      }
      this.consecutiveDeliverFailures = 0;
      if (this.state === 'degraded') {
        this.state = 'ready';
        logger.info('Discord Gateway recovered from degraded after successful delivery', {
          channelId: String(raw?.channel_id), messageId: String(raw?.id),
        });
      }
      this.lastMessageAt = Date.now();
      this.cache.delete(key);
      this.cache.set(key, complete);
      if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
    }).finally(() => { this.pending--; });
  }

  private fingerprint(raw: any): string {
    return JSON.stringify([raw.content || '', raw.attachments || [], raw.embeds || [], raw.message_reference || null]);
  }

  private degradedAfterFailures(): number {
    const configured = this.options.degradedAfterConsecutiveFailures;
    return Number.isFinite(configured as number) && (configured as number) > 0
      ? Math.floor(configured as number)
      : DiscordGatewayService.DEFAULT_DEGRADED_AFTER_CONSECUTIVE_FAILURES;
  }

  private toFailureContext(error: unknown, partial: { channelId?: string; messageId?: string; packetType?: string; pending?: number }): DiscordFailureContext {
    return {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? String(error.stack || '').slice(0, 500) : undefined,
      channelId: partial.channelId,
      messageId: partial.messageId,
      packetType: partial.packetType,
      pending: partial.pending,
    };
  }

  private fail(error?: unknown, partial?: { channelId?: string; messageId?: string; packetType?: string; pending?: number }): void {
    const context = this.toFailureContext(error, {
      channelId: partial?.channelId,
      messageId: partial?.messageId,
      packetType: partial?.packetType,
      pending: partial?.pending ?? this.pending,
    });
    const isOverflow = error === undefined && (partial?.pending ?? this.pending) >= 1000;
    if (context.messageId) this.lastFailureMessageId = context.messageId;
    this.lastError = context.message || 'Discord Gateway failure';
    if (isOverflow) {
      logger.error(`Discord queue overflow (pending=${context.pending}); reconcile messages before restarting`, context);
    } else {
      logger.error('Discord message delivery failed', context);
    }
    void auditService.log(0, 'DISCORD_DELIVERY_FAILED', {
      channelId: context.channelId, messageId: context.messageId, packetType: context.packetType,
      pending: context.pending, errorMessage: context.message, stack: context.stack, overflow: isOverflow,
    }).catch(() => undefined);
    this.state = 'failed';
    // Gateway-level failures (auth/session/overflow/network) self-heal with
    // exponential-backoff rebuilds before giving up for manual recovery.
    // Deliver-path failures never reach fail(); only gateway-level errors rebuild.
    // NOTE: close the broken socket synchronously, then schedule the rebuild so
    // the fresh connect() is not torn down by the close above.
    void this.userGateway?.close().catch(() => {});
    void this.client?.destroy().catch(() => {});
    const shouldRebuild = isOverflow || error instanceof DiscordConnectionError;
    if (shouldRebuild) this.scheduleRebuild();
  }

  private scheduleRebuild(): void {
    if (this.state === 'stopped') return;
    if (this.rebuildAttempts >= DiscordGatewayService.MAX_REBUILD_ATTEMPTS) return;
    const delays = this.options.rebuildDelaysMs ?? DiscordGatewayService.DEFAULT_REBUILD_DELAYS_MS;
    const delay = delays[Math.min(this.rebuildAttempts, delays.length - 1)] ?? 1000;
    this.state = 'reconnecting';
    this.rebuildAttempts++;
    const attempt = this.rebuildAttempts;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    if (delay <= 0) {
      // Zero-delay path (tests / tight recovery): run on the microtask queue so
      // fake timers are not required to observe the rebuild.
      this.rebuildTimer = setTimeout(() => {}, 0);
      void this.rebuild(attempt).finally(() => {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
        this.rebuildTimer = null;
      });
      return;
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      if (this.state === 'stopped') return;
      void this.rebuild(attempt);
    }, delay);
  }

  private async connectTransport(): Promise<void> {
    if (this.userGateway) await this.userGateway.connect();
    else await this.client!.login(this.options.token);
  }

  private async rebuild(attempt: number): Promise<void> {
    if (this.state === 'stopped') return;
    try {
      await this.connectTransport();
      this.rebuildAttempts = 0;
      this.state = 'ready';
      const since = this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : 'unknown';
      logger.info(`Discord Gateway rebuilt; reconcile messages since ${since} before trusting new signals`, {
        since, attempts: attempt,
      });
    } catch (error) {
      if (attempt >= DiscordGatewayService.MAX_REBUILD_ATTEMPTS) {
        this.state = 'failed';
        logger.error('Discord Gateway rebuild exhausted; manual recovery required', {
          attempts: attempt, ...this.toFailureContext(error, { pending: this.pending }),
        });
        return;
      }
      this.scheduleRebuild();
    }
  }
}

export function createDiscordGatewayFromConfig(deliver: (message: any) => Promise<void>): DiscordGatewayService | null {
  const userToken = (process.env.DISCORD_TOKEN || process.env.DISCORD_USER_TOKEN || '').trim();
  const botToken = (process.env.DISCORD_BOT_TOKEN || '').trim();
  const tokenMode = (process.env.DISCORD_TOKEN_MODE || (userToken ? 'user' : 'bot')).toLowerCase() as 'bot' | 'user';
  const token = tokenMode === 'user' ? userToken : botToken;
  const channelIds = (process.env.DISCORD_CHANNEL_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  const degradedAfterConsecutiveFailures = Number(process.env.DISCORD_DEGRADED_AFTER_CONSECUTIVE_FAILURES || '');
  if (!token && channelIds.length === 0) return null;
  if (!['bot', 'user'].includes(tokenMode)) {
    throw new Error('DISCORD_TOKEN_MODE must be bot or user');
  }
  if (!token || !channelIds.length || channelIds.some(id => !/^\d+$/.test(id))) {
    throw new Error(tokenMode === 'user'
      ? 'Set DISCORD_TOKEN and comma-separated numeric DISCORD_CHANNEL_IDS'
      : 'Set DISCORD_BOT_TOKEN and comma-separated numeric DISCORD_CHANNEL_IDS');
  }
  logger.warn(`Discord Gateway ${tokenMode} token mode enabled; token value is never logged`);
  return new DiscordGatewayService({ token, tokenMode, channelIds, deliver,
    ...(Number.isFinite(degradedAfterConsecutiveFailures) && degradedAfterConsecutiveFailures > 0
      ? { degradedAfterConsecutiveFailures: Math.floor(degradedAfterConsecutiveFailures) } : {}) });
}
