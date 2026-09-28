import Router from 'koa-router';
import { Op } from 'sequelize';
import { AIConfig, AILog, AuditLog, Order, Strategy } from '../models';
import aiParserService from '../services/AIParserService';
import logger, { formatError } from '../utils/logger';
import { checkAdmin } from '../middleware/checkAdmin';

const router = new Router();

function normalizeExtraPayloadInput(input: unknown): string | null {
    if (input === undefined || input === null) {
        return null;
    }

    const raw = typeof input === 'string' ? input.trim() : JSON.stringify(input);
    if (!raw) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('extraPayload must be valid JSON');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('extraPayload must be a JSON object');
    }

    return JSON.stringify(parsed);
}

function normalizeRequestTimeoutMs(input: unknown): number {
    if (input === undefined || input === null || input === '') {
        return 60000;
    }

    const value = Number(input);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error('requestTimeoutMs must be a positive number');
    }

    return Math.floor(value);
}

type QueryValue = string | string[] | undefined;

const asString = (value: QueryValue): string | undefined => {
    if (Array.isArray(value)) return value[0];
    return value;
};

const buildRouteIdFilter = (routeId: string) => {
    return {
        [Op.or]: [
            { routeIds: JSON.stringify([Number(routeId)]) },
            { routeIds: { [Op.like]: `[${routeId},%` } },
            { routeIds: { [Op.like]: `%,${routeId},%` } },
            { routeIds: { [Op.like]: `%,${routeId}]` } },
        ],
    };
};

export const listAILogs = async (query: Record<string, QueryValue>) => {
    const page = Number(asString(query.page) || 1);
    const limit = Number(asString(query.limit) || 20);
    const offset = (page - 1) * limit;
    const where: any = {};
    const strategyId = asString(query.strategyId);
    const routeId = asString(query.routeId);
    // S8 信号收件箱：action=ignored 只看 AI 判 ignore 的行（response LIKE %ignore%）。
    // 不动 strategies 状态机；reasoning 由前端从 response 提取展示。
    const action = asString(query.action);

    if (strategyId) {
        where.strategyId = strategyId;
    }

    if (routeId) {
        Object.assign(where, buildRouteIdFilter(routeId));
    }

    if (action === 'ignored') {
        where.response = { [Op.like]: '%"action":"ignore"%' };
    }

    const { count, rows } = await AILog.findAndCountAll({
        where,
        limit,
        offset,
        order: [['createdAt', 'DESC']],
        attributes: { exclude: ['imageBase64', 'systemPrompt'] }
    });

    return {
        total: count,
        page,
        limit,
        logs: rows
    };
};

// GET /api/ai-config
router.get('/', async (ctx) => {
    const config = await AIConfig.findOne({ where: { isActive: true } });
    if (!config) {
        ctx.body = null;
    } else {
        const configJson: any = config.toJSON();
        if (configJson.apiKey && configJson.apiKey.length > 4) {
            configJson.apiKey = '****' + configJson.apiKey.slice(-4);
        } else if (configJson.apiKey) {
            configJson.apiKey = '****';
        }
        ctx.body = configJson;
    }
});

