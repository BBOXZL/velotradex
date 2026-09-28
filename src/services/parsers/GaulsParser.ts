/**
 * ⚠️  稳定性说明：本解析器未经过长期实盘测试，解析结果与风控策略的可靠性不保证。
 * 如需在实盘环境使用，请先在 observe / testnet 模式下充分验证。
 */
import { IStrategyParser, ParsedStrategy, StrategyRiskConfig, DiscordMessage, GaulsAISignal } from './types';
import logger, { formatError } from '../../utils/logger';
import { parseRelaxedJson } from '../../utils/json';
import aiParserService, { isRetriableAIError } from '../AIParserService';
import marketService from '../MarketService';

export class GaulsParser implements IStrategyParser {
  name = 'GaulsParser';
  private lastParsedStrategies: Map<string, ParsedStrategy[]> = new Map();

  public getRiskConfig(): StrategyRiskConfig {
    return {
      riskMode: 'percentage',
      riskValue: 2,
      defaultLeverage: '5',
      priceTolerance: 0.01,
      entryOrderMode: 'taker',
      tpDistribution: [0.5, 0.5],
      autoCloseOppositePosition: false,
      entryMergeThresholdR: 0.2,
    };
  }

  public buildPrompt(): string {
    return [
      'You are an expert crypto futures trading signal parser for the TraderGauls Discord channel.',
      'Analyze the message text and output structured JSON.',
      '',
      '## Rules',
      '',
      '### Signal Classification',
      '- "Buying Setup" or "Long Setup" = action: open, side: buy',
      '- "Short Setup" or "Short Scalp Setup" = action: open, side: sell',
      '- "TRADE UPDATE" with close keywords (closing, closed, hit SL, done and dusted, book profit, hit breakeven, breakeven hit) = action: close',
      '- "TRADE UPDATE" with SL movement to breakeven (Move SL to breakeven, SL to breakeven, shift SL to B/E) = action: update, newStopLoss: "breakeven"',
      '- "TRADE UPDATE" with only status update (holding, up X%, price flying) = action: ignore (not actionable)',
      '- Non-trading messages (analysis, educational content, recaps, indicator announcements, geopolitical commentary, monthly recaps, weekly breakdowns) = action: ignore',
      '- If a quoted message exists (> [View](...)), it references a previous position. Extract referencedSymbol from that context if the current message operates on it.',
      '',
      '### Entry Parsing',
      '- "CMP" = market order entry, type: market',
      '- "CMP till X" or "CMP Till X" = two entries: one market + one limit at price X (equal weight 1/N each). The X is a limit entry price, not an upper boundary.',
      '- "CMP and X" or "CMP, X" = two entries: one market + one limit at price X',
      '- A standalone number after "Entry:" without "CMP" = limit order, type: limit, with that price',
      '- Multiple entries should have equal weight (1/N each)',
      '',
      '### Symbol Extraction',
      '- Extract symbol from $SYMBOL notation, normalize to BASE_USDT format (e.g., $WIF -> WIF, output as "WIF")',
      '- If the message references a quoted/traded symbol for a close/update, set referencedSymbol',
      '- For close/update: you MUST output both `symbol` and `referencedSymbol` with the same consistent value (e.g., both "WLD"). Never leave `symbol` empty when `referencedSymbol` is known.',
      '',
      '### Take Profit / Stop Loss',
      '- Extract multiple TPs if listed (TP1, TP2, etc.), put all in takeProfits array',
      '- Extract SL as a number',
      '- "breakeven" or "break even" or "B/E" for stopLoss = use string "breakeven"',
      '',
      '### Risk Management',
      '- "low risk" or "reduced risk" = riskMultiplier: 0.5',
      '- Normal risk = riskMultiplier: 1',
      '',
      '### Ignore Conditions',
      '- Pure analysis without actionable setup (BTC update, altcoins update, market commentary)',
      '- Educational/indicator announcements',
      '- Monthly/weekly recaps',
      '- Geopolitical commentary',
      '- Messages only discussing previous trade performance without new action',
      '- Messages with "Arena is closed"',
      '',
      '### Image Handling',
      '- Only parse plain text content, ignore any image/chart references in the text',
      '- Do not extract information from image URLs or chart screenshots',
    ].join('\n');
  }

