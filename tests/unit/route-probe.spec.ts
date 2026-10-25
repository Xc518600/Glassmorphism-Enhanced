import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { saveRouteProbeResults } from '../../src/services/routeProbe.service'
import {
  failedRouteResult,
  getRouteProfile,
  getRouteQuality,
  mergeRouteResult,
  parseHop,
  parseRouteProbeMap,
  parseRouteProbeOutput,
  resolvePrefix,
  ROUTE_PROBE_COMMAND,
  ROUTE_PROBE_INSTALL_COMMAND,
} from '../../src/utils/routeProbe'

import { getRouteTier, ROUTE_DOT_COLORS, ROUTE_TIER_COLORS, ROUTE_TIER_NOTICE } from '../../src/utils/routeTier'

function output(carrier: string, lines: string, code = 0, method = 'icmp') {
  return `ROUTE_PROBE_CARRIER:${carrier}\nROUTE_ATTEMPT:${method}:1.2.3.4\n${lines}\nROUTE_EXIT:${code}\n`
}
for (const [asn, label] of [
  [58807, 'CMIN2'],
  [58453, 'CMI'],
  [9808, 'CMNET'],
] as const) {
  test(`mobile ${asn} maps to ${label}`, () => {
    expect(getRouteProfile('mobile', [asn, asn])).toBe(label)
    expect(getRouteProfile('mobile', [asn])).toBe(label)
  })
}
test('mixed does not receive a tier', () => {
  expect(getRouteProfile('mobile', [58807, 9808, 58807])).toBe('混合线路')
  expect(getRouteQuality('mobile', [58807, 9808, 58807])).toBe('未识别')
})
test('CN2 evidence never claims GIA', () => {
  expect(getRouteProfile('telecom', [4809, 4809])).toBe('CN2')
  expect(getRouteQuality('telecom', [4809, 4809])).toBe('优质')
})
test('single observed destination network is not transit', () => {
  expect(
    parseRouteProbeOutput(output('telecom', ' 24 1.2.3.4 [AS4134] 1 ms')).carriers.telecom.passage,
  ).toBe('')
})
test('repeated hop order and unknown positions survive', () => {
  const r = parseRouteProbeOutput(
    output(
      'mobile',
      ' 1 223.120.128.1 [AS58807]\n 2 * * *\n 3 221.183.1.1 [AS9808]\n 4 223.120.128.2 [AS58807]',
    ),
  )
  expect(r.carriers.mobile.asns).toEqual([58807, 9808, 58807])
  expect(r.carriers.mobile.attempts[0]?.hops[1]?.timeout).toBe(true)
  expect(r.carriers.mobile.state).toBe('mixed')
})
test('single observed ASN can describe passage', () => {
  expect(
    parseRouteProbeOutput(output('unicom', ' 1 8.8.8.8 [AS9929] [AS9929]')).carriers.unicom.passage,
  ).toBe('9929')
})
test('prefix boundaries and invalid IP', () => {
  expect(resolvePrefix('59.43.1.1')).toBe(4809)
  expect(resolvePrefix('59.143.1.1')).toBeUndefined()
  expect(resolvePrefix('111.240.1.1')).toBeUndefined()
  expect(resolvePrefix('223.120.190.1')).toBe(58807)
  expect(resolvePrefix('999.43.1.1')).toBeUndefined()
})
test('query-prefix conflict is source conflict, not physical mixture', () => {
  expect(
    parseRouteProbeOutput(output('mobile', ' 1 223.120.128.1 [AS9808]\n 2 223.120.128.2 [AS9808]'))
      .carriers.mobile.state,
  ).toBe('unknown')
})
test('unknown IP retains raw data, no ASN fabricated', () => {
  expect(parseHop(' 3 8.8.8.8 1 ms')?.source).toBe('none')
  expect(parseHop('traceroute to 1.2.3.4')).toBeNull()
})
test('contradictory methods retained separately', () => {
  const text
    = 'ROUTE_PROBE_CARRIER:mobile\nROUTE_ATTEMPT:icmp:1.2.3.4\n 1 8.8.8.8 [AS58807]\n 2 8.8.4.4 [AS58807]\nROUTE_EXIT:0\nROUTE_ATTEMPT:udp:1.2.3.4\n 1 8.8.8.8 [AS9808]\n 2 8.8.4.4 [AS9808]\nROUTE_EXIT:0\n'
  const r = parseRouteProbeOutput(text)
  expect(r.carriers.mobile.state).toBe('unknown')
  expect(r.carriers.mobile.notes.join(' ')).toContain('方法差异')
  expect(r.carriers.mobile.attempts).toHaveLength(2)
})
test('nonzero partial output preserved, reached and exit state recorded', () => {
  const r = parseRouteProbeOutput(
    output('unicom', ' 1 8.8.8.8 [AS9929]\n 2 1.2.3.4 [AS9929]', 124),
  )
  expect(r.carriers.unicom.label).toBe('9929')
  expect(r.carriers.unicom.attempts[0]?.exitCode).toBe(124)
  expect(r.carriers.unicom.attempts[0]?.reached).toBe(true)
  expect(r.state).not.toBe('ok')
})
test('missing tools produce explicit message', () => {
  expect(parseRouteProbeOutput('ROUTE_PROBE_ERROR:missing_traceroute').state).toBe(
    'missing_traceroute',
  )
  expect(parseRouteProbeOutput('ROUTE_PROBE_ERROR:missing_timeout').message).toBe(
    'missing_timeout',
  )
})
test('per-carrier failure preserves last success and latest attempt', () => {
  const old = parseRouteProbeOutput(
    output('mobile', ' 1 8.8.8.8 [AS58807]\n 2 8.8.4.4 [AS58807]'),
    10,
  )
  const next = parseRouteProbeOutput(
    output('unicom', ' 1 8.8.8.8 [AS9929]\n 2 8.8.4.4 [AS9929]'),
    20,
  )
  const merged = mergeRouteResult(old, next)
  expect(merged.carriers.mobile.label).toBe('CMIN2')
  expect(merged.carriers.mobile.stale).toBe(true)
  expect(merged.carriers.mobile.lastSuccess).toBe(10)
  expect(merged.carriers.mobile.lastAttempt).toBe(20)
  expect(merged.carriers.unicom.label).toBe('9929')
  expect(mergeRouteResult(merged, old).carriers.mobile.lastAttempt).toBe(20)
  const stored = parseRouteProbeMap({ node: merged }).node!
  expect(stored.carriers.mobile.stale).toBe(true)
})
test('legacy caches are not promoted from incomplete deduplicated data', () => {
  const legacy = {
    version: 1,
    testedAt: 10,
    carriers: { telecom: { asns: [4809] }, unicom: { asns: [9929] }, mobile: { asns: [9808] } },
  }
  const r = parseRouteProbeMap({ node: legacy }).node!
  expect(r.carriers.mobile.legacy).toBe(true)
  expect(r.carriers.mobile.state).toBe('failed')
  expect(parseRouteProbeMap({ a: null, b: { version: 2 } })).toEqual({})
})
test('all failure records last attempt without inventing success', () => {
  const r = failedRouteResult('HTTP timeout', 30)
  expect(r.carriers.mobile.error).toBe('HTTP timeout')
  expect(r.carriers.mobile.lastSuccess).toBeUndefined()
})
test('save queue merges nodes and preserves unrelated settings', async () => {
  const original = globalThis.fetch
  let settings: Record<string, unknown> = { other: 123, pandaOpsRouteProbeResults: {} }
  globalThis.fetch = async (url, init) => {
    await new Promise(resolve => setTimeout(resolve, 2))
    if (String(url) === '/api/public')
      return new Response(JSON.stringify({ data: { theme_settings: settings } }))
    settings = JSON.parse(String(init?.body))
    return new Response('{}')
  }
  try {
    await Promise.all([
      saveRouteProbeResults('Enhanced', { a: failedRouteResult('a', 1) }),
      saveRouteProbeResults('Enhanced', { b: failedRouteResult('b', 2) }),
    ])
    expect(Object.keys(settings.pandaOpsRouteProbeResults as object)).toEqual(['a', 'b'])
    expect(settings.other).toBe(123)
  }
  finally {
    globalThis.fetch = original
  }
})
test('shell syntax and collector execute only mocked tools (zero network)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-mock-'))
  try {
    for (const command of [ROUTE_PROBE_COMMAND, ROUTE_PROBE_INSTALL_COMMAND])
      execFileSync('sh', ['-n'], { input: command })
    writeFileSync(
      join(dir, 'traceroute'),
      `#!/bin/sh\ncase "$*" in *--help*) echo '-A ASN'; exit 0;; esac\ncase "$*" in *-I*) echo 'ICMP not permitted'; exit 1;; esac\nprintf ' 1 223.120.128.1 [AS58807] 1 ms\\n 2 223.120.128.2 [AS58807] 1 ms\\n'\n`,
      { mode: 0o700 },
    )
    writeFileSync(join(dir, 'timeout'), '#!/bin/sh\nshift; shift; shift; exec "$@"\n', {
      mode: 0o700,
    })
    const text = execFileSync('sh', ['-c', ROUTE_PROBE_COMMAND], {
      env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
      encoding: 'utf8',
    })
    const result = parseRouteProbeOutput(text)
    expect(result.carriers.mobile.label).toBe('CMIN2')
    expect(result.carriers.mobile.attempts).toHaveLength(3)
    expect(text).toContain('ROUTE_EXIT:1')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('all-star evidence is unknown', () => {
  expect(parseRouteProbeOutput(output('mobile', ' 1 * * *\n 2 * * *')).carriers.mobile.label).toBe(
    '未识别',
  )
})
test('no-ASN plain output uses marked prefix evidence', () => {
  const r = parseRouteProbeOutput(output('telecom', ' 1 59.43.1.1\n 2 59.43.2.1'))
  expect(r.carriers.telecom.label).toBe('CN2')
  expect(r.carriers.telecom.attempts[0]?.hops[0]?.source).toBe('prefix')
})
test('collector supports -A rejection and plain fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-plain-'))
  try {
    writeFileSync(
      join(dir, 'traceroute'),
      `#!/bin/sh\ncase "$*" in *--help*) echo '-A'; exit 0;; *-A*) echo 'unsupported -A'; exit 2;; esac\nprintf ' 1 59.43.1.1\\n 2 59.43.2.1\\n'\n`,
      { mode: 0o700 },
    )
    writeFileSync(join(dir, 'timeout'), '#!/bin/sh\nshift; shift; shift; exec "$@"\n', {
      mode: 0o700,
    })
    const r = parseRouteProbeOutput(
      execFileSync('sh', ['-c', ROUTE_PROBE_COMMAND], {
        env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
        encoding: 'utf8',
      }),
    )
    expect(r.carriers.telecom.attempts).toHaveLength(4)
    expect(r.carriers.telecom.label).toBe('CN2')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('collector missing traceroute exits before any probing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-missing-'))
  try {
    let text = ''
    try {
      execFileSync('/bin/sh', ['-c', ROUTE_PROBE_COMMAND], {
        env: { PATH: dir },
        encoding: 'utf8',
      })
    }
    catch (e) {
      text = (e as { stdout: string }).stdout
    }
    expect(text).toContain('ROUTE_PROBE_ERROR:missing_traceroute')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('poll ignores absent/null finished_at, accepts partial nonzero finished output', async () => {
  const { runRouteTask } = await import('../../src/services/routeProbe.service')
  const original = globalThis.fetch
  let polls = 0
  globalThis.fetch = async url =>
    String(url).endsWith('/exec')
      ? new Response('{"task_id":"fixture"}')
      : new Response(
          JSON.stringify({
            results: [
              ++polls < 3
                ? { result: 'not finished', ...(polls === 2 ? { finished_at: null } : {}) }
                : { finished_at: '2026-10-25T00:00:00Z', exit_code: 1, result: 'partial' },
            ],
          }),
        )
  try {
    expect(
      (await runRouteTask('uuid;not-shell', 'constant', 1000, new AbortController().signal, 1))
        .output,
    ).toBe('partial')
    expect(polls).toBe(3)
  }
  finally {
    globalThis.fetch = original
  }
})
test('poll cutoff rejects late finished output', async () => {
  const { runRouteTask } = await import('../../src/services/routeProbe.service')
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/exec'))
      return new Response('{"task_id":"fixture"}')
    await new Promise(resolve => setTimeout(resolve, 15))
    return new Response('{"results":[{"finished_at":"late","result":"late"}]}')
  }
  try {
    await expect(
      runRouteTask('uuid', 'constant', 5, new AbortController().signal, 1),
    ).rejects.toThrow('超时')
  }
  finally {
    globalThis.fetch = original
  }
})
test('HTTP hanging response aborts with local bound', async () => {
  const { runRouteTask } = await import('../../src/services/routeProbe.service')
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('bounded HTTP abort')), {
        once: true,
      }),
    )
  try {
    await expect(
      runRouteTask('uuid', 'constant', 100, new AbortController().signal, 1, 5),
    ).rejects.toThrow('bounded HTTP abort')
  }
  finally {
    globalThis.fetch = original
  }
})
test('failed save does not poison next queued save', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url) => {
    if (++calls === 1)
      return new Response('error', { status: 500 })
    return String(url) === '/api/public'
      ? new Response('{"data":{"theme_settings":{}}}')
      : new Response('{}')
  }
  try {
    await expect(saveRouteProbeResults('Enhanced', {})).rejects.toThrow()
    await expect(saveRouteProbeResults('Enhanced', {})).resolves.toEqual({})
  }
  finally {
    globalThis.fetch = original
  }
})