// POST /api/ai-config
router.post('/', async (ctx) => {
    const { provider, apiKey, baseUrl, textModel, visionModel, stripChinese, extraPayload, requestTimeoutMs, promptTemplate, mode, contextMessageCount } = ctx.request.body as any;
    
    // Validate inputs
    if (!provider || !apiKey || (!textModel && !visionModel)) {
        ctx.status = 400;
        ctx.body = { error: 'Missing required fields' };
        return;
    }

    try {
        // Deactivate old configs
        await AIConfig.update({ isActive: false }, { where: { isActive: true } });

        const config = await AIConfig.create({
            provider,
            apiKey,
            baseUrl,
            textModel,
            visionModel,
            stripChinese,
            extraPayload: normalizeExtraPayloadInput(extraPayload),
            requestTimeoutMs: normalizeRequestTimeoutMs(requestTimeoutMs),
            promptTemplate,
            mode,
            contextMessageCount,
            isActive: true
        });

        // Reload service
        await aiParserService.reloadConfig();
        
        ctx.body = config;
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

// PUT /api/ai-config/:id
router.put('/:id', async (ctx) => {
    const { id } = ctx.params;
    const { provider, apiKey, baseUrl, textModel, visionModel, stripChinese, extraPayload, requestTimeoutMs, promptTemplate, mode, contextMessageCount } = ctx.request.body as any;

    const config = await AIConfig.findByPk(id);
    if (!config) {
        ctx.status = 404;
        ctx.body = { error: 'Config not found' };
        return;
    }

    try {
        if (provider) config.provider = provider;
        if (apiKey) config.apiKey = apiKey;
        if (baseUrl !== undefined) config.baseUrl = baseUrl;
        if (textModel) config.textModel = textModel;
        if (visionModel) config.visionModel = visionModel;
        if (stripChinese !== undefined) config.stripChinese = stripChinese;
        if (extraPayload !== undefined) config.extraPayload = normalizeExtraPayloadInput(extraPayload);
        if (requestTimeoutMs !== undefined) config.requestTimeoutMs = normalizeRequestTimeoutMs(requestTimeoutMs);
        if (promptTemplate) config.promptTemplate = promptTemplate;
        if (mode) config.mode = mode;
        if (contextMessageCount !== undefined) config.contextMessageCount = contextMessageCount;

        await config.save();
        
        // Reload service
        await aiParserService.reloadConfig();

        ctx.body = config;
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

// POST /api/ai-config/test
router.post('/test', async (ctx) => {
    const config = ctx.request.body;
    try {
        const result = await aiParserService.testConfig(config);
        ctx.body = result;
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, message: e.message };
    }
});

// GET /api/ai-config/models
// Change to POST to support passing credentials in body
router.post('/models', async (ctx) => {
    try {
        const { apiKey, baseUrl, requestTimeoutMs } = ctx.request.body as any;
        const models = await aiParserService.getModels({ apiKey, baseUrl, requestTimeoutMs });
        ctx.body = models;
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

// GET /api/ai-config/logs
router.get('/logs', async (ctx) => {
    try {
        ctx.body = await listAILogs(ctx.query as Record<string, QueryValue>);
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

// GET /api/ai-config/logs/:id
router.get('/logs/:id', async (ctx) => {
    try {
        const log = await AILog.findByPk(ctx.params.id);
        if (!log) {
            ctx.status = 404;
            ctx.body = { error: 'Log not found' };
            return;
        }
        ctx.body = log;
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e.message };
    }
});

// S7: Retry 补单显式化 + 双 guard（幂等 + RETRY_TRIGGERED_ORDER 审计）。
// 幂等（G3：不依赖 60 秒内容哈希，用 messageId 长效去重语义）按三层判定：
// ① 该 aiLog 已有成功的 RETRY_TRIGGERED_ORDER 审计（二次点击同一日志）；
// ② 该 messageId 已有 processed 策略（S6 延迟队列/正常链路已执行）；
// ③ 该 strategyId 已有关联订单（非 FAILED）。
// 审计一律写 RETRY_TRIGGERED_ORDER（含成功/失败原因），不再只放 HTTP response。
function extractRetryMessageId(strategy: { rawMessage?: unknown }): string | null {
    try {
        const raw = typeof strategy.rawMessage === 'string'
            ? JSON.parse(strategy.rawMessage)
            : strategy.rawMessage;
        const id = (raw as any)?.id;
        return id !== undefined && id !== null && String(id).trim() ? String(id) : null;
    } catch {
        return null;
    }
}

async function writeRetryTriggeredOrderAudit(params: {
    strategyId: number | null;
    aiLogId: number;
    routeId?: number | null;
    symbol?: string | null;
    side?: string | null;
    success: boolean;
    reason?: string;
    error?: string;
    orderResult?: unknown;
}): Promise<void> {
    try {
        await AuditLog.create({
            strategyId: params.strategyId ?? 0,
            action: 'RETRY_TRIGGERED_ORDER',
            routeId: params.routeId ?? null,
            details: JSON.stringify({
                aiLogId: params.aiLogId,
                strategyId: params.strategyId,
                routeId: params.routeId ?? null,
                symbol: params.symbol ?? null,
                side: params.side ?? null,
                success: params.success,
                ...(params.reason ? { reason: params.reason } : {}),
                ...(params.error ? { error: params.error } : {}),
                ...(params.orderResult !== undefined ? { orderResult: params.orderResult } : {}),
            }),
        });
    } catch (error: any) {
        logger.warn('Failed to write RETRY_TRIGGERED_ORDER audit', formatError(error, {
            aiLogId: params.aiLogId,
            strategyId: params.strategyId,
        }));
    }
}

function parseRetryAuditDetails(row: { details?: unknown }): Record<string, any> | null {
    try {
        if (typeof row.details !== 'string' || !row.details) return null;
        const parsed = JSON.parse(row.details);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

async function findSuccessfulRetryAudit(aiLogId: number): Promise<Record<string, any> | null> {
    let rows: any[] = [];
    try {
        rows = await AuditLog.findAll({
            where: { action: 'RETRY_TRIGGERED_ORDER' },
            order: [['createdAt', 'DESC']],
            limit: 50,
        });
    } catch {
        return null;
    }
    for (const row of rows) {
        const details = parseRetryAuditDetails(row);
        if (details && Number(details.aiLogId) === Number(aiLogId) && details.success === true) {
            return row;
        }
    }
    return null;
}

// POST /api/ai-config/logs/:id/retry
router.post('/logs/:id/retry', checkAdmin, async (ctx) => {
    try {
        const log = await AILog.findByPk(ctx.params.id);
        if (!log) {
            ctx.status = 404;
            ctx.body = { error: 'Log not found' };
            return;
        }

        const retried = await aiParserService.retryLogAnalysis(log);
        if (!retried) {
            ctx.status = 503;
            ctx.body = { error: 'AI parser is not configured' };
            return;
        }
        if (!retried.logId) {
            ctx.status = 500;
            ctx.body = { error: 'Retry log persistence failed' };
            return;
        }

        const retriedLog = await AILog.findByPk(retried.logId);

        const response: any = {
            success: true,
            logId: retried.logId,
            warning: log.systemPrompt ? undefined : 'This log was created before systemPrompt persistence. The retry used the saved user prompt only.',
            result: {
                content: retried.content,
                usage: retried.usage,
            },
            log: retriedLog,
        };

        // --- triggerOrder: optionally execute full order flow after successful re-parse ---
        const { triggerOrder } = (ctx.request.body as any) || {};
        if (triggerOrder === true) {
            const strategyParserRegistry = require('../services/parsers').default;
            const { applyAIResultToParsedStrategy, normalizeRouteSymbol } = require('../services/RouteParsedStrategy');
            const parserConfigService = require('../services/ParserConfigService').default;
            const tradeExecutor = require('../services/TradeExecutor').default;
            const { SignalRoute } = require('../models');

            // Check strategyId on log
            if (!log.strategyId) {
                response.warning = 'Cannot trigger order: log has no associated strategyId';
                ctx.body = response;
                return;
            }

            // Find Strategy
            const strategy = await Strategy.findByPk(log.strategyId);
            if (!strategy) {
                response.warning = 'Cannot trigger order: Strategy not found';
                ctx.body = response;
                return;
            }

            // S7 guard ①-a: 该 aiLog 已有成功的 RETRY_TRIGGERED_ORDER 审计（二次点击）。
            const priorRetry = await findSuccessfulRetryAudit(log.id);
            if (priorRetry) {
                response.success = false;
                response.warning = 'Duplicate retry order rejected: this log already triggered an order (RETRY_TRIGGERED_ORDER 已存在)';
                response.duplicate = { auditId: (priorRetry as any).id };
                ctx.body = response;
                return;
            }

            // S7 guard ①-b: 该 messageId 已有 processed 策略（S6 延迟队列/正常链路已执行）。
            const retryMessageId = extractRetryMessageId(strategy);
            if (retryMessageId) {
                let executedStrategy: any = null;
                try {
                    executedStrategy = await Strategy.findOne({
                        where: {
                            rawMessage: { [Op.like]: `%${retryMessageId}%` },
                            status: 'processed',
                        },
                    });
                } catch {
                    executedStrategy = null;
                }
                if (executedStrategy && Number((executedStrategy as any).id) !== Number(strategy.id)) {
                    response.success = false;
                    response.warning = `Duplicate retry order rejected: message ${retryMessageId} already executed as strategy ${(executedStrategy as any).id}`;
                    response.duplicate = { strategyId: (executedStrategy as any).id, messageId: retryMessageId };
                    ctx.body = response;
                    return;
                }
            }

            // S7 guard ①-c: 该 strategy 已有关联订单（非 FAILED；FAILED 可重补）。
            let existingOrders: any[] = [];
            try {
                existingOrders = await Order.findAll({ where: { strategyId: strategy.id } });
            } catch {
                existingOrders = [];
            }
            const activeOrder = existingOrders.find((o: any) =>
                String((o as any).lifecycleStatus || '').toUpperCase() !== 'FAILED' &&
                String((o as any).status || '').toLowerCase() !== 'failed');
            if (activeOrder) {
                response.success = false;
                response.warning = `Duplicate retry order rejected: strategy ${strategy.id} already has order ${(activeOrder as any).id}`;
                response.duplicate = { orderId: (activeOrder as any).id, strategyId: strategy.id };
                ctx.body = response;
                return;
            }

            // Parse AI result from re-parsed content
            let aiResult: any = null;
            try {
                const rawContent = typeof retried.content === 'string' ? retried.content : (retried.content != null ? JSON.stringify(retried.content) : '');
                if (!rawContent) {
                    response.warning = 'Cannot trigger order: AI returned empty content, unable to parse';
                    ctx.body = response;
                    return;
                }
                const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
                aiResult = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(rawContent);
                if (!aiResult || typeof aiResult !== 'object') {
                    response.warning = 'Cannot trigger order: AI result is not a valid JSON object';
                    ctx.body = response;
                    return;
                }
            } catch {
                response.warning = 'Cannot trigger order: failed to parse AI result JSON';
                ctx.body = response;
                return;
            }

            // Check action=ignore
            if (aiResult.action === 'ignore') {
                response.warning = 'Cannot trigger order: AI marked signal as ignore';
                ctx.body = response;
                return;
            }

            // Check confidence < 0.5
            const confidence = Number(aiResult.confidence);
            if (Number.isFinite(confidence) && confidence < 0.5) {
                response.warning = `Cannot trigger order: AI confidence too low (${confidence.toFixed(2)} < 0.50)`;
                ctx.body = response;
                return;
            }

            // Find SignalRoute from log.routeIds
            let routeId: number | undefined;
            try {
                const parsed = JSON.parse(log.routeIds || '[]');
                if (Array.isArray(parsed) && parsed.length > 0) {
                    routeId = parsed[0];
                }
            } catch {}

            if (!routeId) {
                response.warning = 'Cannot trigger order: log has no routeId';
                ctx.body = response;
                return;
            }

            const route = await SignalRoute.findByPk(routeId);
            if (!route || !route.isActive) {
                response.warning = 'Cannot trigger order: route not found or disabled';
                ctx.body = response;
                return;
            }

            // Update Strategy.aiAnalysis
            strategy.aiAnalysis = JSON.stringify(aiResult);
            await strategy.save();

            // Rebuild ParsedStrategy
            const parserName = strategy.parserName || 'DefaultParser';
            const parser = strategyParserRegistry.getParserByName(parserName);
            if (!parser) {
                response.warning = `Cannot trigger order: parser "${parserName}" not found`;
                ctx.body = response;
                return;
            }

            let rawMessage: any = strategy.rawMessage;
            try { rawMessage = JSON.parse(rawMessage); } catch {}
            const parsedStrategies = await parser.parse(rawMessage);
            if (!parsedStrategies || parsedStrategies.length === 0) {
                response.warning = 'Cannot trigger order: parser returned no strategies';
                ctx.body = response;
                return;
            }

            let routeParsed = applyAIResultToParsedStrategy(parsedStrategies[0], aiResult);
            routeParsed.symbol = normalizeRouteSymbol(routeParsed.symbol);

            // Get riskConfig
            let defaultConfig = parser.getRiskConfig();
            let riskConfig = await parserConfigService.getEffectiveConfig(parser.name, defaultConfig);

            // Route risk override
            if (route.riskSettings) {
                try {
                    const routeRisk = JSON.parse(route.riskSettings);
                    if (routeRisk.positionSizingMode === 'ratio_based') {
                        routeRisk.riskMode = 'ratio_based';
                        if (!routeRisk.riskValue || routeRisk.riskValue === 10) {
                            routeRisk.riskValue = 1;
                        }
                        delete routeRisk.positionSizingMode;
                    }
                    riskConfig = { ...riskConfig, ...routeRisk };
                } catch {}
            }

            // Symbol specific override
            if (route.symbolSpecificSettings) {
                try {
                    const specificSettings = JSON.parse(route.symbolSpecificSettings);
                    const symbolConfig = specificSettings[routeParsed.symbol];
                    if (symbolConfig && symbolConfig.riskValue !== undefined && symbolConfig.riskValue !== '') {
                        const val = Number(symbolConfig.riskValue);
                        if (!isNaN(val)) {
                            riskConfig = { ...riskConfig, riskValue: val };
                        }
                    }
                } catch {}
            }

            // Execute trade
            let orderResult: any;
            try {
                orderResult = await tradeExecutor.execute(
                    routeParsed,
                    riskConfig,
                    strategy.source,
                    strategy.id,
                    route.exchangeInstanceId,
                    route.id
                );
            } catch (execErr: any) {
                const reason = `execution_failed: ${execErr.message}`;
                await writeRetryTriggeredOrderAudit({
                    strategyId: strategy.id,
                    aiLogId: log.id,
                    routeId: route.id,
                    symbol: routeParsed.symbol,
                    side: routeParsed.side,
                    success: false,
                    reason,
                    error: String(execErr.message || execErr),
                });
                response.warning = `Cannot trigger order: trade execution failed - ${execErr.message}`;
                ctx.body = response;
                return;
            }

            // S7 guard ②: 成功同样落审计（不再只放 HTTP response）。
            await writeRetryTriggeredOrderAudit({
                strategyId: strategy.id,
                aiLogId: log.id,
                routeId: route.id,
                symbol: routeParsed.symbol,
                side: routeParsed.side,
                success: true,
                reason: 'retry_order_executed',
                orderResult,
            });
            response.orderResult = orderResult;
        }

        ctx.body = response;
    } catch (e: any) {
        ctx.status = 400;
        ctx.body = { error: e.message };
    }
});

export default router;
