const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
const HOP_RE = /^\s*(\d+)\s+/
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const ASN_RE = /\bAS(\d+)\b/gi
const ATTEMPT_RE = /ROUTE_ATTEMPT:(\w+):(\d+\.\d+\.\d+\.\d+)\n([\s\S]*?)(?:ROUTE_EXIT:(\d+)|$)/g
const ERROR_RE = /ROUTE_PROBE_ERROR:(\w+)/
export type RouteCarrier = 'telecom' | 'unicom' | 'mobile'
export type RouteProbeState
  = 'ok' | 'unknown' | 'mixed' | 'failed' | 'remote_disabled' | 'missing_traceroute'
export interface RouteHop {
  distance: number
  ips: string[]
  asns: number[]
  source: 'query' | 'prefix' | 'none' | 'conflict'
  timeout: boolean
  raw: string
}
export interface RouteAttempt {
  method: string
  target: string
  exitCode: number | null
  reached: boolean
  hops: RouteHop[]
}
export interface RouteCarrierResult {
  label: string
  passage: string
  landing: string
  landingConfirmed: boolean
  notes: string[]
  asns: number[]
  route: string
  state: 'identified' | 'unknown' | 'mixed' | 'failed'
  attempts: RouteAttempt[]
  latestAttempts?: RouteAttempt[]
  lastAttempt: number
  lastSuccess?: number
  error?: string
  stale: boolean
  legacy?: boolean
}
export interface RouteProbeResult {
  version: 2
  state: RouteProbeState
  testedAt: number
  direction: 'egress'
  carriers: Record<RouteCarrier, RouteCarrierResult>
  message?: string
}
export type RouteProbeMap = Record<string, RouteProbeResult>
export const CARRIERS: RouteCarrier[] = ['telecom', 'unicom', 'mobile']
const NAMES: Record<number, string> = {
  4809: 'CN2',
  4134: '163',
  9929: '9929',
  4837: '4837',
  58807: 'CMIN2',
  58453: 'CMI',
  9808: 'CMNET',
  10099: '10099',
  23764: 'CN2-CTG',
}
const CARRIER_ASNS: Record<RouteCarrier, number[]> = {
  telecom: [4809, 4134, 23764],
  unicom: [9929, 4837, 10099],
  mobile: [58807, 58453, 9808],
}
export type RouteQuality = '精品' | '优质' | '普通' | '未识别'

