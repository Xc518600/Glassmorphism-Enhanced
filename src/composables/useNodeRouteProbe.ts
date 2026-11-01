import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  executeRouteProbe,
  fetchPluginRouteProbeResults,
  saveRouteProbeResults,
} from '@/services/routeProbe.service'
import { useAppStore } from '@/stores/app'
import { CARRIERS, failedRouteResult, mergeRouteResult } from '@/utils/routeProbe'
import type { RouteProbeMap } from '@/utils/routeProbe'

export function useNodeRouteProbe(uuid: () => string) {
  const app = useAppStore()
  const result = computed(() => app.routeProbeResults?.[uuid()])
  const busy = ref(false)
  const error = ref('')
  let timer: ReturnType<typeof setInterval> | undefined
  let staggerTimeout: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  // 拉取面板插件快照并并入本地展示；插件不存在时静默退化为原有行为。
  async function adoptPluginSnapshot(): Promise<RouteProbeMap | null> {
    const map = await fetchPluginRouteProbeResults().catch(() => null)
    if (!map || disposed)
      return null
    const current = { ...app.routeProbeResults }
    for (const [node, value] of Object.entries(map))
      current[node] = mergeRouteResult(current[node], value)
    app.setRouteProbeResults(current)
    return map
  }
  async function probe() {
    if (busy.value || disposed || !app.routeProbeAutoDetect || !app.privateFeaturesAllowed)
      return
    busy.value = true
    error.value = ''
    const id = uuid()
    try {
      if (!(await app.requireLoginPermission('advancedTools')) || disposed)
        return
      let next
      try {
        next = await executeRouteProbe(id, app.routeProbeAutoInstall)
      }
      catch (e) {
        next = failedRouteResult(e instanceof Error ? e.message : '采集失败')
      }
      const merged = mergeRouteResult(app.routeProbeResults[id], next)
      // Display successful evidence/failed attempt state even if persistence fails.
      app.setRouteProbeResults({ ...app.routeProbeResults, [id]: merged })
      const theme = app.publicSettings?.theme
      if (!theme)
        throw new Error('无法确定当前主题；本次结果未保存')
      const saved = await saveRouteProbeResults(theme, { [id]: next })
      // Do not replace another card's newer local, not-yet-persisted evidence.
      const current = { ...app.routeProbeResults }
      for (const [node, value] of Object.entries(saved))
        current[node] = mergeRouteResult(current[node], value)
      app.setRouteProbeResults(current)
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : '结果保存失败'
    }
    finally {
      busy.value = false
    }
  }
  function isFresh() {
    const old = result.value
    return Boolean(
      old
      && !CARRIERS.some(
        c =>
          old.carriers[c].legacy
          || old.carriers[c].stale
          || Date.now() - (old.carriers[c].lastSuccess || 0) >= app.routeProbeIntervalMinutes * 60_000,
      ),
    )
  }
  function startTimer() {
    if (timer)
      clearInterval(timer)
    // Recreated on each pass so interval setting changes apply without a reload.
    timer = setInterval(() => {
      if (!isFresh())
        void probe()
    }, app.routeProbeIntervalMinutes * 60_000)
  }
  // 插件接管期间周期性刷新：数据来自服务端定时探测，页面只读不写。
  let snapshotTimer: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    // 优先采用服务端插件快照：不需要登录态，也不需要有人把页面挂着。
    void adoptPluginSnapshot().then((map) => {
      if (disposed)
        return
      // 插件在线即由服务端接管：只轮询快照，不再发起浏览器端 traceroute。
      if (map !== null) {
        snapshotTimer = setInterval(() => { void adoptPluginSnapshot() }, 5 * 60_000)
        return
      }
      if (!app.routeProbeAutoDetect || !app.privateFeaturesAllowed)
        return
      // Stagger by node to avoid a mount burst of parallel traceroute tasks.
      // Deterministic per UUID keeps refreshes stable instead of re-rolling.
      let stagger = 0
      const id = uuid()
      for (const ch of id)
        stagger = (stagger * 31 + ch.charCodeAt(0)) % 60_000
      staggerTimeout = setTimeout(() => {
        if (disposed || !isFresh())
          return
        void probe()
      }, stagger)
      startTimer()
    })
  })
  onUnmounted(() => {
    disposed = true
    if (snapshotTimer)
      clearInterval(snapshotTimer)
    if (timer)
      clearInterval(timer)
    if (staggerTimeout)
      clearTimeout(staggerTimeout)
  })
  return { routeProbe: result, routeProbeError: error }
}