const real = JSON.parse(readFileSync(new URL('../fixtures/route-vmiss9929.json', import.meta.url), 'utf8'))
for (const [carrier, passage, landing] of [
  ['telecom', '9929', '163'],
  ['unicom', '9929', '4837'],
  ['mobile', 'CMIN2', 'CMNET'],
] as const) {
  test(`real six-attempt VMISS cache: ${carrier} ${passage} → ${landing}`, () => {
    const r = parseRouteProbeMap({ node: real }).node!.carriers[carrier]
    expect(r.attempts).toHaveLength(2)
    expect(r.passage).toBe(passage)
    expect(r.landing).toBe(landing)
    expect(r.landingConfirmed).toBe(true)
    expect(r.state).toBe('identified')
    if (carrier === 'unicom')
      expect(r.notes.join(' ')).toContain('方法差异')
    if (carrier === 'mobile')
      expect(r.notes.join(' ')).toContain('最终接入 ASN')
  })
}
function pathResult(lines: string, carrier = 'mobile', extra = '') {
  return parseRouteProbeOutput(output(carrier, lines) + extra).carriers[carrier as 'mobile']
}
test('destination-only evidence never manufactures transit', () => {
  const r = pathResult(' 1 1.2.3.4 [AS9808]')
  expect(r.passage).toBe('')
  expect(r.landing).toBe('CMNET')
})
for (const [asns, expected] of [
  [[58807, 9808], 'CMIN2'],
  [[9808, 58807], 'CMNET'],
  [[58453, 58807, 9808], 'CMI → CMIN2'],
  [[58807, 9808, 58807], 'CMIN2 → CMNET'],
] as const) {
  test(`ordered direction ${asns.join(' → ')}`, () => {
    const r = pathResult(asns.map((n, i) => ` ${i + 1} 8.8.8.${i + 1} [AS${n}]`).join('\n'))
    expect(r.passage).toBe(expected)
    expect(r.landingConfirmed).toBe(false)
  })
}
test('unknown final ASN prevents confirmed delivery even when destination replies', () => {
  const r = pathResult(' 1 8.8.8.8 [AS58807]\n 2 8.8.4.4 [AS9808]\n 3 * * *\n 4 1.2.3.4')
  expect(r.landing).toBe('CMNET')
  expect(r.landingConfirmed).toBe(false)
  expect(r.notes.join(' ')).toContain('未知')
})
test('last observed other carrier cannot be target-inferred landing', () => {
  const r = pathResult(' 1 8.8.8.8 [AS9929]\n 2 1.2.3.4 [AS4134]')
  expect(r.landing).toBe('')
  expect(r.passage).toBe('9929 → 163')
})
test('complete attempt outranks incomplete conflicting method and discloses it', () => {
  const text = 'ROUTE_PROBE_CARRIER:mobile\nROUTE_ATTEMPT:icmp:1.2.3.4\n 1 8.8.8.8 [AS58807]\n 2 1.2.3.4 [AS9808]\nROUTE_EXIT:0\nROUTE_ATTEMPT:udp:1.2.3.4\n 1 8.8.8.8 [AS58453]\n 2 * * *\nROUTE_EXIT:0\n'
  const r = parseRouteProbeOutput(text).carriers.mobile
  expect(r.passage).toBe('CMIN2')
  expect(r.landing).toBe('CMNET')
  expect(r.notes.join(' ')).toContain('方法差异')
})
test('equally complete differing methods do not select arbitrary main labels', () => {
  const text = `ROUTE_PROBE_CARRIER:mobile\n${['58807', '58453'].map((asn, i) => `ROUTE_ATTEMPT:${i ? 'udp' : 'icmp'}:1.2.3.4\n 1 8.8.8.8 [AS${asn}]\n 2 1.2.3.4 [AS9808]\nROUTE_EXIT:0\n`).join('')}`
  const r = parseRouteProbeOutput(text).carriers.mobile
  expect(r.passage).toBe('')
  expect(r.state).toBe('unknown')
  expect(r.notes.join(' ')).toContain('同等完整')
})

