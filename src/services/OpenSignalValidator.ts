import { ParsedStrategy, StrategyRiskConfig } from './parsers/types';
import { parseFinitePositiveNumber, isCmpEntryPrice, formatExecutionNumber } from './TradeMath';
import logger from '../utils/logger';
import signalAlertService from './SignalAlertService';

const DISPLAY_PRICE_SCALE_FACTORS = [100, 1000, 10000, 1000000];

// S5: 单字段错位判定阈值(默认50倍)。只有 value/currentPrice 偏离超阈值
// (且命中 factors 的 0.2 偏差带) 的字段才归一化, 正常字段保持原值。
export const DISPLAY_PRICE_SCALE_DEVIATION_THRESHOLD = 50;

export function detectDisplayPriceScaleFactor(entryPrice: number, currentPrice: number, deviationThreshold: number = DISPLAY_PRICE_SCALE_DEVIATION_THRESHOLD): number | null {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
        return null;
    }
    const ratio = entryPrice / currentPrice;
    // 阈值门: 偏离不足阈值倍数视为正常价格, 不归一化
    if (ratio < deviationThreshold) return null;
    for (const factor of DISPLAY_PRICE_SCALE_FACTORS) {
        const deviation = Math.abs(ratio - factor) / factor;
        if (deviation <= 0.2) {
            return factor;
        }
    }
    return null;
}

export function normalizeDisplayPrice(value: any, scaleFactor: number): string | undefined {
    const price = parseFinitePositiveNumber(value);
    if (price === null) return undefined;
    return formatExecutionNumber(price / scaleFactor);
}

export function normalizeDisplayPriceScale(params: {
    parsed: ParsedStrategy;
    signal: {
        entryPrice: number;
        stopLoss: number;
    };
    currentPrice: number;
}): { parsed: ParsedStrategy; scaleFactor: number; normalizedFields: string[] } | null {
    if (!Number.isFinite(params.currentPrice) || params.currentPrice <= 0) return null;

    // S5 逐字段化: 对 entry / SL / 每个 TP 分别算 value/currentPrice,
    // 仅偏离超阈值(默认50倍, factors 覆盖 100/1000/10000/1000000,
    // 0.2 偏差逻辑保留在 detectDisplayPriceScaleFactor 内)的字段归一化。
    const entryNum = parseFinitePositiveNumber(params.parsed.entryPrice);
    const slNum = parseFinitePositiveNumber(params.parsed.stopLoss);
    if (entryNum === null) return null;

    const entryFactor = detectDisplayPriceScaleFactor(entryNum, params.currentPrice);
    // entry 无错位 -> 整单不归一化(保持旧行为: 无错位返回 null)
    if (!entryFactor) return null;

    const normalizedEntryPrice = normalizeDisplayPrice(params.parsed.entryPrice, entryFactor);
    if (!normalizedEntryPrice) return null;

    let normalizedStopLoss = params.parsed.stopLoss;
    if (slNum !== null) {
        const slFactor = detectDisplayPriceScaleFactor(slNum, params.currentPrice);
        if (slFactor) {
            const v = normalizeDisplayPrice(params.parsed.stopLoss, slFactor);
            if (v) normalizedStopLoss = v;
        }
    }

    const normalizedTargets = Array.isArray(params.parsed.targets)
        ? params.parsed.targets.map((target) => {
            const tpNum = parseFinitePositiveNumber(target);
            if (tpNum === null) return target;
            const tpFactor = detectDisplayPriceScaleFactor(tpNum, params.currentPrice);
            if (!tpFactor) return target;
            return normalizeDisplayPrice(target, tpFactor) || target;
        })
        : params.parsed.targets;

    const normalizedAverageEntryPrice =
        typeof params.parsed.averageEntryPrice === 'number' && Number.isFinite(params.parsed.averageEntryPrice) && params.parsed.averageEntryPrice > 0
            ? (() => {
                const avgFactor = detectDisplayPriceScaleFactor(params.parsed.averageEntryPrice as number, params.currentPrice);
                return avgFactor ? (params.parsed.averageEntryPrice as number) / avgFactor : params.parsed.averageEntryPrice;
            })()
            : params.parsed.averageEntryPrice;

    const normalizedFields: string[] = ['entryPrice'];
    if (normalizedStopLoss !== params.parsed.stopLoss) normalizedFields.push('stopLoss');
    if (JSON.stringify(normalizedTargets) !== JSON.stringify(params.parsed.targets)) normalizedFields.push('targets');
    if (normalizedAverageEntryPrice !== params.parsed.averageEntryPrice) normalizedFields.push('averageEntryPrice');

    // 归一化后 sanity 检查: 多头 SL<entry<TP, 空头 SL>entry>TP。
    // 不满足 -> 拒绝归一化(返回 null), 由调用方打 warn + STRATEGY_PRICE_SCALE_REJECTED,
    // 按原值走后续校验(不静默造单)。
    const candidateEntry = parseFinitePositiveNumber(normalizedEntryPrice);
    const candidateSl = parseFinitePositiveNumber(normalizedStopLoss);
    const candidateTps = Array.isArray(normalizedTargets)
        ? normalizedTargets.map((t) => parseFinitePositiveNumber(t)).filter((t): t is number => t !== null)
        : [];
    const side = params.parsed.side;
    if (candidateEntry !== null && candidateSl !== null && (side === 'buy' || side === 'sell')) {
        const isLong = side === 'buy';
        const slOk = isLong ? candidateSl < candidateEntry : candidateSl > candidateEntry;
        const tpOk = candidateTps.length === 0 || candidateTps.every((tp) => isLong ? candidateEntry < tp : candidateEntry > tp);
        if (!slOk || !tpOk) {
            logger.warn('TradeExecutor: display price scale sanity check failed, rejecting normalization', {
                symbol: params.parsed.symbol,
                side,
                entryPrice: normalizedEntryPrice,
                stopLoss: normalizedStopLoss,
                targets: normalizedTargets,
            });
            return null;
        }
    }

    return {
        scaleFactor: entryFactor,
        normalizedFields,
        parsed: {
            ...params.parsed,
            entryPrice: normalizedEntryPrice,
            stopLoss: normalizedStopLoss,
            targets: normalizedTargets,
            averageEntryPrice: normalizedAverageEntryPrice,
        },
    };
}

