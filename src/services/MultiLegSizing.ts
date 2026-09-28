import { ParsedStrategy, StrategyRiskConfig } from './parsers/types';

export type MultiLegSizing = 'split' | 'full';

/**
 * S4 多腿风险分摊（纯函数），默认 split 保持现状：
 * - 'split'（默认/未配置）：原样返回（解析器给的 weight=1/N 均分）；
 * - 'full'：多腿（entryCount>1）每腿 weight=1 全额风险预算。
 * 与 entrySelection 的先后关系：调用方必须先做 entrySelection 过滤
 * （nearest_sl 跳过非最近腿），再对剩余腿调本函数做分摊。
 */
export function applyMultiLegSizing(
    strategies: ParsedStrategy[],
    multiLegSizing: StrategyRiskConfig['multiLegSizing'],
): ParsedStrategy[] {
    if (multiLegSizing !== 'full') return strategies;
    return strategies.map((s) => {
        if (s.action !== 'open') return s;
        if (s.entryCount === undefined || s.entryCount <= 1) return s;
        if (s.weight === 1) return s;
        return { ...s, weight: 1 };
    });
}

/** riskConfig.multiLegSizing 归一化：缺省/非法一律回落 split（保持现状不惊动现有仓位）。 */
export function normalizeMultiLegSizing(value: unknown): MultiLegSizing {
    return value === 'full' ? 'full' : 'split';
}
