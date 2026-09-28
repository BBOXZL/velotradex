/**
 * AI 日志「重新解析」重试逻辑。
 * 抽自 AIConfig.vue，使用模块级共享状态保证表格行内按钮与详情弹窗内的
 * 重试按钮能共用同一份「正在重试」状态，避免出现两个不一致的 loading。
 *
 * S7: 后端 triggerOrder 补了幂等 guard（400 重复触发直接抛错），这里把
 * 后端 warning/duplicate 一并透出，让二次确认框与幂等拒绝都有明确回显。
 */
import { ref } from 'vue'
import request from '../utils/request'
import { ElMessage } from 'element-plus'

/** 模块级共享：当前正在重试的日志 ID 列表。 */
const retryingLogIds = ref<number[]>([])

/** 判断指定日志是否正在重试中。 */
export const isRetrying = (logId?: number): boolean => {
  if (!logId) return false
  return retryingLogIds.value.includes(logId)
}

export interface AiLogRetryResult {
  success: boolean
  logId?: number
  warning?: string
  duplicate?: { auditId?: number; strategyId?: number; orderId?: number; messageId?: string }
  result?: { content?: unknown; usage?: unknown }
  log?: any
  orderResult?: { id?: string; status?: string; symbol?: string; side?: string }
}

/**
 * 从重解析响应中提取可二次确认的订单要素（symbol/side/entry/SL/TP/路由）。
 * S7:「重解析并补下单」的确认框回显来源；解析不出时返回 null（按钮保持可点，
 * 后端仍有 guard，只是确认框显示"解析结果待返回后确认"兜底文案）。
 */
export const extractRetryOrderPreview = (log: any, content?: unknown): {
  symbol: string
  side: string
  entry: string
  stopLoss: string
  takeProfit: string
  route: string
} | null => {
  const source = content ?? log?.response
  let parsed: any = null
  try {
    if (typeof source === 'string') {
      const match = source.match(/\{[\s\S]*\}/)
      parsed = match ? JSON.parse(match[0]) : JSON.parse(source)
    } else if (source && typeof source === 'object') {
      parsed = source
    }
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const str = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '-'
    if (Array.isArray(v)) return v.map(str).join(', ')
    return String(v)
  }
  const entry = parsed.entryPrice ?? parsed.entry ?? parsed.price ?? '-'
  const stopLoss = parsed.stopLoss ?? parsed.newStopLoss ?? parsed.sl ?? '-'
  const takeProfit = parsed.takeProfits ?? parsed.targets ?? parsed.takeProfit ?? parsed.tp ?? '-'

  return {
    symbol: str(parsed.symbol ?? log?.symbol),
    side: str(parsed.side),
    entry: str(entry),
    stopLoss: str(stopLoss),
    takeProfit: str(takeProfit),
    route: log?.routeNames || log?.routeIds || '-',
  }
}

/**
 * 创建一个重试控制器。
 * @param refresh 重试成功后用于刷新日志列表的回调（通常是父组件的 fetchLogs）。
 */
export function useAiLogRetry(refresh: () => Promise<void>) {
  const retryLog = async (log: any, triggerOrder = false): Promise<AiLogRetryResult | null> => {
    if (!log?.id || isRetrying(log.id)) return null

    retryingLogIds.value = [...retryingLogIds.value, log.id]
    try {
      const res = await request.post(`/ai-config/logs/${log.id}/retry`, { triggerOrder })
      const data = res.data as AiLogRetryResult
      if (data.warning) {
        // S7: 幂等拒绝（success=false + duplicate）用错误态提示，避免误读为成功。
        if (data.success === false && (data as any).duplicate) {
          ElMessage.error(data.warning)
        } else {
          ElMessage.warning(data.warning)
        }
      }
      if (data.orderResult) {
        ElMessage.success(`订单已触发: ${data.orderResult.symbol} ${data.orderResult.side}`)
      } else if (data.success !== false) {
        ElMessage.success('已重新解析')
      }
      await refresh()
      return data
    } catch (err: any) {
      // S7: 后端幂等拒绝若走非 2xx，直接把后端 warning 透出（全局拦截器只管无业务消息的错误）。
      const backendWarning = err?.response?.data?.warning
      const backendDuplicate = err?.response?.data?.duplicate
      if (backendWarning) {
        ElMessage.error(backendWarning)
        return { success: false, warning: backendWarning, duplicate: backendDuplicate } as AiLogRetryResult
      }
      // 全局拦截器已统一提示错误
      return null
    } finally {
      retryingLogIds.value = retryingLogIds.value.filter((id) => id !== log.id)
    }
  }

  return { isRetrying, retryLog }
}
