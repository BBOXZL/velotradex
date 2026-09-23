import { EventEmitter } from 'events';
import { DiscordGatewayService, normalizeDiscordMessage } from '../../src/services/DiscordGatewayService';

const original = {
  id: '100', channel_id: '200', content: 'LONG BTC',
  timestamp: '2026-09-23T12:00:00.000Z',
  author: { id: '300', username: 'trader' },
  attachments: [{ id: '400', filename: 'chart.png', content_type: 'image/png',
    url: 'https://cdn.discordapp.com/chart.png' }],
  message_reference: { message_id: '99' },
};

function setup() {
  const client = Object.assign(new EventEmitter(), {
    login: jest.fn().mockResolvedValue('token'),
    destroy: jest.fn().mockResolvedValue(undefined),
    rest: { get: jest.fn().mockResolvedValue(original) },
  });
  const deliver = jest.fn().mockResolvedValue(undefined);
  const service = new DiscordGatewayService({
    token: 'test-token', channelIds: ['200'], deliver,
    clientFactory: () => client as any,
  });
  return { client, deliver, service };
}

describe('Discord realtime ingestion', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  test('preserves attachment detection and reply linkage', () => {
    expect(normalizeDiscordMessage(original)).toMatchObject({
      id: '100', channel_id: '200', author_id: '300', username: 'trader',
      ts: Date.parse(original.timestamp), reply_to: '99',
      message_reference: { message_id: '99' },
      attachments: [expect.objectContaining({ is_image: true })],
    });
  });

  test('listens to live dispatches, merges partial edits and suppresses duplicates', async () => {
    const { client, deliver, service } = setup();
    await service.start();
    client.emit('raw', { t: 'MESSAGE_CREATE', d: original });
    client.emit('raw', { t: 'MESSAGE_CREATE', d: original });
    client.emit('raw', { t: 'MESSAGE_UPDATE', d: {
      id: '100', channel_id: '200', content: 'move SL to entry',
      edited_timestamp: '2026-09-23T12:01:00.000Z',
    } });
    await service.drain();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][0]).toMatchObject({
      content: 'move SL to entry', kind: 'edit', author_id: '300',
      attachments: [expect.objectContaining({ is_image: true })],
    });
    await service.stop();
  });

  test('fetches an uncached partial edit before analysis', async () => {
    const { client, deliver, service } = setup();
    await service.start();
    client.emit('raw', { t: 'MESSAGE_UPDATE', d: { id: '100', channel_id: '200', content: 'updated' } });
    await service.drain();
    expect(client.rest.get).toHaveBeenCalledWith('/channels/200/messages/100');
    expect(deliver.mock.calls[0][0]).toMatchObject({ content: 'updated', author_id: '300' });
    await service.stop();
  });

  test('does not turn deletions or events outside the allowlist into trades', async () => {
    const { client, deliver, service } = setup();
    await service.start();
    client.emit('raw', { t: 'MESSAGE_CREATE', d: { ...original, channel_id: '999' } });
    client.emit('raw', { t: 'MESSAGE_DELETE', d: original });
    await service.drain();
    expect(deliver).not.toHaveBeenCalled();
    await service.stop();
  });

  test('awaits opening processing before delivering a follow-up', async () => {
    const { client, deliver, service } = setup();
    let release!: () => void;
    deliver.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await service.start();
    client.emit('raw', { t: 'MESSAGE_CREATE', d: original });
    client.emit('raw', { t: 'MESSAGE_CREATE', d: { ...original, id: '101', content: 'close BTC' } });
    await new Promise(resolve => setImmediate(resolve));
    expect(deliver).toHaveBeenCalledTimes(1);
    release();
    await service.drain();
    expect(deliver).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  test('stops later delivery on processing failure without an unhandled rejection', async () => {
    const { client, deliver, service } = setup();
    deliver.mockRejectedValueOnce(new Error('downstream unavailable'));
    await service.start();
    client.emit('raw', { t: 'MESSAGE_CREATE', d: original });
    client.emit('raw', { t: 'MESSAGE_CREATE', d: { ...original, id: '101' } });
    await service.drain();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(service.getStatus().state).toBe('failed');
    await service.stop();
  });

  test('supports the D project personal-token environment convention', () => {
    process.env.DISCORD_TOKEN_MODE = 'user';
    process.env.DISCORD_TOKEN = 'personal-token';
    process.env.DISCORD_CHANNEL_IDS = '200';
    process.env.DISCORD_BOT_TOKEN = '';

    const serviceModule = require('../../src/services/DiscordGatewayService') as typeof import('../../src/services/DiscordGatewayService');
    const service = serviceModule.createDiscordGatewayFromConfig(jest.fn().mockResolvedValue(undefined));
    expect(service).not.toBeNull();
  });

  test('tests personal-token channel access through Discord REST after Gateway READY', async () => {
    const restGet = jest.fn().mockResolvedValue([]);
    const connection = {
      rest: { get: restGet },
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const service = new DiscordGatewayService({
      token: 'personal-token',
      tokenMode: 'user',
      channelIds: ['200', '201'],
      deliver: jest.fn().mockResolvedValue(undefined),
      userGatewayFactory: () => connection,
    });
    await service.start();
    await service.verifyChannelAccess();
    expect(restGet).toHaveBeenNthCalledWith(1, '/channels/200/messages?limit=1');
    expect(restGet).toHaveBeenNthCalledWith(2, '/channels/201/messages?limit=1');
    await service.stop();
  });
});