  public buildResponseFormat(): object {
    const schema = {
      name: 'trading_signal',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'close', 'update', 'ignore'],
            description: 'The trading action to take',
          },
        side: {
          type: 'string',
          enum: ['buy', 'sell'],
          description: 'Direction of the trade (only for open)',
        },
        symbol: {
          type: 'string',
          description: 'Trading symbol base (e.g., "WIF", "ETH")',
        },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['market', 'limit'] },
              price: { type: 'number', nullable: true },
            },
            required: ['type'],
          },
          description: 'Entry orders for open signal',
        },
        takeProfits: {
          type: 'array',
          items: { type: 'number' },
          description: 'Take profit price levels in ascending order',
        },
        stopLoss: {
          description: 'Stop loss price (number) or "breakeven" (string)',
        },
        closePercentage: {
          type: 'number',
          description: 'Percentage of position to close (0-100)',
        },
        newStopLoss: {
          description: 'New stop loss for update signal (number or "breakeven")',
        },
        riskMultiplier: {
          type: 'number',
          enum: [0.5, 1],
          description: 'Risk multiplier: 0.5 for low risk, 1 for normal',
        },
        referencedSymbol: {
          type: 'string',
          description: 'Symbol referenced from quoted message context',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence in the parsed signal (0-1)',
        },
        reasoning: {
          type: 'string',
          description: 'Brief explanation of the parsing decision',
        },
      },
      required: ['action'],
      },
    };
    return { type: 'json_schema', json_schema: schema };
  }

  public async postProcess(signal: GaulsAISignal, multiLegSizing?: 'split' | 'full'): Promise<ParsedStrategy[] | null> {
    if (signal.action === 'ignore') {
      logger.info('GaulsParser: AI classified as ignore', { reasoning: signal.reasoning });
      return null;
    }

    // S3: update/close 允许用 referencedSymbol 回填（ai_logs#27：BE 指令的
    // symbol 为空、WLD 只在 referencedSymbol 里）。open 仍要求独立 symbol。
    const isUpdateOrClose = signal.action === 'update' || signal.action === 'close';
    const symbol = isUpdateOrClose ? (signal.symbol || signal.referencedSymbol) : signal.symbol;
    if (!symbol) {
      logger.warn('GaulsParser: No symbol in AI result');
      return null;
    }
    if (isUpdateOrClose && !signal.symbol && signal.referencedSymbol) {
      logger.info('GaulsParser: update symbol backfilled from referencedSymbol', { referencedSymbol: signal.referencedSymbol });
    }

    const fullSymbol = symbol.includes('_') ? symbol : `${symbol}_USDT`;

    if (signal.action === 'close') {
      const strategy: ParsedStrategy = {
        action: 'close',
        symbol: fullSymbol,
        raw: {},
      };
      if (typeof signal.closePercentage === 'number') {
        strategy.closePercentage = signal.closePercentage;
      }
      return [strategy];
    }

    if (signal.action === 'update') {
      const strategy: ParsedStrategy = {
        action: 'update',
        symbol: fullSymbol,
        raw: {},
      };
      if (signal.newStopLoss != null) {
        strategy.stopLoss = typeof signal.newStopLoss === 'number'
          ? String(signal.newStopLoss)
          : signal.newStopLoss;
      }
      return [strategy];
    }

    // action === 'open'
    if (!signal.side) {
      logger.warn('GaulsParser: Open action without side');
      return null;
    }

    // Build shared fields for all entries
    const shared: Partial<ParsedStrategy> = {
      action: 'open',
      symbol: fullSymbol,
      side: signal.side,
      raw: {},
    };

    if (signal.takeProfits != null) {
      shared.targets = signal.takeProfits.map(String);
    }
    if (signal.stopLoss != null) {
      shared.stopLoss = typeof signal.stopLoss === 'number'
        ? String(signal.stopLoss)
        : signal.stopLoss;
    }
    if (signal.riskMultiplier != null) {
      shared.riskMultiplier = signal.riskMultiplier;
    }
    if (typeof signal.confidence === 'number') {
      shared.confidence = signal.confidence;
    }

    // --- Entry merge logic ---
    const mergeThreshold = this.getRiskConfig().entryMergeThresholdR ?? 0;

    if (signal.entries && signal.entries.length > 1 && mergeThreshold > 0
        && typeof signal.stopLoss === 'number' && signal.side) {
      // Resolve prices for all entries
      const entriesWithPrices: Array<{ entry: typeof signal.entries[0]; price: number }> = [];
      let marketPriceFailed = false;

      for (const entry of signal.entries) {
        if (entry.type === 'limit' && entry.price != null) {
          entriesWithPrices.push({ entry, price: entry.price });
        } else if (entry.type === 'market') {
          const price = await marketService.getCurrentPrice(fullSymbol);
          if (price > 0) {
            entriesWithPrices.push({ entry, price });
          } else {
            logger.info('GaulsParser: Failed to get market price, skipping merge');
            marketPriceFailed = true;
            break;
          }
        }
      }

      if (!marketPriceFailed && entriesWithPrices.length > 1) {
        // Sort: buy descending (high/close first), sell ascending (low/close first)
        entriesWithPrices.sort((a, b) => {
          return signal.side === 'sell' ? a.price - b.price : b.price - a.price;
        });

        const e1 = entriesWithPrices[0];
        const e2 = entriesWithPrices[1];
        const R = Math.abs(e1.price - signal.stopLoss);
        const dist = Math.abs(e1.price - e2.price);

        if (R > 0 && dist < mergeThreshold * R) {
          logger.info(`GaulsParser: Merging entries (price ${e1.price} and ${e2.price}, dist=${dist.toFixed(2)} < ${mergeThreshold}R, R=${R.toFixed(2)})`);
          signal.entries = signal.entries!.filter((e) => e !== e2.entry);
        }
      }
    }

    // Split each entry into a separate ParsedStrategy
    if (signal.entries && signal.entries.length > 0) {
      const validEntries = signal.entries.filter(
        (e) => e.type === 'market' || (e.type === 'limit' && e.price != null)
      );
      if (validEntries.length === 0) {
        logger.warn('GaulsParser: All entries filtered out (limit entries missing price)');
        return null;
      }
      // S4: 默认 split 保持 weight=1/N 现状；full 时每腿 weight=1 全额
      // （本函数是解析器直调路径；路由层逐条执行时由 applyMultiLegSizing 兜底）。
      const weight = multiLegSizing === 'full' ? 1 : 1 / validEntries.length;
      // 组元数据：供路由级 entrySelection='nearest_sl' 判断哪个入场点距止损最近
      const groupEntries = validEntries.map((e) => ({ type: e.type, price: e.price }));
      return validEntries.map((entry, index) => ({
        ...shared,
        entries: [entry],
        weight,
        orderType: entry.type,
        entryPrice: entry.type === 'limit' ? String(entry.price) : 'CMP',
        entryIndex: index,
        entryCount: validEntries.length,
        groupEntries,
      } as ParsedStrategy));
    }

    // No entries at all: single open strategy without explicit entry
    return [{ ...shared, orderType: 'market', entryPrice: 'CMP' } as ParsedStrategy];
  }

  public async parse(message: DiscordMessage, isDryRun: boolean = false): Promise<ParsedStrategy[] | null> {
    const content = message.content || '';

    try {
      if (!content) return null;

      // 1. Clean message text
      const cleaned = this.cleanContent(content);
      if (!cleaned) return null;

      // 2. Call AI
      if (!aiParserService.isConfigured()) {
        logger.warn('GaulsParser: AIParserService not configured, skipping');
        return null;
      }

      const systemPrompt = this.buildPrompt();
      const responseFormat = this.buildResponseFormat();

      // 先尝试 strict json_schema；若 AI 输出无法解析（部分 provider 如 mimo
      // 对 strict json_schema 兼容性差，输出被截断），降级为 json_object 模式重试一次。
      const aiResponse = await this.analyzeWithRetry({
        systemPrompt,
        userContent: cleaned,
        originalMessage: message,
        responseFormat,
      });

      if (!aiResponse) {
        logger.info('GaulsParser: AI analysis returned null');
        return null;
      }

      // 3. Parse AI response
      const signal = this.parseAIResponse(aiResponse.content);
      if (!signal) return null;
      logger.info('GaulsParser: AI signal parsed', { action: signal.action, side: signal.side, symbol: signal.symbol, stopLoss: signal.stopLoss, newStopLoss: (signal as any).newStopLoss, takeProfits: signal.takeProfits });

      // 4. Convert to ParsedStrategy[]
      const strategies = await this.postProcess(signal);
      if (!strategies) return null;

      for (const s of strategies) {
        s.raw = message;
      }

      // 5. Edit detection
      if (!isDryRun) {
        const oldStrategies = this.lastParsedStrategies.get(message.id);
        if (oldStrategies) {
          if (this.areStrategiesEqual(oldStrategies, strategies)) {
            logger.info('GaulsParser: Unchanged edit', { id: message.id });
            return null;
          }

          logger.info('GaulsParser: Message edited, replacing strategies', { id: message.id });

          // Generate close actions for old open strategies
          const closeActions: ParsedStrategy[] = oldStrategies
            .filter(s => s.action === 'open')
            .map(s => ({
              action: 'close' as const,
              symbol: s.symbol,
              closePercentage: 100,
              raw: message,
            }));

          this.lastParsedStrategies.set(message.id, strategies);
          return [...closeActions, ...strategies];
        }
        this.lastParsedStrategies.set(message.id, strategies);
      }

      return strategies;
    } catch (error: any) {
      logger.error('GaulsParser: parse() failed', formatError(error));
      return null;
    }
  }

  private cleanContent(content: string): string | null {
    if (!content) return null;

    let text = content;

    // Extract quoted text from Discord's "> [View](...)" format
    const quoteMatch = text.match(/^>\s*\[View\]\(.*?\)\s*\n?/m);
    if (quoteMatch) {
      text = text.replace(quoteMatch[0], '').trim();
    }

    // Remove #TraderGauls tag and emoji
    text = text.replace(/#TraderGauls\s*[🎭]*\s*/g, '').trim();

    // Remove empty message placeholder
    if (text === '[empty message]') return null;

    return text || null;
  }

  private async analyzeWithRetry(params: {
    systemPrompt: string;
    userContent: string;
    originalMessage: DiscordMessage;
    responseFormat: object;
  }): Promise<{ content: string; usage: any; raw: any; logId?: number } | null> {
    // S6: analyzeRaw already retries retriable upstream errors (5xx/timeout/
    // empty) 3x with 0s/5s/30s backoff, so here we only handle two cases:
    // (a) upstream throw that survived analyzeRaw's retries → delay path is
    //     decided by the caller via delayContext; return null (no strategy).
    // (b) 200-but-unparseable → keep the existing json_object downgrade.
    const delayContext = {
      messageId: String((params.originalMessage as any)?.id ?? ''),
      channelId: String((params.originalMessage as any)?.channel_id ?? ''),
      rawMessage: params.originalMessage,
      routeIds: aiParserService.getCurrentRouteContext().routeIds,
      routeNames: aiParserService.getCurrentRouteContext().routeNames,
    };
    let first: { content: string; usage: any; raw: any; logId?: number } | null = null;
    try {
      // 第一次：strict json_schema（analyzeRaw 内部已对可重试错误做 3 次退避）
      first = await aiParserService.analyzeRaw({
        systemPrompt: params.systemPrompt,
        userContent: params.userContent,
        originalMessage: params.originalMessage,
        responseFormat: params.responseFormat,
        timeout: 60000,
        retryDelaysMs: process.env.NODE_ENV === 'test' ? [0, 0, 0] : undefined,
        delayContext,
      });
    } catch (error: any) {
      // Upstream still failing after analyzeRaw's own retries. Retriable
      // exhaustion can still be saved by the json_object fallback below; only
      // non-retriable (4xx) short-circuits here. The delay queue (wired via
      // analyzeRaw's delayContext) holds the message for the worker.
      if (!isRetriableAIError(error)) {
        logger.error('GaulsParser: AI upstream non-retriable failure', formatError(error, {
          messageId: delayContext.messageId, channelId: delayContext.channelId,
        }));
        return null;
      }
      logger.warn('GaulsParser: AI upstream attempts exhausted, trying json_object fallback', formatError(error, {
        messageId: delayContext.messageId, channelId: delayContext.channelId,
      }));
      first = null;
    }
    if (first && this.parseAIResponse(first.content)) {
      return first;
    }

    // 降级：json_object（不传 strict schema，由 prompt 约束输出）
    logger.warn('GaulsParser: strict json_schema response unparseable, retrying with json_object mode');
    try {
      const fallback = await aiParserService.analyzeRaw({
        systemPrompt: params.systemPrompt,
        userContent: params.userContent,
        originalMessage: params.originalMessage,
        // 显式覆盖 extraPayload 中的 response_format 为 json_object，
        // 确保 provider 端按宽松 JSON 约束输出
        extraPayload: { response_format: { type: 'json_object' } },
        timeout: 60000,
        retryDelaysMs: process.env.NODE_ENV === 'test' ? [0, 0, 0] : undefined,
        delayContext,
      });
      return fallback;
    } catch (error: any) {
      logger.error('GaulsParser: AI fallback failed after retries', formatError(error, {
        messageId: delayContext.messageId, channelId: delayContext.channelId,
        retriable: isRetriableAIError(error),
      }));
      return null;
    }
  }

  private parseAIResponse(content: string): GaulsAISignal | null {
    if (!content) {
      logger.warn('GaulsParser: Empty AI response');
      return null;
    }

    try {
      const result = parseRelaxedJson<GaulsAISignal>(content);
      if (!result) {
        logger.warn('GaulsParser: AI response is not valid JSON even after relaxed parsing', { snippet: content.slice(0, 200) });
        return null;
      }

      if (!result.action) {
        logger.warn('GaulsParser: AI response missing action');
        return null;
      }

      return result;
    } catch (e: any) {
      logger.error('GaulsParser: Failed to parse AI JSON response', formatError(e));
      return null;
    }
  }

  private areStrategiesEqual(a: ParsedStrategy[] | null, b: ParsedStrategy[] | null): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;

    const clean = (s: ParsedStrategy) => {
      const { raw, ...rest } = s;
      return rest;
    };

    return JSON.stringify(a.map(clean)) === JSON.stringify(b.map(clean));
  }
}
