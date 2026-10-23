<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { useIntersectionObserver } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from 'vue'
import { Badge } from '@/components/ui/badge'
import { CardX } from '@/components/ui/card-x'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { ProgressThin } from '@/components/ui/progress-thin'

import { useNodeCarrierPingSource } from '@/composables/useNodeCarrierPingSource'
import { useAppStore } from '@/stores/app'
import { executeRouteProbe, saveRouteProbeResults } from '@/services/routeProbe.service'
import { getRouteProfile, getRouteQuality } from '@/utils/routeProbe'
import type { RouteCarrier, RouteProbeResult } from '@/utils/routeProbe'
import { formatBytesPerSecondWithConfig, formatBytesWithConfig, formatDateTime, getStatus, getUptimeDays } from '@/utils/helper'
import { getDiskPercentage, getMemoryPercentage, getTrafficUsed, getTrafficUsedPercentage, hasTrafficLimit } from '@/utils/nodeMetricsHelper'
import { getOSImage, getOSName } from '@/utils/osImageHelper'
import { getRegionCode, getRegionDisplayName } from '@/utils/regionHelper'
import { formatCurrencyValue, formatPriceWithCycle, getDaysUntilExpired, getExpireStatus, getRemainingValue, isFreePrice, parseTags } from '@/utils/tagHelper'

const props = withDefaults(defineProps<{
  node: NodeData
  reduceMotion?: boolean
  pingEnabled?: boolean
}>(), {
  reduceMotion: false,
  pingEnabled: true,
})
const emit = defineEmits<{
  click: []
  pingClick: []
}>()
const appStore = useAppStore()

const isFavorite = computed(() => appStore.isFavoriteNode(props.node.uuid))

function toggleFavorite(): void {
  appStore.toggleFavoriteNode(props.node.uuid)
}

function handleKeyboardOpen(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ')
    return
  event.preventDefault()
  emit('click')
}

interface RemainingInfoTag {
  icon: string
  text?: string
  prefix?: string
  value?: string
  unit?: string
  className?: string
}

const NODE_METRIC_ICONS = {
  cpu: 'tabler:cpu',
  memory: 'icon-park-outline:memory',
  disk: 'tabler:server-2',
  traffic: 'tabler:arrows-transfer-up-down',
} as const

const isMiniNodeCard = computed(() => appStore.nodeCardSize === 'mini')
const nodeCardXSize = computed(() => appStore.nodeCardSize === 'large' ? 'large' : 'medium')
const nodeCardContentClass = computed(() => appStore.nodeCardSize === 'large' ? 'gap-4' : isMiniNodeCard.value ? 'gap-2' : 'gap-3')
const nodeCardContentPaddingClass = computed(() => isMiniNodeCard.value ? 'pb-2' : '')
const nodeCardMetricGridClass = 'grid-cols-3'
const nodeCardMetricBoxClass = computed(() => isMiniNodeCard.value
  ? 'px-1 py-1'
  : appStore.nodeCardSize === 'compact' ? 'px-1.5 py-1.5' : 'px-2 py-1.5')
const formatBytes = (bytes: number) => formatBytesWithConfig(bytes, appStore.byteDecimals)
const formatBytesPerSecond = (bytes: number) => formatBytesPerSecondWithConfig(bytes, appStore.byteDecimals)
const offlineTime = computed(() => formatDateTime(props.node.time))

const cpuStatus = computed(() => getStatus(props.node.cpu ?? 0))
const memPercentage = computed(() => getMemoryPercentage(props.node))
const memStatus = computed(() => getStatus(memPercentage.value))
const swapTooltip = computed(() => {
  const used = formatBytes(Math.max(0, props.node.swap ?? 0))
  const total = Math.max(0, props.node.swap_total ?? 0)
  return total > 0 ? `Swap 已用 ${used} / 总计 ${formatBytes(total)}` : `Swap 已用 ${used}`
})
const diskPercentage = computed(() => getDiskPercentage(props.node))
const diskStatus = computed(() => getStatus(diskPercentage.value))

const pingRoot = useTemplateRef<ComponentPublicInstance>('pingRoot')
const pingVisible = ref(false)
const { isSupported } = useIntersectionObserver(
  pingRoot,
  (entries) => {
    pingVisible.value = entries.at(-1)?.isIntersecting ?? false
  },
  { rootMargin: '200px 0px' },
)
const { carrierDisplays, isTransit } = useNodeCarrierPingSource(
  () => props.node,
  () => props.pingEnabled && (!isSupported.value || pingVisible.value),
)