/** Exact octet boundaries, limited fallback evidence, not a BGP database. */
export function resolvePrefix(ip: string): number | undefined {
  if (!IPV4_RE.test(ip))
    return
  const octets = ip.split('.').map(Number)
  if (octets.some(n => n > 255))
    return
  const [a, b, c] = octets
  if (
    a === 223
    && ((b === 118 && c === 32)
      || (b === 120 && c! >= 128)
      || (b === 119
        && [
          8,
          9,
          10,
          11,
          12,
          13,
          14,
          15,
          26,
          27,
          28,
          29,
          32,
          33,
          34,
          35,
          36,
          37,
          74,
          75,
          88,
          89,
          100,
          252,
          253,
        ].includes(c!)))
  ) {
    return 58807
  }
  const prefixes: [number, number, number][] = [
    [59, 43, 4809],
    [202, 97, 4134],
    [218, 105, 9929],
    [210, 51, 9929],
    [219, 158, 4837],
    [223, 118, 58453],
    [223, 119, 58453],
    [223, 120, 58453],
    [223, 121, 58453],
    [221, 183, 9808],
    [111, 24, 9808],
  ]
  return prefixes.find(([first, second]) => a === first && b === second)?.[2]
}
export function parseHop(raw: string): RouteHop | null {
  const distance = raw.match(HOP_RE)?.[1]
  if (!distance)
    return null
  const ips = Array.from(raw.matchAll(IP_RE), m => m[0]).filter(ip =>
    ip.split('.').every(n => Number(n) <= 255),
  )
  const queried = Array.from(raw.matchAll(ASN_RE), m => Number(m[1])).filter(n => n > 0)
  const prefixes = ips.map(resolvePrefix).filter((n): n is number => n !== undefined)
  const conflict = queried.length > 0 && prefixes.some(n => !queried.includes(n))
  return {
    distance: Number(distance),
    ips,
    asns: queried.length ? queried : prefixes,
    source: conflict ? 'conflict' : queried.length ? 'query' : prefixes.length ? 'prefix' : 'none',
    timeout: raw.includes('*'),
    raw: raw.slice(0, 1000),
  }
}
/** Ordered labels only; this helper does not establish arrival or service quality. */
export function getRouteProfile(carrier: RouteCarrier, asns: number[]): string {
  const known = asns.filter(n => CARRIER_ASNS[carrier].includes(n))
  const runs = known.filter((n, i) => n !== known[i - 1])
  if (new Set(runs).size < runs.length)
    return '混合线路'
  return NAMES[runs[0]!] || '未识别'
}
export function getRouteQuality(carrier: RouteCarrier, asns: number[]): RouteQuality {
  const profile = getRouteProfile(carrier, asns)
  if (profile === '混合线路' || profile === '未识别')
    return '未识别'
  return ['CN2', '9929', 'CMIN2'].includes(profile) ? '优质' : '普通'
}
// Known access ASNs are not relabeled as backbone ASNs. Only the observed
// preceding backbone can be described as a domestic delivery network.
const ACCESS_ASNS: Record<RouteCarrier, number[]> = {
  telecom: [],
  // CUG (10099) is Unicom's international entry network; the China-bound
  // backbone segments are 9929/4837 and they front the passage label.
  unicom: [10099],
  mobile: [56048],
}
export function summarizeRouteAttempt(carrier: RouteCarrier, attempt: RouteAttempt) {
  const hops = [...attempt.hops].sort((a, b) => a.distance - b.distance)
  // Access/entry networks (e.g. CUG 10099) never front the passage label;
  // the front shows the China-bound backbone segment only.
  const known = hops.flatMap((hop, index) => [...new Set(hop.asns)]
    .filter(asn => NAMES[asn] && !ACCESS_ASNS[carrier].includes(asn))
    .map(asn => ({ asn, index })))
  const runs = known.filter((item, i) => item.asn !== known[i - 1]?.asn)
  const conflict = hops.some(h => h.source === 'conflict'
    || new Set(h.asns.filter(n => NAMES[n])).size > 1)
  const last = runs.at(-1)
  // Lenient delivery: any observed backbone ASN counts, not only the final hop.
  // Probing to carrier speed-test points means core hops may be filtered while
  // transit hops still identify the backbone; requiring the last hop discards that.
  const backboneRuns = runs.filter(r => CARRIER_ASNS[carrier].includes(r.asn))
  const delivery = backboneRuns.at(-1) ?? (last && CARRIER_ASNS[carrier].includes(last.asn) ? last : undefined)
  const deliveryEnd = delivery ? known.filter(h => h.asn === delivery.asn).at(-1)!.index : -1
  const suffix = delivery ? hops.slice(deliveryEnd + 1) : []
  const suffixKnown = suffix.length === 0 || Boolean(suffix.at(-1)?.asns.length
    && suffix.at(-1)?.ips.includes(attempt.target)
    && suffix.every(h => h.asns.every(n => ACCESS_ASNS[carrier].includes(n))))
  const complete = Boolean(delivery && attempt.reached && attempt.exitCode === 0
    && suffixKnown && !conflict)
  const path = runs.map(r => NAMES[r.asn]!)
  // A destination-only hop describes the observed last network, not transit.
  const transit = delivery && runs.length > 1 ? path.slice(0, -1) : path
  const destinationOnly = runs.length === 1 && hops[last!.index]?.ips.includes(attempt.target)
  const passage = conflict || destinationOnly ? '' : transit.join(' → ')
  const landing = !conflict && delivery ? NAMES[delivery.asn]! : ''
  const reentry = new Set(runs.map(r => r.asn)).size < runs.length
  const notes = [
    ...(conflict ? ['ASN 查询／前缀来源冲突，不能确定线路'] : []),
    ...(reentry ? ['观察到网络重入／交替；保留有序路径，不等同质量差'] : []),
    ...(!complete ? ['落地仅为最后观察网络；未确认目标到达或末段未知'] : []),
    ...(suffix.length && complete ? ['落地表示最后识别骨干／国内交付网；最终接入 ASN 另见逐跳证据'] : []),
    ...(hops.some(h => h.timeout || !h.asns.length) ? ['含未知／超时跳，不能证明相邻网络直接互联'] : []),
  ]
  return { passage, landing, landingConfirmed: complete, notes, conflict, reentry, rank: conflict ? 0 : complete ? 3 : passage ? 2 : landing ? 1 : 0 }
}
function classify(carrier: RouteCarrier, attempts: RouteAttempt[], at: number): RouteCarrierResult {
  const summaries = attempts.map(a => summarizeRouteAttempt(carrier, a))
  const bestIndex = summaries.reduce((best, s, i) => s.rank > (summaries[best]?.rank ?? -1) ? i : best, -1)
  const best = summaries[bestIndex]
  const signature = (s: NonNullable<typeof best>) => `${s.passage}|${s.landing}`
  const differences = summaries.some(s => s.rank > 0 && best && (signature(s) !== signature(best) || s.landingConfirmed !== best.landingConfirmed))
  const ambiguous = summaries.some(s => best && s.rank === best.rank && s.rank > 0 && signature(s) !== signature(best))
  const notes = [...(best?.notes || [])]
  if (summaries.some(s => s.conflict))
    notes.push('存在来源冲突的探测方法，详见逐跳证据')
  if (differences)
    notes.push(`方法差异：${summaries.map((s, i) => `${attempts[i]!.method}: ${s.passage || '--'} → ${s.landing || '--'} (${s.landingConfirmed ? '到达' : '末段未确认'})`).join('；')}`)
  if (ambiguous)
    notes.push('同等完整方法结论不同，主标签暂不选择；不是物理混合判定')
  const passage = ambiguous ? '' : best?.passage || ''
  const landing = ambiguous ? '' : best?.landing || ''
  const identified = Boolean(passage || landing)
  const asns = attempts[bestIndex]?.hops.flatMap(h => h.asns) || []
  return {
    label: passage || '未识别',
    passage,
    landing,
    landingConfirmed: !ambiguous && Boolean(best?.landingConfirmed),
    notes,
    asns,
    route: asns.map(n => `AS${n}`).join(' → ') || '—',
    state: identified ? best?.reentry ? 'mixed' : 'identified' : attempts.length ? 'unknown' : 'failed',
    attempts,
    lastAttempt: at,
    lastSuccess: identified ? at : undefined,
    stale: false,
    error: identified ? undefined : '本次证据不足、来源冲突或方法差异',
  }
}
function overall(carriers: Record<RouteCarrier, RouteCarrierResult>): RouteProbeState {
  if (CARRIERS.some(c => carriers[c].state === 'mixed'))
    return 'mixed'
  return CARRIERS.every(c => carriers[c].state === 'identified' && !carriers[c].stale)
    ? 'ok'
    : 'unknown'
}
export function parseRouteProbeOutput(output: string, testedAt = Date.now()): RouteProbeResult {
  const carriers = {} as Record<RouteCarrier, RouteCarrierResult>
  for (const carrier of CARRIERS) {
    const attempts: RouteAttempt[] = []
    const block
      = output.split(`ROUTE_PROBE_CARRIER:${carrier}\n`)[1]?.split('ROUTE_PROBE_CARRIER:')[0] || ''
    for (const match of block.matchAll(ATTEMPT_RE)) {
      const hops = match[3]!
        .split('\n')
        .map(parseHop)
        .filter((h): h is RouteHop => h !== null)
      attempts.push({
        method: match[1]!,
        target: match[2]!,
        exitCode: match[4] ? Number(match[4]) : null,
        reached: hops.some(h => h.ips.includes(match[2]!)),
        hops,
      })
    }
    carriers[carrier] = classify(carrier, attempts, testedAt)
  }
  const error = output.match(ERROR_RE)?.[1]
  if (error) {
    for (const carrier of CARRIERS) carriers[carrier].error = error
  }
  return {
    version: 2,
    testedAt,
    direction: 'egress',
    carriers,
    state: error === 'missing_traceroute' ? 'missing_traceroute' : overall(carriers),
    message: error,
  }
}
export function mergeRouteResult(
  previous: RouteProbeResult | undefined,
  next: RouteProbeResult,
): RouteProbeResult {
  const carriers = { ...next.carriers }
  for (const c of CARRIERS) {
    const old = previous?.carriers[c]
    const fresh = next.carriers[c]
    if (old && old.lastAttempt > fresh.lastAttempt) {
      carriers[c] = old
      continue
    }
    if (old?.lastSuccess && fresh.state !== 'identified' && fresh.state !== 'mixed') {
      carriers[c] = {
        ...old,
        lastAttempt: fresh.lastAttempt,
        error: fresh.error || next.message || '本次采集失败',
        stale: true,
        // Keep successful evidence and retain the latest failed attempts separately.
        attempts: old.attempts,
        latestAttempts: fresh.attempts,
      }
    }
  }
  return { ...next, carriers, state: overall(carriers) }
}
export function failedRouteResult(message: string, at = Date.now()): RouteProbeResult {
  const result = parseRouteProbeOutput('', at)
  result.message = message
  for (const c of CARRIERS) result.carriers[c].error = message
  return result
}
export function parseStoredRouteProbe(value: unknown): RouteProbeResult | null {
  if (!value || typeof value !== 'object')
    return null
  const raw = value as Record<string, unknown>
  if (
    ![1, 2].includes(Number(raw.version))
    || !Number.isFinite(raw.testedAt)
    || !raw.carriers
    || typeof raw.carriers !== 'object'
  ) {
    return null
  }
  const carriers = {} as Record<RouteCarrier, RouteCarrierResult>
  for (const c of CARRIERS) {
    const saved = (raw.carriers as Record<string, unknown>)[c] as
      Partial<RouteCarrierResult> | undefined
    if (!saved || !Array.isArray(saved.asns))
      return null
    if (
      raw.version === 2
      && Array.isArray(saved.attempts)
      && saved.attempts.every(a => a && typeof a.method === 'string' && typeof a.target === 'string' && Array.isArray(a.hops) && a.hops.every(h => h && Number.isFinite(h.distance) && Array.isArray(h.asns) && h.asns.every(Number.isFinite) && Array.isArray(h.ips) && h.ips.every(ip => typeof ip === 'string')))
    ) {
      carriers[c] = {
        ...classify(c, saved.attempts, Number(saved.lastSuccess || raw.testedAt)),
        lastAttempt: Number(saved.lastAttempt || raw.testedAt),
        lastSuccess: saved.lastSuccess,
        stale: Boolean(saved.stale),
        error: saved.error,
        latestAttempts: saved.latestAttempts,
      }
    }
    else {
      // v1 lost repeats/positions: never promote its deduplicated list to a fresh route.
      carriers[c] = {
        ...classify(c, [], Number(raw.testedAt)),
        asns: saved.asns.filter(Number.isFinite),
        stale: true,
        legacy: true,
        error: '旧版缓存证据不完整，等待重新探测',
      }
    }
  }
  return {
    version: 2,
    testedAt: Number(raw.testedAt),
    direction: 'egress',
    carriers,
    state: overall(carriers),
  }
}
export function parseRouteProbeMap(value: unknown): RouteProbeMap {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([uuid, result]) => [uuid, parseStoredRouteProbe(result)])
      .filter((entry): entry is [string, RouteProbeResult] => Boolean(entry[1])),
  )
}

