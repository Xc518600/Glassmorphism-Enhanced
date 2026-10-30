import type { RouteCarrier, RouteCarrierResult } from './routeProbe'

export const ROUTE_TIER_NOTICE = '线路类型参考等级，非带宽／延迟／丢包实测，非 CN2 GIA 或 SLA 承诺；仅针对本次服务器到指定目标的逐跳证据'
export type RouteTier = '普通' | '优秀' | '精品' | '--'
export const ROUTE_TIER_COLORS: Record<RouteTier, string> = {
  '普通': 'text-muted-foreground',
  '优秀': 'text-blue-500',
  '精品': 'text-emerald-500',
  '--': 'text-muted-foreground',
}

export const ROUTE_DOT_COLORS: Record<RouteTier, string> = {
  ...ROUTE_TIER_COLORS,
  '普通': 'text-yellow-500',
  '--': 'text-red-500',
}

// 线路类型（9929/CN2/163 等）是机器的静态属性：等级一旦有据可评就长期有效，
// 不因证据过期而消失；数据新旧由卡片悬浮提示里的「上次有效」时间告知。
// stale/legacy/error 仍是硬性失效条件：探测失败或证据不完整时诚实降级为 --。
const PREMIUM = ['CN2', 'CN2-CTG', '9929', 'CMIN2']
const ORDINARY = ['163', '4837', 'CMI', 'CMNET', '10099']

/**
 * Line-type grading only: never reads Ping, never requires the target to be reached.
 * A premium backbone in the observed path grades 优秀/精品 purely by label;
 * an ordinary backbone grades 普通. Unknown labels grade '--'.
 * Presentation-only: never mutates route classification or persisted evidence.
 */
export function getRouteTier(carrier: RouteCarrier, result: RouteCarrierResult | undefined, _maxAgeMs?: number, now = Date.now()): RouteTier {
  if (!result || result.stale || result.legacy || result.error
    || result.lastSuccess === undefined || !Number.isFinite(result.lastSuccess) || result.lastSuccess > now
    || (!result.passage && !result.landing)) {
    return '--'
  }
  // Multi-hop front networks keep their ordered display but are not ranked here.
  const legs = result.passage ? result.passage.split(' → ').filter(Boolean) : []
  const front = legs.at(-1) || ''
  const landing = result.landing || ''
  if (PREMIUM.includes(front))
    return landing === front ? '精品' : '优秀'
  if (ORDINARY.includes(front))
    return ORDINARY.includes(landing) || PREMIUM.includes(landing) ? '普通' : '--'
  if (!front && (PREMIUM.includes(landing) || ORDINARY.includes(landing)))
    return ORDINARY.includes(landing) ? '普通' : '优秀'
  return '--'
}