export function computeNeilHardStopFromSoftStop(
    side: 'buy' | 'sell',
    entryPrice: number,
    softStop: number,
    multiplier: number
): number | null {
    const r = side === 'buy' ? entryPrice - softStop : softStop - entryPrice;
    if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(multiplier) || multiplier <= 0) return null;
    return side === 'buy' ? entryPrice - multiplier * r : entryPrice + multiplier * r;
}

export function computeFallbackTargetFromHardStop(
    side: 'buy' | 'sell',
    entryPrice: number,
    hardStop: number,
    rMultiple: number
): string {
    const r = Math.abs(entryPrice - hardStop);
    const target = side === 'buy' ? entryPrice + r * rMultiple : entryPrice - r * rMultiple;
    return formatExecutionNumber(target);
}

export function buildCmpResolvedOpenStrategy(parsed: ParsedStrategy, currentPrice: number): ParsedStrategy | null {
    if (!isCmpEntryPrice(parsed.entryPrice)) return parsed;
    if (parsed.side !== 'buy' && parsed.side !== 'sell') return null;

    const hasNeil = !!(parsed.raw as any)?.neil;

    if (hasNeil) {
        const softStop = parseFinitePositiveNumber((parsed.raw as any)?.neil?.softStop?.price ?? parsed.stopLoss);
        if (softStop === null) return null;

        const multiplier = parseFinitePositiveNumber((parsed.raw as any)?.neil?.hardStopRMultiplier) || 2;
        const hardStop = computeNeilHardStopFromSoftStop(parsed.side, currentPrice, softStop, multiplier);
        if (hardStop === null) return null;

        const neilRaw = {
            ...((parsed.raw as any)?.neil || {}),
            cmpEntry: true,
            cmpResolvedEntryPrice: currentPrice,
            hardStopLoss: Number(formatExecutionNumber(hardStop)),
        };
        const fallbackFullTp = (parsed.raw as any)?.neil?.fallbackFullTp;
        const targets = parsed.targets && parsed.targets.length > 0
            ? parsed.targets
            : fallbackFullTp?.enabled
                ? [computeFallbackTargetFromHardStop(parsed.side, currentPrice, hardStop, fallbackFullTp.rMultiple || 1.1)]
                : parsed.targets;

        return {
            ...parsed,
            entryPrice: formatExecutionNumber(currentPrice),
            stopLoss: formatExecutionNumber(hardStop),
            targets,
            orderType: 'market',
            raw: {
                ...(parsed.raw || {}),
                neil: {
                    ...neilRaw,
                    ...(targets && targets.length > 0 && fallbackFullTp?.enabled
                        ? { fallbackFullTp: { ...fallbackFullTp, resolvedTarget: targets[0] } }
                        : {}),
                },
            },
        };
    }

    return {
        ...parsed,
        entryPrice: formatExecutionNumber(currentPrice),
        orderType: 'market',
    };
}

export async function rejectOpenStrategy(
    auditService: any,
    strategyId: number | undefined,
    exchangeInstanceId: string | undefined,
    details: {
        symbol: any;
        side: any;
        entryPrice: any;
        stopLoss: any;
        currentPrice: any;
        field: string;
        reason: string;
    }
): Promise<never> {
    if (strategyId) {
        await auditService.log(
            strategyId,
            'STRATEGY_REJECTED',
            details,
            undefined,
            undefined,
            exchangeInstanceId
        );
    }
    // S8: 拦截可观测 —— 除日志 + 审计外再写告警落库（面板红点）。
    await signalAlertService.raise({
        strategyId: strategyId ?? null,
        kind: 'STRATEGY_REJECTED',
        symbol: details?.symbol != null ? String(details.symbol) : null,
        exchangeInstanceId: exchangeInstanceId ?? null,
        reason: details?.reason ?? null,
    });
    logger.warn('TradeExecutor: open strategy rejected', {
        field: details.field,
        reason: details.reason,
        symbol: details.symbol,
        side: details.side,
    });
    throw new Error(details.reason);
}

