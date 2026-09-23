import { Client, Events, GatewayIntentBits, Routes } from 'discord.js';
import logger from '../utils/logger';

export interface DiscordGatewayOptions {
  token: string;
  channelIds: string[];
  deliver: (message: any) => Promise<void>;
  tokenMode?: 'bot' | 'user';
  clientFactory?: () => Client;
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

export class DiscordGatewayService {
  private client: Client;
  private channels: Set<string>;
  private cache = new Map<string, any>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private state: 'stopped' | 'connecting' | 'ready' | 'reconnecting' | 'failed' = 'stopped';
  private lastMessageAt: number | null = null;

  constructor(private options: DiscordGatewayOptions) {
    this.channels = new Set(options.channelIds);
    this.client = options.clientFactory?.() || new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    this.client.on(Events.Raw, packet => this.enqueue(packet));
    this.client.on(Events.ClientReady, () => {
      if (this.state !== 'failed' && this.state !== 'stopped') this.state = 'ready';
      logger.info('Discord Gateway ready', { channelCount: this.channels.size });
    });
    this.client.on(Events.ShardReconnecting, () => {
      if (this.state !== 'failed' && this.state !== 'stopped') this.state = 'reconnecting';
    });
    this.client.on(Events.ShardResume, () => {
      if (this.state !== 'failed' && this.state !== 'stopped') this.state = 'ready';
    });
    // Do not log SDK errors verbatim: HTTP errors can contain credentials.
    this.client.on(Events.Error, () => logger.error('Discord client error; check connectivity and bot permissions'));
    this.client.on(Events.ShardError, () => logger.error('Discord Gateway connection error'));
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') return;
    if (!this.options.token || !this.channels.size) throw new Error('Discord token and channel allowlist are required');
    this.state = 'connecting';
    try {
      await this.client.login(this.options.token);
    } catch {
      this.state = 'failed';
      await this.client.destroy();
      throw new Error('Discord login failed; check the token, channel access, and Gateway permissions');
    }
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
    await this.client.destroy();
    await this.drain();
  }

  async drain(): Promise<void> {
    await this.queue;
  }

  getStatus() {
    return { state: this.state, pending: this.pending, lastMessageAt: this.lastMessageAt,
      channelCount: this.channels.size };
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
      this.fail();
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
        const base = previous || await this.client.rest.get(Routes.channelMessage(raw.channel_id, raw.id));
        complete = { ...base, ...raw };
      }
      const message = normalizeDiscordMessage(complete, packet.t === 'MESSAGE_UPDATE' ? 'edit' : 'new');
      if (previous && this.fingerprint(previous) === this.fingerprint(complete)) return;
      await this.options.deliver(message);
      this.lastMessageAt = Date.now();
      this.cache.delete(key);
      this.cache.set(key, complete);
      if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
    }).catch(() => this.fail()).finally(() => { this.pending--; });
  }

  private fingerprint(raw: any): string {
    return JSON.stringify([raw.content || '', raw.attachments || [], raw.embeds || [], raw.message_reference || null]);
  }

  private fail(): void {
    this.state = 'failed';
    logger.error('Discord ingestion halted after delivery failure or queue overflow; reconcile messages before restarting');
    void this.client.destroy().catch(() => {});
  }
}

export function createDiscordGatewayFromConfig(deliver: (message: any) => Promise<void>): DiscordGatewayService | null {
  const userToken = (process.env.DISCORD_TOKEN || process.env.DISCORD_USER_TOKEN || '').trim();
  const botToken = (process.env.DISCORD_BOT_TOKEN || '').trim();
  const tokenMode = (process.env.DISCORD_TOKEN_MODE || (userToken ? 'user' : 'bot')).toLowerCase() as 'bot' | 'user';
  const token = tokenMode === 'user' ? userToken : botToken;
  const channelIds = (process.env.DISCORD_CHANNEL_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
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
  return new DiscordGatewayService({ token, tokenMode, channelIds, deliver });
}