function carrierQuality(carrier: typeof carrierDisplays.value[number]): { label: string, className: string } {
  const latency = Number.parseFloat(carrier.latencyDisplay.replace(/[^\d.]/g, ''))
  const loss = Number.parseFloat(carrier.lossDisplay.replace(/[^\d.]/g, ''))
  if (!Number.isFinite(latency) || !Number.isFinite(loss))
    return { label: '暂无数据', className: 'text-muted-foreground' }
  if (loss <= 1 && latency <= 80)
    return { label: '优质', className: 'text-success' }
  if (loss <= 3 && latency <= 150)
    return { label: '良好', className: 'text-sky-500' }
  if (loss <= 8 && latency <= 250)
    return { label: '一般', className: 'text-warning' }
  return { label: '较差', className: 'text-destructive' }
}

const trafficUsed = computed(() => getTrafficUsed(props.node))
const trafficUsedPercentage = computed(() => getTrafficUsedPercentage(props.node))
// IPv4/IPv6 is optional in Komari's public node payload. Never invent a line
// when the agent did not report an address; the card falls back to a dash.
const selectedIpFamily = ref<'ipv4' | 'ipv6'>('ipv4')
const hasBothIpFamilies = computed(() => Boolean(props.node.ipv4?.trim() && props.node.ipv6?.trim()))
const availableIpFamily = computed(() => {
  if (selectedIpFamily.value === 'ipv4' && !props.node.ipv4?.trim() && props.node.ipv6?.trim())
    return 'ipv6'
  if (selectedIpFamily.value === 'ipv6' && !props.node.ipv6?.trim() && props.node.ipv4?.trim())
    return 'ipv4'
  return selectedIpFamily.value
})
const activeIp = computed(() => availableIpFamily.value === 'ipv4' ? props.node.ipv4 : props.node.ipv6)
const routeProbe = computed(() => appStore.routeProbeResults[props.node.uuid] as RouteProbeResult | undefined)
const routeProbeBusy = ref(false)
const routeProbeStarted = ref(false)
let routeProbeTimer: ReturnType<typeof setInterval> | undefined
const routeProbeError = ref('')
const routeProbeCarriers: Array<{ key: RouteCarrier, label: string }> = [
  { key: 'telecom', label: '电信' },
  { key: 'unicom', label: '联通' },
  { key: 'mobile', label: '移动' },
]
const routeCarrierDotClass: Record<RouteCarrier, string> = {
  telecom: 'bg-blue-500',
  unicom: 'bg-rose-500',
  mobile: 'bg-emerald-500',
}
const routeProfileText = (carrier: RouteCarrier) => {
  const result = routeProbe.value?.carriers[carrier]
  if (!result)
    return ''
  const profile = getRouteProfile(carrier, result.asns)
  return profile === '未识别' ? '' : profile
}

const routeProfileTitle = (carrier: RouteCarrier) => {
  const result = routeProbe.value?.carriers[carrier]
  return result?.route && result.route !== '—' ? `完整路径：${result.route}` : '暂无完整路径'
}

function routeQuality(carrier: RouteCarrier): { label: string, className: string } {
  const result = routeProbe.value?.carriers[carrier]
  const quality = result ? getRouteQuality(carrier, result.asns) : '未识别'
  if (quality === '未识别')
    return { label: '', className: '' }
  if (quality === '精品')
    return { label: quality, className: 'text-success' }
  if (quality === '优质')
    return { label: quality, className: 'text-sky-500' }
  if (quality === '普通')
    return { label: quality, className: 'text-warning' }
  return { label: quality, className: 'text-muted-foreground' }
}

const routeProbeStateText = computed(() => {
  const state = routeProbe.value?.state
  if (state === 'ok') return '已识别'
  if (state === 'mixed') return '混合线路'
  if (state === 'missing_traceroute') return '未安装 traceroute'
  if (state === 'remote_disabled') return '远程控制已关闭'
  if (state === 'unknown') return '未识别'
  return routeProbe.value ? '探测失败' : '未探测'
})