test('card retains passage and landing with static dots and reference tiers', () => {
  const source = readFileSync(new URL('../../src/components/NodeCard.vue', import.meta.url), 'utf8')
  const module = source.split('data-node-lines>')[1]!.split('</section>')[0]!
  expect(module).toContain('出发线路')
  expect(module).toContain('落地线路')
  expect(module).toContain('data-route-passage')
  expect(module).toContain('data-route-landing')
  expect(module).not.toContain('→')
  expect(module).toContain('data-route-dots')
  expect(module).toContain('v-for="dot in 18"')
  expect(module).toContain('route-dotted-line')
  expect(module).toContain('aria-hidden="true"')
  expect(module).toContain('data-route-tier')
  expect(module).not.toContain('animate-')
  expect(module).not.toContain('↔')
  expect(module).not.toContain('routeQuality')
  expect(module).toContain('末段 ')
})

test('valid complete method survives another source-conflicting method', () => {
  const text = 'ROUTE_PROBE_CARRIER:mobile\nROUTE_ATTEMPT:icmp:1.2.3.4\n 1 8.8.8.8 [AS58807]\n 2 1.2.3.4 [AS9808]\nROUTE_EXIT:0\nROUTE_ATTEMPT:udp:1.2.3.4\n 1 223.120.128.1 [AS9808]\nROUTE_EXIT:0\n'
  const r = parseRouteProbeOutput(text).carriers.mobile
  expect(r.passage).toBe('CMIN2')
  expect(r.landingConfirmed).toBe(true)
  expect(r.notes.join(' ')).toContain('来源冲突')
})