// All shell fragments and targets are compile-time constants, never node/user input.
// Each carrier has a bounded ICMP attempt and UDP fallback. ASN lookup is optional.
export const ROUTE_PROBE_COMMAND = `
command -v traceroute >/dev/null 2>&1 || { echo ROUTE_PROBE_ERROR:missing_traceroute; exit 127; }
command -v timeout >/dev/null 2>&1 || { echo ROUTE_PROBE_ERROR:missing_timeout; exit 127; }
A=''; timeout -k 1 3 traceroute --help 2>&1 | grep -q -- '-A' && A='-A'
probe() {
  echo "ROUTE_PROBE_CARRIER:$1"
  # ICMP first; domestic speed-test points usually filter UDP probes.
  echo "ROUTE_ATTEMPT:icmp:$2"
  out=$(timeout -k 2 40 traceroute -I $A -n -q 2 -w 2 -m 24 "$2" 2>&1)
  rc=$?
  printf '%s\n' "$out"
  echo "ROUTE_EXIT:$rc"
  if [ "$rc" -ne 0 ] && [ -n "$A" ]; then
    echo "ROUTE_ATTEMPT:icmp_plain:$2"
    out=$(timeout -k 2 34 traceroute -I -n -q 2 -w 2 -m 24 "$2" 2>&1)
    rc=$?
    printf '%s\n' "$out"
    echo "ROUTE_EXIT:$rc"
  fi
  # Skip the UDP attempt when ICMP already produced usable hops; a second method
  # only helps when the first was nearly empty, and disagreement clears labels.
  valid=$(printf '%s' "$out" | grep -cE '^[[:space:]]*[0-9]+[[:space:]]+[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+')
  if [ "\${valid:-0}" -lt 3 ]; then
    echo "ROUTE_ATTEMPT:udp:$2"
    timeout -k 2 40 traceroute $A -n -q 2 -w 2 -m 24 "$2" 2>&1
    echo "ROUTE_EXIT:$?"
  fi
}
probe telecom 219.141.140.10
probe unicom 202.106.195.68
probe mobile 221.179.155.161
exit 0
`
// Installation is a separate opt-in task with its own bound, never part of a probe.
export const ROUTE_PROBE_INSTALL_COMMAND = `
command -v traceroute >/dev/null 2>&1 && exit 0
command -v timeout >/dev/null 2>&1 || { echo ROUTE_INSTALL_ERROR:missing_timeout; exit 127; }
[ "$(id -u)" = 0 ] || { echo ROUTE_INSTALL_ERROR:root_required; exit 126; }
if command -v apt-get >/dev/null 2>&1; then timeout -k 5 120 apt-get update && timeout -k 5 120 env DEBIAN_FRONTEND=noninteractive apt-get install -y traceroute
elif command -v apk >/dev/null 2>&1; then timeout -k 5 120 apk add --no-cache traceroute
elif command -v dnf >/dev/null 2>&1; then timeout -k 5 120 dnf install -y traceroute
elif command -v yum >/dev/null 2>&1; then timeout -k 5 120 yum install -y traceroute
else echo ROUTE_INSTALL_ERROR:unsupported_package_manager; exit 125; fi
`
