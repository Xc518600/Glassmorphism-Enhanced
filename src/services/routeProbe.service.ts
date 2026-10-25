import type { RouteProbeMap, RouteProbeResult } from '@/utils/routeProbe'
import { requestManager } from '@/services/request.service'
import {
  mergeRouteResult,
  parseRouteProbeMap,
  parseRouteProbeOutput,
  ROUTE_PROBE_COMMAND,
  ROUTE_PROBE_INSTALL_COMMAND,
} from '@/utils/routeProbe'

// Mutating task creation/settings saves are never retried automatically.
async function request(
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  timeout = 15_000,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted)
    controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeout)
  try {
    const response = await fetch(url, {
      credentials: 'include',
      ...init,
      signal: controller.signal,
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (body.status === 'error')
      throw new Error(typeof body.message === 'string' ? body.message : '服务端拒绝路由请求')
    if (!response.ok)
      throw new Error(`路由请求失败（HTTP ${response.status}）`)
    return body
  }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
export async function runRouteTask(
  uuid: string,
  command: string,
  budget: number,
  signal: AbortSignal,
  interval = 1000,
  httpTimeout = 15_000,
): Promise<{ output: string, exitCode: number | null }> {
  const data = await request(
    '/api/admin/task/exec',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, clients: [uuid] }),
    },
    signal,
    httpTimeout,
  )
  const taskId = data.task_id || (data.data as { task_id?: unknown } | undefined)?.task_id
  if (typeof taskId !== 'string' || !taskId)
    throw new Error('未收到远程任务ID')
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    if (signal.aborted)
      throw new Error('探测已取消')
    await new Promise(resolve => setTimeout(resolve, interval))
    if (signal.aborted)
      throw new Error('探测已取消')
    if (Date.now() >= deadline)
      break
    const result = await request(
      `/api/admin/task/${encodeURIComponent(taskId)}/result`,
      {},
      signal,
      Math.min(httpTimeout, deadline - Date.now()),
    )
    if (Date.now() >= deadline)
      break
    const rows = result.results || result.data
    if (!Array.isArray(rows))
      continue
    const finished = rows.find(
      row => row && typeof row.finished_at === 'string' && row.finished_at.length > 0,
    )
    if (finished) {
      return {
        output: typeof finished.result === 'string' ? finished.result : '',
        exitCode: typeof finished.exit_code === 'number' ? finished.exit_code : null,
      }
    }
  }
  throw new Error('路由任务等待超时；远端固定命令有独立超时限制')
}
export function executeRouteProbe(uuid: string, autoInstall = false): Promise<RouteProbeResult> {
  return requestManager.run(
    `route-probe:${uuid}:${autoInstall}`,
    async (signal) => {
      if (autoInstall) {
        const install = await runRouteTask(uuid, ROUTE_PROBE_INSTALL_COMMAND, 285_000, signal)
        if (install.exitCode !== 0)
          throw new Error('traceroute 安装失败或超时，未继续探测')
      }
      const result = await runRouteTask(uuid, ROUTE_PROBE_COMMAND, 420_000, signal)
      // Parse per-carrier evidence even when the wrapper exits nonzero.
      const parsed = parseRouteProbeOutput(result.output)
      if (!result.output.includes('ROUTE_PROBE_CARRIER:') && !parsed.message)
        throw new Error('节点没有返回结构化探测结果')
      return parsed
    },
    { timeout: autoInstall ? 740_000 : 440_000, retryAttempts: 0 },
  )
}

let saveQueue: Promise<unknown> = Promise.resolve()
/** Serialize per-node deltas, fetch latest settings inside the queue, merge each carrier. */
export function saveRouteProbeResults(theme: string, delta: RouteProbeMap): Promise<RouteProbeMap> {
  const save = saveQueue
    .catch(() => {})
    .then(async () => {
      const data = await request('/api/public', { cache: 'no-store' })
      const payload
        = data.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : data
      const current = payload.theme_settings
      if (!current || typeof current !== 'object' || Array.isArray(current))
        throw new Error('无法读取当前主题设置')
      const settings = current as Record<string, unknown>
      const merged = parseRouteProbeMap(settings.pandaOpsRouteProbeResults)
      for (const [uuid, next] of Object.entries(delta))
        merged[uuid] = mergeRouteResult(merged[uuid], next)
      await request(`/api/admin/theme/settings?theme=${encodeURIComponent(theme)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, pandaOpsRouteProbeResults: merged }),
      })
      return merged
    })
  saveQueue = save
  return save
}
