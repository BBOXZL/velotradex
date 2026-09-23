import Router from 'koa-router';
import { DiscordConfig } from '../models';
import { checkAdmin } from '../middleware/checkAdmin';
import {
  getStoredDiscordConfig,
  normalizeDiscordConfigInput,
  serializeDiscordConfig,
} from '../services/DiscordConfigService';
import { discordGatewayManager } from '../services/DiscordGatewayManager';

const router = new Router();
router.use(checkAdmin);

router.get('/', async ctx => {
  const config = await getStoredDiscordConfig();
  ctx.body = serializeDiscordConfig(config, discordGatewayManager.getStatus());
});

router.put('/', async ctx => {
  try {
    const normalized = normalizeDiscordConfigInput(ctx.request.body);
    let config = await getStoredDiscordConfig();
    if (!config) {
      config = await DiscordConfig.create({
        tokenMode: normalized.tokenMode,
        token: normalized.token,
        channelIds: JSON.stringify(normalized.channelIds),
        enabled: normalized.enabled,
      });
    } else {
      config.tokenMode = normalized.tokenMode;
      if (normalized.token) config.token = normalized.token;
      config.channelIds = JSON.stringify(normalized.channelIds);
      config.enabled = normalized.enabled;
      await config.save();
    }
    await discordGatewayManager.reload();
    ctx.body = serializeDiscordConfig(config, discordGatewayManager.getStatus());
  } catch (error: any) {
    ctx.status = 400;
    ctx.body = { error: error?.message || 'Invalid Discord configuration' };
  }
});

router.post('/test', async ctx => {
  try {
    const normalized = normalizeDiscordConfigInput(ctx.request.body);
    if (!normalized.token) throw new Error('Enter a token before testing the connection');
    ctx.body = await discordGatewayManager.test({
      token: normalized.token,
      tokenMode: normalized.tokenMode,
      channelIds: normalized.channelIds,
    });
  } catch (error: any) {
    ctx.status = 400;
    ctx.body = { success: false, error: error?.message || 'Discord connection test failed' };
  }
});

router.get('/status', async ctx => {
  ctx.body = discordGatewayManager.getStatus();
});

export default router;
