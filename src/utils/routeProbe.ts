export type RouteCarrier = 'telecom' | 'unicom' | 'mobile'
export type RouteProbeState = 'ok' | 'unknown' | 'mixed' | 'failed' | 'remote_disabled' | 'missing_traceroute'

export interface RouteCarrierResult {
  label: string
  asns: number[]
  route: string
  state: 'identified' | 'unknown' | 'mixed' | 'failed'
}

export interface RouteProbeResult {
  version: 1
  state: RouteProbeState
  testedAt: number
  direction: 'egress'
  carriers: Record<RouteCarrier, RouteCarrierResult>
  message?: string
}

const CARRIER_ASNS: Record<RouteCarrier, Set<number>> = {
  telecom: new Set([4809, 4134]),
  unicom: new Set([9929, 4837]),
  mobile: new Set([58807, 9808]),
}

const ROUTE_PROBE_BODY = `printf '%s\\n' 'ROUTE_PROBE_CARRIER:telecom'; traceroute -n -A -q 1 -w 1 -m 24 202.97.0.1 2>&1; printf '%s\\n' 'ROUTE_PROBE_CARRIER:unicom'; traceroute -n -A -q 1 -w 1 -m 24 219.158.3.1 2>&1; printf '%s\\n' 'ROUTE_PROBE_CARRIER:mobile'; traceroute -n -A -q 1 -w 1 -m 24 211.136.88.1 2>&1`

export const ROUTE_PROBE_COMMAND = `if ! command -v traceroute >/dev/null 2>&1; then printf '%s\\n' 'ROUTE_PROBE_ERROR:missing_traceroute'; exit 127; fi; ${ROUTE_PROBE_BODY}`

// This is intentionally a fixed, auditable command. It never interpolates a
// node name/UUID or any user-provided package/command text.
export const ROUTE_PROBE_INSTALL_COMMAND = `if command -v traceroute >/dev/null 2>&1; then printf '%s\\n' 'ROUTE_PROBE_INSTALL:already_present'; elif [ "$(id -u)" -ne 0 ]; then printf '%s\\n' 'ROUTE_PROBE_INSTALL_ERROR:root_required'; exit 126; elif command -v apt-get >/dev/null 2>&1; then printf '%s\\n' 'ROUTE_PROBE_INSTALL:apt'; apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y traceroute; elif command -v apk >/dev/null 2>&1; then printf '%s\\n' 'ROUTE_PROBE_INSTALL:apk'; apk add --no-cache traceroute; elif command -v dnf >/dev/null 2>&1; then printf '%s\\n' 'ROUTE_PROBE_INSTALL:dnf'; dnf install -y traceroute; elif command -v yum >/dev/null 2>&1; then printf '%s\\n' 'ROUTE_PROBE_INSTALL:yum'; yum install -y traceroute; else printf '%s\\n' 'ROUTE_PROBE_INSTALL_ERROR:unsupported_package_manager'; exit 125; fi; if ! command -v traceroute >/dev/null 2>&1; then printf '%s\\n' 'ROUTE_PROBE_INSTALL_ERROR:install_failed'; exit 127; fi; ${ROUTE_PROBE_BODY}`

function asnsFromText(text: string): number[] {
  const found = [...text.matchAll(/\bAS?(\d{2,10})\b/gi)].map(match => Number(match[1]))
  return [...new Set(found.filter(Number.isFinite))]
}

export type RouteQuality = '精品' | '优质' | '普通' | '未识别'

export function getRouteProfile(carrier: RouteCarrier, asns: number[]): string {
  const known = asns.filter(asn => CARRIER_ASNS[carrier].has(asn))
  if (carrier === 'telecom') {
    if (known.includes(4809)) return 'CN2'
    if (known.includes(4134)) return '163'
  }
  if (carrier === 'unicom') {
    if (known.includes(9929)) return '9929'
    if (known.includes(4837)) return '4837'
  }
  if (carrier === 'mobile') {
    if (known.includes(9808)) return 'CMIN2'
    if (known.includes(58807)) return 'CMI'
  }
  return '未识别'
}

/** Route tier is derived from route ASN evidence, never from latency/loss. */
export function getRouteQuality(carrier: RouteCarrier, asns: number[]): RouteQuality {
  const known = asns.filter(asn => CARRIER_ASNS[carrier].has(asn))
  if (carrier === 'telecom' && known.includes(4809)) return '精品'
  if (carrier === 'unicom' && known.includes(9929)) return '优质'
  if (carrier === 'mobile' && known.includes(9808)) return '优质'
  if (known.some(asn => [4134, 4837, 58807].includes(asn))) return '普通'
  return '未识别'
}

function classify(carrier: RouteCarrier, asns: number[]): RouteCarrierResult['state'] {
  const recognized = asns.filter(asn => CARRIER_ASNS[carrier].has(asn))
  if (!recognized.length)
    return 'unknown'
  // Other carriers' upstream ASNs are normal transit hops and must not turn
  // this carrier's result into "mixed". Only the target carrier's own ASN
  // evidence is used for the compact classification.
  return new Set(recognized).size > 1 ? 'mixed' : 'identified'
}

export function parseRouteProbeOutput(output: string, testedAt = Date.now()): RouteProbeResult {
  const carriers = {} as Record<RouteCarrier, RouteCarrierResult>
  const names: RouteCarrier[] = ['telecom', 'unicom', 'mobile']
  for (const carrier of names) {
    const start = output.indexOf(`ROUTE_PROBE_CARRIER:${carrier}`)
    const end = start < 0 ? -1 : output.indexOf('ROUTE_PROBE_CARRIER:', start + 1)
    const chunk = start < 0 ? '' : output.slice(start, end < 0 ? undefined : end)
    const asns = asnsFromText(chunk)
    const state = classify(carrier, asns)
    carriers[carrier] = {
      label: state === 'identified' ? '已识别骨干' : state === 'mixed' ? '混合线路' : '未识别',
      asns,
      route: asns.length ? asns.map(asn => `AS${asn}`).join(' → ') : '—',
      state,
    }
  }
  const error = output.match(/ROUTE_PROBE_ERROR:([^\s\r\n]+)/)?.[1]
  const recognized = names.filter(carrier => carriers[carrier].state === 'identified' || carriers[carrier].state === 'mixed').length
  const state: RouteProbeState = error === 'missing_traceroute'
    ? 'missing_traceroute'
    : recognized === 0 ? 'unknown'
      : names.some(carrier => carriers[carrier].state === 'mixed') ? 'mixed' : 'ok'
  return { version: 1, state, testedAt, direction: 'egress', carriers, message: error }
}

export function parseStoredRouteProbe(value: unknown): RouteProbeResult | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<RouteProbeResult>
  if (candidate.version !== 1 || typeof candidate.testedAt !== 'number' || !candidate.carriers) return null
  return value as RouteProbeResult
}

export type RouteProbeMap = Record<string, RouteProbeResult>

export function parseRouteProbeMap(value: unknown): RouteProbeMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .map(([uuid, result]) => [uuid, parseStoredRouteProbe(result)] as const)
    .filter((entry): entry is readonly [string, RouteProbeResult] => Boolean(entry[1])))
}