async function probeNodeRoute(): Promise<void> {
  if (routeProbeBusy.value || routeProbeStarted.value || !appStore.privateFeaturesAllowed)
    return
  if (!await appStore.requireLoginPermission('advancedTools'))
    return
  routeProbeStarted.value = true
  routeProbeBusy.value = true
  routeProbeError.value = ''
  try {
    const result = await executeRouteProbe(props.node.uuid, appStore.routeProbeAutoInstall)
    const recognized = Object.values(result.carriers).some(carrier => carrier.state === 'identified' || carrier.state === 'mixed')
    if (!recognized)
      throw new Error(result.state === 'missing_traceroute' ? '节点未安装 traceroute' : '未识别到运营商骨干 ASN，已保留上一次结果')
    const current = { ...appStore.routeProbeResults, [props.node.uuid]: result }
    const theme = appStore.publicSettings?.theme
    if (!theme)
      throw new Error('无法确定当前主题')
    await saveRouteProbeResults(theme, current)
    appStore.setRouteProbeResults(current)
  }
  catch (error) {
    routeProbeError.value = error instanceof Error ? error.message : '路由探测失败'
  }
  finally {
    routeProbeBusy.value = false
  }
}

onMounted(() => {
  if (!appStore.routeProbeAutoDetect || !appStore.privateFeaturesAllowed)
    return
  if (!routeProbe.value)
    void probeNodeRoute()
  routeProbeTimer = setInterval(() => {
    routeProbeStarted.value = false
    void probeNodeRoute()
  }, appStore.routeProbeIntervalMinutes * 60_000)
})

onUnmounted(() => {
  if (routeProbeTimer)
    clearInterval(routeProbeTimer)
})

const nodeMessage = computed(() => props.node.message?.trim() ?? '')
const nodeMessageTooltip = computed(() => {
  const message = nodeMessage.value
  if (!message)
    return ''
  const updatedAt = props.node.status_updated_at ? `\n更新时间：${formatDateTime(props.node.status_updated_at)}` : ''
  return `${message}${updatedAt}`
})

// 流量状态颜色
const trafficStatus = computed(() => {
  if (!hasTrafficLimit(props.node))
    return 'success'

  if (trafficUsedPercentage.value >= 95)
    return 'error'
  if (trafficUsedPercentage.value >= 80)
    return 'warning'
  if (trafficUsedPercentage.value >= 60)
    return 'info'
  return 'success'
})

const trafficPercentageClass = computed(() => {
  if (!hasTrafficLimit(props.node))
    return 'text-muted-foreground'

  if (trafficUsedPercentage.value >= 95)
    return 'text-destructive'
  if (trafficUsedPercentage.value >= 80)
    return 'text-warning'
  if (trafficUsedPercentage.value >= 60)
    return 'text-warning'
  return 'text-success'
})

// 是否显示金额：未登录且开启「未登录隐藏价格」时不显示价格 / 剩余价值，
// 但在线天数、剩余天数等非金额信息仍然展示
const showPrice = computed(() => appStore.privateFeaturesAllowed || !appStore.hidePriceWhenLoggedOut)

const uptimeDaysText = computed(() => {
  const days = getUptimeDays(props.node.uptime)
  return appStore.lang === 'zh-CN' ? `在线 ${days} 天` : `${days} days online`
})

const priceText = computed(() => {
  const node = props.node
  if (node.price === 0 || !showPrice.value)
    return ''
  return formatPriceWithCycle(node.price, node.billing_cycle, node.currency, appStore.lang)
})

// 第三列：剩余天数（始终） + 剩余价值（仅在允许显示金额时），带图标与相邻列对齐
const remainingInfoTags = computed<RemainingInfoTag[]>(() => {
  const node = props.node
  if (node.price === 0)
    return []
  const lang = appStore.lang
  const days = getDaysUntilExpired(node.expired_at)
  const status = getExpireStatus(node.expired_at)
  const items: RemainingInfoTag[] = []
  const expiryClass = status === 'expired' || status === 'critical'
    ? 'text-destructive'
    : status === 'warning' ? 'text-warning' : 'text-muted-foreground'

  if (status === 'unknown') {
    items.push({ icon: 'tabler:calendar-stats', text: '-', className: expiryClass })
  }
  else if (status === 'expired') {
    items.push({ icon: 'tabler:calendar-stats', text: lang === 'zh-CN' ? '已过期' : 'Expired', className: expiryClass })
  }
  else if (status === 'long_term') {
    items.push({ icon: 'tabler:calendar-stats', text: lang === 'zh-CN' ? '长期' : 'Long-term', className: expiryClass })
  }
  else if (lang === 'zh-CN') {
    items.push({ icon: 'tabler:calendar-stats', prefix: '剩余', value: String(days), unit: '天', className: expiryClass })
  }
  else {
    items.push({ icon: 'tabler:calendar-stats', prefix: 'left', value: String(days), unit: 'days', className: expiryClass })
  }

  if (showPrice.value) {
    const text = isFreePrice(node.price)
      ? lang === 'zh-CN' ? '无' : 'N/A'
      : formatCurrencyValue(getRemainingValue(node.price, node.billing_cycle, node.expired_at), node.currency)
    items.push({ icon: 'tabler:coins', text })
  }
  return items
})