export async function validateOpenSignal(
    auditService: any,
    signal: {
        symbol: string;
        side: 'buy' | 'sell';
        entryPrice: number;
        stopLoss: number;
        isLong: boolean;
    },
    ticker: any,
    markets: any[],
    strategyId?: number,
    exchangeInstanceId?: string,
    riskConfig?: StrategyRiskConfig
): Promise<{
    marketInfo: any;
    currentPrice: number;
}> {
    const { symbol, side, entryPrice, stopLoss, isLong } = signal;
    const currentPrice = parseFinitePositiveNumber(ticker?.lastPrice);

    const marketInfo = markets.find(m => m.symbol === symbol);
    if (!marketInfo) {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice,
            stopLoss,
            currentPrice,
            field: 'symbol',
            reason: `Unsupported open strategy symbol: ${symbol}`,
        });
        throw new Error('Unreachable');
    }

    if (currentPrice === null) {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice,
            stopLoss,
            currentPrice,
            field: 'currentPrice',
            reason: 'Invalid open strategy currentPrice',
        });
        throw new Error('Unreachable');
    }

    if (riskConfig?.riskMode !== 'ratio_based') {
        if (isLong) {
            if (!(stopLoss < currentPrice)) {
                await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
                    symbol,
                    side,
                    entryPrice,
                    stopLoss,
                    currentPrice,
                    field: 'stopLoss',
                    reason: `Invalid Long Strategy: SL (${stopLoss}) >= Current Price (${currentPrice}). Rejecting to avoid immediate trigger.`,
                });
            }
        } else {
            if (!(stopLoss > currentPrice)) {
                await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
                    symbol,
                    side,
                    entryPrice,
                    stopLoss,
                    currentPrice,
                    field: 'stopLoss',
                    reason: `Invalid Short Strategy: SL (${stopLoss}) <= Current Price (${currentPrice}). Rejecting to avoid immediate trigger.`,
                });
            }
        }
    }

    return {
        marketInfo,
        currentPrice: currentPrice,
    };
}

export async function validateStaticOpenSignal(
    auditService: any,
    parsed: ParsedStrategy,
    strategyId?: number,
    exchangeInstanceId?: string,
    riskConfig?: StrategyRiskConfig
): Promise<{
    symbol: string;
    side: 'buy' | 'sell';
    entryPrice: number;
    stopLoss: number;
    isLong: boolean;
    R: number;
}> {
    const symbol = typeof parsed.symbol === 'string' ? parsed.symbol.trim() : '';
    const side = parsed.side;
    const entryPrice = parseFinitePositiveNumber(parsed.entryPrice);
    const stopLoss = parseFinitePositiveNumber(parsed.stopLoss);

    if (!symbol) {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice: parsed.entryPrice,
            stopLoss: parsed.stopLoss,
            currentPrice: null,
            field: 'symbol',
            reason: 'Invalid open strategy symbol',
        });
    }

    if (side !== 'buy' && side !== 'sell') {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice: parsed.entryPrice,
            stopLoss: parsed.stopLoss,
            currentPrice: null,
            field: 'side',
            reason: 'Invalid open strategy side',
        });
    }

    if (entryPrice === null) {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice: parsed.entryPrice,
            stopLoss: parsed.stopLoss,
            currentPrice: null,
            field: 'entryPrice',
            reason: 'Invalid open strategy entryPrice',
        });
    }

    if (stopLoss === null && riskConfig?.riskMode !== 'ratio_based') {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice: parsed.entryPrice,
            stopLoss: parsed.stopLoss,
            currentPrice: null,
            field: 'stopLoss',
            reason: 'Invalid open strategy stopLoss',
        });
    }

    const safeSide = side as 'buy' | 'sell';
    const safeEntryPrice = entryPrice as number;
    const safeStopLoss = stopLoss ?? 0;
    const R = Math.abs(safeEntryPrice - safeStopLoss);
    if (!Number.isFinite(R) || R <= 0) {
        if (riskConfig?.riskMode === 'ratio_based') {
            // In ratio_based mode, stopLoss may be null/0 — skip R validation
        } else {
            await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
                symbol,
                side: safeSide,
                entryPrice: parsed.entryPrice,
                stopLoss: parsed.stopLoss,
                currentPrice: null,
                field: 'R',
                reason: 'Invalid open strategy R',
            });
        }
    }

    return {
        symbol,
        side: safeSide,
        entryPrice: safeEntryPrice,
        stopLoss: safeStopLoss,
        isLong: safeSide === 'buy',
        R,
    };
}
