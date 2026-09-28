import { DiscordConfig } from '../models';

export interface NormalizedDiscordConfig {
  tokenMode: 'bot' | 'user';
  token?: string;
  channelIds: string[];
  enabled: boolean;
}

export function maskDiscordToken(token: string | null | undefined): string {
  if (!token) return '';
  return token.length > 4 ? `****${token.slice(-4)}` : '****';
}

export function normalizeDiscordConfigInput(input: any): NormalizedDiscordConfig {
  const tokenMode = String(input?.tokenMode || 'bot').toLowerCase();
  if (tokenMode !== 'bot' && tokenMode !== 'user') {
    throw new Error('tokenMode must be bot or user');
  }

  const channelIds: string[] = Array.from(new Set<string>(
    (Array.isArray(input?.channelIds) ? input.channelIds : String(input?.channelIds || '').split(','))
      .map((value: unknown) => String(value).trim())
      .filter(Boolean),
  ));
  if (!channelIds.length || channelIds.some(id => !/^\d+$/.test(id))) {
    throw new Error('channelIds must contain numeric Discord channel IDs');
  }

  const token = typeof input?.token === 'string' ? input.token.trim() : '';
  if (input?.enabled !== false && !token && input?.token !== 'keep-existing') {
    throw new Error('Discord token is required when the receiver is enabled');
  }
  return {
    tokenMode,
    token: token && token !== 'keep-existing' ? token : undefined,
    channelIds,
    enabled: input?.enabled !== false,
  };
}

export function serializeDiscordConfig(config: DiscordConfig | null, status?: any) {
  let channelIds: string[] = [];
  if (config?.channelIds) {
    try { channelIds = JSON.parse(config.channelIds); } catch { channelIds = []; }
  }
  return {
    id: config?.id ?? null,
    tokenMode: config?.tokenMode ?? 'bot',
    hasToken: Boolean(config?.token),
    tokenMasked: maskDiscordToken(config?.token),
    channelIds,
    enabled: config?.enabled ?? false,
    updatedAt: config?.updatedAt ?? null,
    status: status ?? { state: 'stopped', pending: 0, lastMessageAt: null, channelCount: channelIds.length },
  };
}

export async function getStoredDiscordConfig(): Promise<DiscordConfig | null> {
  return DiscordConfig.findOne({ order: [['id', 'ASC']] });
}
