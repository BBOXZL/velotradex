import logger, { formatError } from '../utils/logger';

export function normalizeAIBaseUrl(input: string | null | undefined): string {
    const url = new URL(input?.trim() || 'https://api.openai.com/v1');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('AI base URL must be an HTTP(S) API URL without credentials, query or fragment');
    }
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
    return url.toString().replace(/\/$/, '');
}

export function isAliyunCompatibleBaseUrl(baseUrl: string | null | undefined): boolean {
    const normalized = String(baseUrl ?? '').toLowerCase();
    return normalized.includes('dashscope.aliyuncs.com') || normalized.includes('aliyuncs.com/compatible-mode');
}

export function normalizeProviderExtraPayload(extraPayload: Record<string, any> | undefined, baseUrl: string | null | undefined): Record<string, any> {
    if (!extraPayload) return {};

    const normalizedPayload: Record<string, any> = { ...extraPayload };
    if (!isAliyunCompatibleBaseUrl(baseUrl)) {
        return normalizedPayload;
    }

    // Aliyun Bailian OpenAI-compatible endpoint uses enable_thinking instead of thinking.type.
    if (normalizedPayload.enable_thinking === undefined && normalizedPayload.thinking) {
        const thinkingType = String(normalizedPayload.thinking?.type || '').toLowerCase();
        if (thinkingType === 'disabled') {
            normalizedPayload.enable_thinking = false;
        } else if (thinkingType === 'enabled') {
            normalizedPayload.enable_thinking = true;
        }
    }

    delete normalizedPayload.thinking;
    return normalizedPayload;
}

export function parseExtraPayloadValue(raw: unknown): Record<string, any> {
    if (!raw || typeof raw !== 'string') {
        return {};
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            logger.warn('AI extraPayload is not a JSON object, ignoring configured value');
            return {};
        }
        return parsed;
    } catch (error: any) {
        logger.warn('Failed to parse configured AI extraPayload, ignoring configured value', formatError(error));
        return {};
    }
}

export function resolveRequestTimeoutMs(timeoutOverride: number | undefined | null, configuredTimeoutMs: unknown): number {
    if (timeoutOverride !== undefined && timeoutOverride !== null) {
        return timeoutOverride;
    }

    const configured = Number(configuredTimeoutMs);
    if (Number.isFinite(configured) && configured > 0) {
        return configured;
    }

    return 60000;
}
