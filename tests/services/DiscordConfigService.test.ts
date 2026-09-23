import {
  maskDiscordToken,
  normalizeDiscordConfigInput,
} from '../../src/services/DiscordConfigService';

describe('DiscordConfigService helpers', () => {
  it('normalizes a valid dashboard payload and preserves a masked-token sentinel', () => {
    expect(normalizeDiscordConfigInput({
      tokenMode: 'user',
      token: 'keep-existing',
      channelIds: ['123', '456', '123'],
      enabled: true,
    })).toEqual({
      tokenMode: 'user',
      token: undefined,
      channelIds: ['123', '456'],
      enabled: true,
    });
  });

  it('rejects non-numeric channel ids', () => {
    expect(() => normalizeDiscordConfigInput({
      tokenMode: 'bot',
      token: 'abc',
      channelIds: ['123', 'not-a-channel'],
      enabled: true,
    })).toThrow('channelIds must contain numeric Discord channel IDs');
  });

  it('masks tokens without exposing the secret', () => {
    expect(maskDiscordToken('super-secret-token')).toBe('****oken');
    expect(maskDiscordToken('123')).toBe('****');
    expect(maskDiscordToken('')).toBe('');
  });
});