for (const [carrier, front, back, expected] of [
  ['telecom', 4809, 4809, '精品'],
  ['unicom', 9929, 9929, '精品'],
  ['mobile', 58807, 58807, '精品'],
  ['telecom', 9929, 4134, '优秀'],
  ['unicom', 9929, 4837, '优秀'],
  ['mobile', 58807, 9808, '优秀'],
  ['telecom', 4134, 4134, '普通'],
  ['unicom', 4837, 4837, '普通'],
  ['mobile', 58453, 9808, '普通'],
  ['mobile', 9808, 9808, '普通'],
] as const) {
  test(`reference tier matrix ${front} to ${back}: ${expected}`, () => {
    const r = parseRouteProbeOutput(output(carrier, ` 1 8.8.8.8 [AS${front}]\n 2 1.2.3.4 [AS${back}]`), 1000).carriers[carrier]
    expect(getRouteTier(carrier, r, 60000, 1001)).toBe(expected)
  })
}
for (const state of ['stale', 'legacy', 'expired', 'future', 'incomplete', 'noAttempts', 'unknown', 'conflict', 'contradiction', 'reentry'] as const) {
  test(`reference tier suppresses ${state} evidence`, () => {
    const r = parseRouteProbeOutput(output('mobile', ' 1 8.8.8.8 [AS58807]\n 2 1.2.3.4 [AS58807]'), 1000).carriers.mobile
    if (state === 'stale' || state === 'legacy')
      r[state] = true
    if (state === 'incomplete')
      r.landingConfirmed = false
    if (state === 'noAttempts')
      r.attempts = []
    if (state === 'unknown')
      r.state = 'unknown'
    if (state === 'conflict')
      r.attempts[0]!.hops[0]!.source = 'conflict'
    if (state === 'contradiction')
      r.attempts.push(parseRouteProbeOutput(output('mobile', ' 1 8.8.8.8 [AS58453]\n 2 1.2.3.4 [AS9808]'), 1000).carriers.mobile.attempts[0]!)
    if (state === 'reentry')
      r.attempts[0]!.hops.splice(1, 0, { ...r.attempts[0]!.hops[0]!, distance: 1.5, asns: [9808] })
    expect(getRouteTier('mobile', r, 60000, state === 'expired' ? 61000 : state === 'future' ? 999 : 1001)).toBe('--')
  })
}
test('premium requires complete query evidence; prefix or unknown hops cannot earn boutique', () => {
  const r = parseRouteProbeOutput(output('mobile', ' 1 8.8.8.8 [AS58807]\n 2 1.2.3.4 [AS58807]'), 1000).carriers.mobile
  r.attempts[0]!.hops[0]!.source = 'prefix'
  expect(getRouteTier('mobile', r, 60000, 1001)).toBe('优秀')
  r.attempts[0]!.hops[0]!.timeout = true
  expect(getRouteTier('mobile', r, 60000, 1001)).toBe('优秀')
  expect(getRouteTier('mobile', undefined, 60000, 1001)).toBe('--')
})
test('tier colors and wording stay distinct from measured Ping quality', () => {
  expect(ROUTE_TIER_COLORS['普通']).toBe(ROUTE_TIER_COLORS['--'])
  expect(ROUTE_DOT_COLORS['普通']).toBe('text-yellow-500')
  expect(ROUTE_DOT_COLORS['--']).toBe('text-red-500')
  expect(ROUTE_DOT_COLORS['优秀']).toBe(ROUTE_TIER_COLORS['优秀'])
  expect(ROUTE_DOT_COLORS['精品']).toBe(ROUTE_TIER_COLORS['精品'])
  expect(ROUTE_TIER_COLORS['优秀']).toContain('blue')
  expect(ROUTE_TIER_COLORS['精品']).toContain('emerald')
  expect(ROUTE_TIER_NOTICE).toContain('非带宽／延迟／丢包实测')
  expect(ROUTE_TIER_NOTICE).toContain('非 CN2 GIA 或 SLA 承诺')
})
test('route rows share a centered fixed 18-dot column and retain row tiers without a tier heading', () => {
  const source = readFileSync(new URL('../../src/components/NodeCard.vue', import.meta.url), 'utf8')
  const module = source.split('data-node-lines>')[1]!.split('</section>')[0]!
  expect(module.match(/data-route-columns/g)).toHaveLength(1)
  expect(module).toContain('class="contents text-[10px]"')
  expect(module).toContain('v-for="dot in 18" :key="dot" class="route-dot"')
  expect(module).toContain('data-route-dots="18"')
  expect(module).toContain('class="route-dotted-line" :class="ROUTE_DOT_COLORS[routeTier(carrier.key)]"')
  expect(module).toContain(':class="ROUTE_TIER_COLORS[routeTier(carrier.key)]" data-route-tier')
  expect(module).not.toContain('等级')
  expect(module).toContain('data-route-tier-header />')
  expect(module).toContain('data-route-tier>{{ routeTier(carrier.key) }}')
  expect(module).toContain(':title="routeProfileTitle(carrier.key)"')
  expect(module.split('<div v-if="routeProbeError"')[0]).not.toContain('truncate')
  expect(source).toContain('grid-template-columns: max-content max-content minmax(0, 1fr) max-content 24px')
  const cell = source.split('.route-dot-cell {')[1]!.split('}')[0]!
  expect(cell).toContain('container-type: inline-size')
  expect(cell).toContain('min-width: 0')
  expect(cell).toContain('justify-content: center')
  expect(cell).toContain('margin-inline: 4px')
  const rail = source.split('.route-dotted-line {')[1]!.split('}')[0]!
  expect(rail).toContain('flex-wrap: nowrap')
  expect(rail).toContain('justify-content: center')
  expect(rail).toContain('gap: clamp(1px, 2.8cqw, 3px)')
  expect(source).toContain('width: clamp(1px, 2.8cqw, 3px)')
  expect(source).toContain('height: clamp(1px, 2.8cqw, 3px)')
  expect(source).toContain('border-radius: 50%')
  expect(source).not.toContain('radial-gradient')
  expect(source).toContain('useTimestamp({ interval: 1000 })')
  expect(source).toContain('60_000, routeTierNow.value)')
})
test('VMISS cached evidence replay yields excellent before expiry, unrated after expiry', () => {
  const r = parseRouteProbeMap({ fixture: real }).fixture
  // Fixture replay uses the saved evidence timestamp, never claims a new probe.
  expect(r).toBeDefined()
  for (const carrier of ['telecom', 'unicom', 'mobile'] as const) {
    const c = r!.carriers[carrier]
    expect(getRouteTier(carrier, c, 60000, c.lastSuccess! + 1)).toBe('优秀')
    expect(getRouteTier(carrier, c, 60000, c.lastSuccess! + 60000)).toBe('--')
  }
})