const customTags = computed(() => parseTags(props.node.tags).map(t => t.text))

function getRegionAltText(region: string): string {
  return getRegionDisplayName(region) || getRegionCode(region)
}

function hasRegion(region: string | null | undefined): boolean {
  return Boolean(region?.trim())
}
</script>

<template>
  <CardX
    ref="pingRoot"
    hoverable
    :size="nodeCardXSize"
    :content-class="nodeCardContentPaddingClass"
    class="node-card w-full cursor-pointer border-none shadow-[0_0_0_3px] shadow-transparent transition-all duration-200 rounded-xl"
    :class="[!props.node.online && '!shadow-destructive/30']"
    role="button"
    tabindex="0"
    :aria-label="`查看节点 ${props.node.name} 详情`"
    @click="emit('click')"
    @keydown="handleKeyboardOpen"
  >
    <!-- 头部：在线点 + 名称 -->
    <template #header>
      <div class="flex items-center gap-2 min-w-0">
        <div class="relative size-2.5 shrink-0">
          <span
            class="size-2.5 rounded-full block"
            :class="props.node.online ? 'bg-success' : 'bg-destructive'"
          />
          <span
            v-if="!props.reduceMotion"
            class="animate-ping absolute inset-0 rounded-full opacity-60"
            :class="props.node.online ? 'bg-success' : 'bg-destructive'"
          />
        </div>
        <span class="text-sm font-bold flex-1 min-w-0 truncate">{{ props.node.name }}</span>
        <DataTooltip
          v-if="nodeMessage"
          :content="nodeMessageTooltip"
          placement="top"
          as="span"
          class="inline-flex shrink-0 text-amber-500"
          content-class="w-56 whitespace-pre-line leading-snug text-left"
        >
          <Icon icon="tabler:alert-triangle-filled" width="14" height="14" aria-label="节点消息" />
        </DataTooltip>
      </div>
    </template>

    <!-- 头部右侧：OS + 国旗 -->
    <template #header-extra>
      <div class="flex gap-1.5 items-center shrink-0">
        <button
          type="button"
          class="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-slate-500/10 hover:text-amber-500"
          :class="isFavorite && 'text-amber-500'"
          :aria-label="isFavorite ? `取消收藏 ${props.node.name}` : `收藏 ${props.node.name}`"
          :title="isFavorite ? '取消收藏' : '收藏节点'"
          @click.stop="toggleFavorite"
          @keydown.stop
        >
          <Icon :icon="isFavorite ? 'tabler:star-filled' : 'tabler:star'" width="14" height="14" />
        </button>
        <img :src="getOSImage(props.node.os)" :alt="getOSName(props.node.os)" class="size-4">
        <img
          v-if="hasRegion(props.node.region)"
          :src="`/images/flags/${getRegionCode(props.node.region)}.svg`"
          :alt="getRegionAltText(props.node.region)"
          class="size-5 shrink-0"
        >
      </div>
    </template>

    <template #default>
      <div class="flex flex-col relative" :class="nodeCardContentClass">
        <!-- 在线天数固定展示，价格独立展示，避免不同主机卡片高度不一致 -->
        <div class="relative z-20 flex items-center gap-1.5 -mt-1 h-[19px] overflow-hidden">
          <span class="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-slate-500/10 text-muted-foreground leading-tight">
            {{ uptimeDaysText }}
          </span>
          <span
            v-if="priceText"
            class="min-w-0 truncate text-[11px] px-2 py-0.5 rounded-full bg-slate-500/10 text-muted-foreground leading-tight"
          >
            {{ priceText }}
          </span>
        </div>

        <!-- 四项进度条 -->
        <div v-if="isMiniNodeCard" class="grid grid-cols-[3fr_2fr] gap-x-4 gap-y-2">
          <div class="grid grid-cols-2 gap-x-3 gap-y-1">
            <div class="flex flex-col gap-1">
              <div class="flex justify-between text-xs">
                <span class="inline-flex items-center text-sky-500" role="img" title="CPU" aria-label="CPU">
                  <Icon :icon="NODE_METRIC_ICONS.cpu" data-node-metric-icon="cpu" width="12" height="12" aria-hidden="true" />
                </span>
                <span class="tabular-nums font-medium">{{ (props.node.cpu ?? 0).toFixed(1) }}%</span>
              </div>
              <ProgressThin :percentage="props.node.cpu ?? 0" :status="cpuStatus" :height="4" />
            </div>

            <div class="flex flex-col gap-1" :title="swapTooltip">
              <div class="flex justify-between text-xs">
                <span class="inline-flex items-center text-emerald-500" role="img" title="内存" aria-label="内存">
                  <Icon :icon="NODE_METRIC_ICONS.memory" data-node-metric-icon="memory" width="12" height="12" aria-hidden="true" />
                </span>
                <span class="tabular-nums font-medium">{{ memPercentage.toFixed(1) }}%</span>
              </div>
              <ProgressThin :percentage="memPercentage" :status="memStatus" :height="4" />
            </div>

            <div class="col-span-2 text-[11px] text-muted-foreground truncate">
              {{ formatBytes(props.node.ram ?? 0) }} / {{ formatBytes(props.node.mem_total ?? 0) }}
            </div>
          </div>

          <div class="flex flex-col gap-1">
            <div class="flex justify-between text-xs">
              <span class="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
                <Icon :icon="NODE_METRIC_ICONS.traffic" data-node-metric-icon="traffic" width="12" height="12" class="shrink-0 text-violet-500" aria-hidden="true" />
                <span class="truncate">流量</span>
              </span>
              <span class="tabular-nums font-medium" :class="trafficPercentageClass">
                {{ hasTrafficLimit(props.node) ? `${trafficUsedPercentage.toFixed(1)}%` : '∞' }}
              </span>
            </div>
            <ProgressThin v-if="hasTrafficLimit(props.node)" :percentage="trafficUsedPercentage" :status="trafficStatus" :height="4" />
            <div class="text-[11px] truncate" data-machine-traffic :class="trafficUsedPercentage >= 95 ? 'text-destructive' : 'text-muted-foreground'">
              {{ formatBytes(trafficUsed) }}
              <template v-if="hasTrafficLimit(props.node)">
                / {{ formatBytes(props.node.traffic_limit) }}
              </template>
              <template v-else>
                / ∞
              </template>
            </div>
          </div>
        </div>

        <div v-else class="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <!-- CPU -->
          <div class="flex flex-col gap-1">
            <div class="flex justify-between text-xs">
              <span class="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
                <Icon :icon="NODE_METRIC_ICONS.cpu" data-node-metric-icon="cpu" width="13" height="13" class="shrink-0 text-sky-500" aria-hidden="true" />
                <span class="truncate">CPU</span>
              </span>
              <span class="tabular-nums font-medium">{{ (props.node.cpu ?? 0).toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="props.node.cpu ?? 0" :status="cpuStatus" :height="4" />
            <div class="text-[11px] text-muted-foreground truncate">
              {{ (props.node.load ?? 0).toFixed(2) }}, {{ (props.node.load5 ?? 0).toFixed(2) }}, {{ (props.node.load15 ?? 0).toFixed(2) }}
            </div>
          </div>

          <!-- 内存 -->
          <div class="flex flex-col gap-1" :title="swapTooltip">
            <div class="flex justify-between text-xs">
              <span class="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
                <Icon :icon="NODE_METRIC_ICONS.memory" data-node-metric-icon="memory" width="13" height="13" class="shrink-0 text-emerald-500" aria-hidden="true" />
                <span class="truncate">内存</span>
              </span>
              <span class="tabular-nums font-medium">{{ memPercentage.toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="memPercentage" :status="memStatus" :height="4" />
            <div class="text-[11px] text-muted-foreground truncate">
              {{ formatBytes(props.node.ram ?? 0) }} / {{ formatBytes(props.node.mem_total ?? 0) }}
            </div>
          </div>

          <!-- 硬盘 -->
          <div class="flex flex-col gap-1">
            <div class="flex justify-between text-xs">
              <span class="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
                <Icon :icon="NODE_METRIC_ICONS.disk" data-node-metric-icon="disk" width="13" height="13" class="shrink-0 text-orange-500" aria-hidden="true" />
                <span class="truncate">硬盘</span>
              </span>
              <span class="tabular-nums font-medium">{{ diskPercentage.toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="diskPercentage" :status="diskStatus" :height="4" />
            <div class="text-[11px] text-muted-foreground truncate">
              {{ formatBytes(props.node.disk ?? 0) }} / {{ formatBytes(props.node.disk_total ?? 0) }}
            </div>
          </div>

          <!-- 流量（分级颜色） -->
          <div class="flex flex-col gap-1">
            <div class="flex justify-between text-xs">
              <span class="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
                <Icon :icon="NODE_METRIC_ICONS.traffic" data-node-metric-icon="traffic" width="13" height="13" class="shrink-0 text-violet-500" aria-hidden="true" />
                <span class="truncate">流量</span>
              </span>
              <span class="tabular-nums font-medium" :class="trafficPercentageClass">
                {{ hasTrafficLimit(props.node) ? `${trafficUsedPercentage.toFixed(1)}%` : '∞' }}
              </span>
            </div>
            <ProgressThin v-if="hasTrafficLimit(props.node)" :percentage="trafficUsedPercentage" :status="trafficStatus" :height="4" />
            <div class="text-[11px] truncate" data-machine-traffic :class="trafficUsedPercentage >= 95 ? 'text-destructive' : 'text-muted-foreground'">
              {{ formatBytes(trafficUsed) }}
              <template v-if="hasTrafficLimit(props.node)">
                / {{ formatBytes(props.node.traffic_limit) }}
              </template>
              <template v-else>
                / ∞
              </template>
            </div>
          </div>
        </div>

        <!-- 网络概览：实时速率、累计流量与配额信息 -->
        <section class="flex flex-col gap-1 rounded-lg bg-slate-500/5 p-1.5" data-network-overview>
          <div class="text-[11px] text-muted-foreground">网络概览</div>
        <div class="grid gap-1.5" :class="nodeCardMetricGridClass">
          <!-- 实时网速 -->
          <div class="flex flex-col gap-0.5 rounded-lg bg-slate-500/5 min-w-0 overflow-hidden" :class="nodeCardMetricBoxClass">
            <div class="text-[11px] text-success flex items-center gap-1">
              <Icon icon="tabler:chevron-up" width="11" height="11" />
              <span class="truncate min-w-0 overflow-hidden">{{ formatBytesPerSecond(props.node.net_out ?? 0) }}</span>
            </div>
            <div class="text-[11px] text-blue-600 flex items-center gap-1">
              <Icon icon="tabler:chevron-down" width="11" height="11" />
              <span class="truncate min-w-0 overflow-hidden">{{ formatBytesPerSecond(props.node.net_in ?? 0) }}</span>
            </div>
          </div>

          <!-- 总流量 -->
          <div class="flex flex-col gap-0.5 rounded-lg bg-slate-500/5 min-w-0 overflow-hidden" :class="nodeCardMetricBoxClass">
            <div class="text-[11px] text-muted-foreground flex items-center gap-1" data-machine-direction="up">
              <Icon icon="tabler:upload" width="11" height="11" />
              <span class="truncate min-w-0 overflow-hidden">{{ formatBytes(props.node.net_total_up ?? 0) }}</span>
            </div>
            <div class="text-[11px] text-muted-foreground flex items-center gap-1" data-machine-direction="down">
              <Icon icon="tabler:download" width="11" height="11" />
              <span class="truncate min-w-0 overflow-hidden">{{ formatBytes(props.node.net_total_down ?? 0) }}</span>
            </div>
          </div>

          <!-- 第三列：有价格显示剩余天数+价格，否则显示负载 -->
          <div class="flex flex-col gap-0.5 rounded-lg bg-slate-500/5 min-w-0 overflow-hidden" :class="nodeCardMetricBoxClass">
            <template v-if="remainingInfoTags.length">
              <div
                v-for="(item, i) in remainingInfoTags" :key="i"
                class="text-[11px] flex items-center gap-0.5"
                :class="item.className ?? 'text-muted-foreground'"
              >
                <Icon :icon="item.icon" width="11" height="11" class="shrink-0" />
                <span v-if="item.text" class="truncate min-w-0 overflow-hidden">{{ item.text }}</span>
                <template v-else>
                  <span v-if="item.prefix" class="shrink-0">{{ item.prefix }}</span>
                  <span v-if="item.value" class="shrink-0 tabular-nums">{{ item.value }}</span>
                  <span v-if="item.unit" class="shrink-0">{{ item.unit }}</span>
                </template>
              </div>
            </template>
            <template v-else>
              <div class="text-[11px] text-muted-foreground truncate">
                {{ (props.node.load ?? 0).toFixed(2) }}
              </div>
              <div class="text-[11px] text-muted-foreground truncate">
                {{ (props.node.load5 ?? 0).toFixed(2) }} / {{ (props.node.load15 ?? 0).toFixed(2) }}
              </div>
            </template>
          </div>
        </div>
        </section>

        <!-- 回程线路需要路由探测数据；Ping 目标与延迟不能推断 CN2/9929/CMIN2 -->
        <section class="flex flex-col gap-1 rounded-lg bg-slate-500/5 p-1.5" data-node-lines>
          <div class="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>三网线路</span>
          </div>
          <div v-for="carrier in routeProbeCarriers" :key="`${carrier.key}-route`" class="grid min-h-7 min-w-0 grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-1.5 py-1 text-[10px]">
            <span class="flex w-10 shrink-0 items-center gap-1 text-muted-foreground"><span class="size-1.5 rounded-full" :class="routeCarrierDotClass[carrier.key]" />{{ carrier.label }}</span>
            <span class="min-w-0 flex-1 truncate text-muted-foreground" :title="routeProfileTitle(carrier.key)">{{ routeProfileText(carrier.key) }}</span>
            <span v-if="routeQuality(carrier.key).label" class="shrink-0 text-[9px]" :class="routeQuality(carrier.key).className">{{ routeQuality(carrier.key).label }}</span>
          </div>
          <div v-if="routeProbeError" class="truncate text-[10px] text-destructive" :title="routeProbeError">{{ routeProbeError }}</div>
        </section>

        <!-- 三网质量：历史分条来自实际 Ping 记录，标签由平均延迟和丢包率计算 -->
        <section class="flex flex-col gap-1 rounded-lg bg-slate-500/5 p-1.5" data-network-quality>
          <div class="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>三网质量</span><span class="text-[10px]">{{ isTransit ? '中转估算' : 'Ping 记录' }}</span>
          </div>
          <div v-for="carrier in carrierDisplays" :key="`${carrier.key}-quality`" class="grid min-h-7 grid-cols-[40px_minmax(0,1fr)_38px_34px] items-center gap-1.5 py-1 text-[10px]">
            <span class="flex items-center gap-1 text-muted-foreground"><span class="size-1.5 rounded-full" :class="carrier.dotClass" />{{ carrier.label }}</span>
            <div class="grid h-2 min-w-0 items-stretch gap-px" :style="{ gridTemplateColumns: `repeat(${carrier.latencyBars.length}, minmax(0, 1fr))` }">
              <DataTooltip v-for="bar in carrier.latencyBars" :key="bar.key" placement="top" :content="bar.tooltip" class="h-full w-full">
                <span class="block h-full w-full rounded-[1px]" :class="bar.className" />
              </DataTooltip>
            </div>
            <span class="text-right tabular-nums">{{ carrier.lossDisplay }}</span>
            <span class="text-right tabular-nums" :class="carrierQuality(carrier).className">{{ carrier.latencyDisplay }}</span>
          </div>
        </section>

        <!-- 自定义标签 -->
        <div v-if="customTags.length > 0" class="flex flex-wrap gap-1">
          <Badge
            v-for="(tag, i) in customTags" :key="i"
            variant="outline"
            class="!text-[11px] rounded-full text-muted-foreground border-muted-foreground/15 px-2 py-0"
          >
            {{ tag }}
          </Badge>
        </div>

        <!-- 离线遮罩 -->
        <div
          v-if="!props.node.online"
          class="absolute inset-0 flex flex-col items-center justify-center z-10 rounded-xl bg-white/20 dark:bg-black/20 backdrop-blur-[2px]"
        >
          <div class="text-sm font-semibold text-destructive">
            离线
          </div>
          <div class="text-[11px] text-muted-foreground mt-1">
            {{ offlineTime }}
          </div>
        </div>
      </div>
    </template>
  </CardX>
</template>

<style scoped>
.node-card {
  position: relative;
  overflow: hidden;
}
</style>
