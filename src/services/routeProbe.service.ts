import type { RouteProbeMap, RouteProbeResult } from '@/utils/routeProbe'
import { parseRouteProbeOutput, ROUTE_PROBE_COMMAND, ROUTE_PROBE_INSTALL_COMMAND } from '@/utils/routeProbe'

interface ExecTaskResponse {
  success?: boolean
  task_id?: string
  status?: string
  data?: { task_id?: string }
  message?: string
}

interface ExecTaskResult {
  result?: string
  exit_code?: number | null
  finished_at?: string | null
}

interface ExecResultsResponse {
  success?: boolean
  results?: ExecTaskResult[]
  status?: string
  data?: ExecTaskResult[]
  message?: string
}

function getTaskId(data: ExecTaskResponse): string | undefined {
  return data.task_id || data.data?.task_id
}

function getResults(data: ExecResultsResponse): ExecTaskResult[] {
  return data.results || data.data || []
}

async function jsonOrEmpty(response: Response): Promise<Record<string, unknown>> {
  return await response.json().catch(() => ({})) as Record<string, unknown>
}

/**
 * Run only the compile-time fixed route probe. The UUID is sent as an API
 * client selector and is never interpolated into the shell command.
 */
export async function executeRouteProbe(uuid: string, autoInstall = false, signal?: AbortSignal): Promise<RouteProbeResult> {
  const response = await fetch('/api/admin/task/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ command: autoInstall ? ROUTE_PROBE_INSTALL_COMMAND : ROUTE_PROBE_COMMAND, clients: [uuid] }),
    signal,
  })
  const data = await jsonOrEmpty(response) as ExecTaskResponse
  if (!response.ok || !getTaskId(data))
    throw new Error(typeof data.message === 'string' ? data.message : `远程探测请求失败（HTTP ${response.status}）`)

  const taskId = getTaskId(data) as string
  const deadline = Date.now() + 70_000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const resultResponse = await fetch(`/api/admin/task/${encodeURIComponent(taskId)}/result`, { credentials: 'include', signal })
    const resultData = await jsonOrEmpty(resultResponse) as ExecResultsResponse
    if (!resultResponse.ok)
      throw new Error(typeof resultData.message === 'string' ? resultData.message : `读取探测结果失败（HTTP ${resultResponse.status}）`)
    const results = getResults(resultData)
    const result = results.find(item => item.finished_at !== null) || results[0]
    if (!result)
      continue
    if (result.finished_at === null)
      continue
    const output = typeof result.result === 'string' ? result.result : ''
    if (result.exit_code !== 0 && !output.includes('ROUTE_PROBE_ERROR:missing_traceroute'))
      throw new Error(output.trim() || '节点未返回有效探测结果')
    return parseRouteProbeOutput(output)
  }
  throw new Error('路由探测超时')
}

export async function saveRouteProbeResults(theme: string, results: RouteProbeMap, signal?: AbortSignal): Promise<void> {
  const settingsResponse = await fetch('/api/public', { cache: 'no-store', credentials: 'include', signal })
  const publicData = await jsonOrEmpty(settingsResponse)
  // Komari REST API returns { status, message, data: { theme_settings } }.
  // Some compatible deployments expose the payload directly, so accept both
  // shapes without treating the response envelope as the settings object.
  const payload = publicData.data && typeof publicData.data === 'object' && !Array.isArray(publicData.data)
    ? publicData.data as Record<string, unknown>
    : publicData
  const current = payload.theme_settings
  if (!settingsResponse.ok || !current || typeof current !== 'object' || Array.isArray(current))
    throw new Error('无法读取当前主题设置')
  const response = await fetch(`/api/admin/theme/settings?theme=${encodeURIComponent(theme)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ ...(current as Record<string, unknown>), pandaOpsRouteProbeResults: results }),
    signal,
  })
  if (!response.ok)
    throw new Error(`保存路由探测结果失败（HTTP ${response.status}）`)
}
