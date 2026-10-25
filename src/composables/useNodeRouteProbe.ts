import { computed, onMounted, onUnmounted, ref } from 'vue'
import { executeRouteProbe, saveRouteProbeResults } from '@/services/routeProbe.service'
import { useAppStore } from '@/stores/app'
import { CARRIERS, failedRouteResult, mergeRouteResult } from '@/utils/routeProbe'

export function useNodeRouteProbe(uuid: () => string) {
  const app = useAppStore()
  const result = computed(() => app.routeProbeResults?.[uuid()])
  const busy = ref(false)
  const error = ref('')
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
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
  onMounted(() => {
    if (!app.routeProbeAutoDetect || !app.privateFeaturesAllowed)
      return
    const old = result.value
    if (
      !old
      || CARRIERS.some(
        c =>
          old.carriers[c].legacy
          || old.carriers[c].stale
          || Date.now() - (old.carriers[c].lastSuccess || 0) >= app.routeProbeIntervalMinutes * 60_000,
      )
    ) {
      void probe()
    }
    timer = setInterval(() => {
      void probe()
    }, app.routeProbeIntervalMinutes * 60_000)
  })
  onUnmounted(() => {
    disposed = true
    if (timer)
      clearInterval(timer)
  })
  return { routeProbe: result, routeProbeError: error }
}