test('tier is presentation-only with no Ping, persistence or route mutations', () => {
  const r = parseRouteProbeOutput(output('mobile', ' 1 8.8.8.8 [AS58807]\n 2 1.2.3.4 [AS9808]'), 1000).carriers.mobile
  const before = JSON.stringify(r)
  expect(getRouteTier('mobile', r, 60000, 1001)).toBe('优秀')
  expect(JSON.stringify(r)).toBe(before)
  const source = readFileSync(new URL('../../src/utils/routeTier.ts', import.meta.url), 'utf8')
  expect(source).not.toMatch(/fetch\(|localStorage|ping|latency|loss|saveRoute/i)
})

test('carrier names reserve a shared explicit gap before aligned departure labels', () => {
  const source = readFileSync(new URL('../../src/components/NodeCard.vue', import.meta.url), 'utf8')
  const module = source.split('data-node-lines>')[1]!.split('</section>')[0]!
  expect(module).toContain('class="route-carrier-cell flex min-h-7 items-center gap-1 py-1 text-muted-foreground"')
  expect(source).toContain('grid-template-columns: max-content max-content minmax(0, 1fr) max-content 24px')
  const carrier = source.split('.route-carrier-cell {')[1]!.split('}')[0]!
  expect(carrier).toContain('padding-inline-end: 2ch')
  expect(carrier).toContain('white-space: nowrap')
  expect(module).toContain('{{ carrier.label }}</span>')
  expect(module).not.toContain('&nbsp;')
})
