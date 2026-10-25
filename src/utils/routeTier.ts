import type { RouteCarrier, RouteCarrierResult } from './routeProbe'
import { summarizeRouteAttempt } from './routeProbe'

export const ROUTE_TIER_NOTICE = '骨干类型参考等级，非带宽／延迟／丢包实测，非 CN2 GIA 或 SLA 承诺；仅针对本次服务器到指定目标的逐跳证据'
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

/** Presentation-only: never mutates route classification, probes or persisted evidence. */
export function getRouteTier(carrier: RouteCarrier, result: RouteCarrierResult | undefined, maxAgeMs: number, now = Date.now()): RouteTier {
  if (!result || result.stale || result.legacy || result.error || result.state !== 'identified'
    || !result.lastSuccess || !Number.isFinite(result.lastSuccess) || result.lastSuccess > now
    || now - result.lastSuccess >= maxAgeMs || !result.landingConfirmed
    || !result.passage || !result.landing || !result.attempts.length) {
    return '--'
  }
  const summaries = result.attempts.map(a => summarizeRouteAttempt(carrier, a))
  if (summaries.some(s => s.conflict || s.reentry
    || (s.passage && s.passage !== result.passage)
    || (s.landingConfirmed && s.landing !== result.landing))) {
    return '--'
  }
  const matching = summaries.filter(s => s.landingConfirmed && s.passage === result.passage && s.landing === result.landing)
  if (!matching.length)
    return '--'
  const premium = ['CN2', '9929', 'CMIN2']
  const ordinary = ['163', '4837', 'CMI', 'CMNET']
  // Multiple front networks are retained in the route display, but not ranked.
  if (!premium.includes(result.passage))
    return ordinary.includes(result.passage) && [...ordinary, ...premium].includes(result.landing) ? '普通' : '--'
  const sufficient = summaries.every((s, i) => s.landingConfirmed
    && s.passage === result.passage && s.landing === result.landing
    && result.attempts[i]!.hops.every(h => !h.timeout && h.asns.length > 0 && h.source === 'query'))
  return result.passage === result.landing && sufficient ? '精品' : '优秀'
}
