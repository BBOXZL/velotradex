import logger from '../utils/logger';
import DiscordConfig from '../models/DiscordConfig';
import {
  DiscordGatewayService,
  createDiscordGatewayFromConfig,
} from './DiscordGatewayService';
import { getStoredDiscordConfig } from './DiscordConfigService';

export class DiscordGatewayManager {
  private gateway: DiscordGatewayService | null = null;
  private deliver: ((message: any) => Promise<void>) | null = null;
  private lastError: string | null = null;

  async initialize(deliver: (message: any) => Promise<void>): Promise<void> {
    this.deliver = deliver;
    const stored = await getStoredDiscordConfig().catch(() => null);
    if (stored) await this.reload();
    else {
      const envGateway = createDiscordGatewayFromConfig(deliver);
      if (envGateway) {
        this.gateway = envGateway;
        await this.startCurrent();
      }
    }
  }

  async reload(): Promise<void> {
    if (!this.deliver) throw new Error('Discord gateway manager is not initialized');
    await this.gateway?.stop().catch(() => undefined);
    this.gateway = null;
    this.lastError = null;
    const config = await getStoredDiscordConfig();
    if (!config?.enabled) return;
    const token = config.token?.trim();
    const channelIds = JSON.parse(config.channelIds || '[]');
    if (!token) throw new Error('Discord token is required');
    this.gateway = new DiscordGatewayService({
      token,
      tokenMode: config.tokenMode,
      channelIds,
      deliver: this.deliver,
    });
    await this.startCurrent();
  }

  async startCurrent(): Promise<void> {
    if (!this.gateway) return;
    try {
      await this.gateway.start();
    } catch (error: any) {
      this.lastError = error?.message || 'Discord connection failed';
      logger.error('Discord gateway start failed', { error: this.lastError });
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.gateway?.stop();
    this.gateway = null;
  }

  async test(input: { token: string; tokenMode: 'bot' | 'user'; channelIds: string[] }) {
    if (!input.token) throw new Error('Discord token is required');
    const gateway = new DiscordGatewayService({ ...input, deliver: async () => undefined });
    try {
      await gateway.start();
      await gateway.verifyChannelAccess();
      return { success: true, status: gateway.getStatus() };
    } finally {
      await gateway.stop();
    }
  }

  getStatus() {
    return {
      ...(this.gateway?.getStatus() || {
        state: 'stopped',
        pending: 0,
        lastMessageAt: null,
        channelCount: 0,
      }),
      error: this.lastError,
      tokenMode: this.gateway?.getTokenMode() || null,
    };
  }
}

export const discordGatewayManager = new DiscordGatewayManager();
