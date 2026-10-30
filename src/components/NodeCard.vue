<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { NodeData } from '@/stores/nodes'
import type { RouteCarrier } from '@/utils/routeProbe'
import { Icon } from '@iconify/vue'
import { useIntersectionObserver, useTimestamp } from '@vueuse/core'
import { computed, ref, useTemplateRef } from 'vue'
import { Badge } from '@/components/ui/badge'
import { CardX } from '@/components/ui/card-x'
import { DataTooltip } from '@/components/ui/data-tooltip'

import { ProgressThin } from '@/components/ui/progress-thin'
import { useNodeCarrierPingSource } from '@/composables/useNodeCarrierPingSource'
import { useNodeRouteProbe } from '@/composables/useNodeRouteProbe'
import { useAppStore } from '@/stores/app'
import { formatBytesPerSecondWithConfig, formatBytesWithConfig, formatDateTime, getStatus, getUptimeDays } from '@/utils/helper'
import { getDiskPercentage, getMemoryPercentage, getTrafficUsed, getTrafficUsedPercentage, hasTrafficLimit } from '@/utils/nodeMetricsHelper'
import { getOSImage, getOSName } from '@/utils/osImageHelper'
import { getRegionCode, getRegionDisplayName } from '@/utils/regionHelper'
import { getRouteTier, ROUTE_DOT_COLORS, ROUTE_TIER_COLORS, ROUTE_TIER_NOTICE } from '@/utils/routeTier'
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

const NUMERIC_DISPLAY_RE = /[^\d.]/g
function carrierQuality(carrier: typeof carrierDisplays.value[number]): { label: string, className: string } {
  const latency = Number.parseFloat(carrier.latencyDisplay.replace(NUMERIC_DISPLAY_RE, ''))
  const loss = Number.parseFloat(carrier.lossDisplay.replace(NUMERIC_DISPLAY_RE, ''))
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
const _hasBothIpFamilies = computed(() => Boolean(props.node.ipv4?.trim() && props.node.ipv6?.trim()))
const availableIpFamily = computed(() => {
  if (selectedIpFamily.value === 'ipv4' && !props.node.ipv4?.trim() && props.node.ipv6?.trim())
    return 'ipv6'
  if (selectedIpFamily.value === 'ipv6' && !props.node.ipv6?.trim() && props.node.ipv4?.trim())
    return 'ipv4'
  return selectedIpFamily.value
})
const _activeIp = computed(() => availableIpFamily.value === 'ipv4' ? props.node.ipv4 : props.node.ipv6)
const { routeProbe, routeProbeError } = useNodeRouteProbe(() => props.node.uuid)
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
const routeTierNow = useTimestamp({ interval: 1000 })
// Single front label: multi-hop passages keep the acting backbone only.
function routePassageLabel(carrier: RouteCarrier) {
  const passage = routeProbe.value?.carriers[carrier].passage
  if (!passage)
    return '--'
  const legs = passage.split(' → ').filter(Boolean)
  return legs.at(-1) || '--'
}
function routeTier(carrier: RouteCarrier) {
  return getRouteTier(carrier, routeProbe.value?.carriers[carrier], undefined, routeTierNow.value)
}
function routeProfileTitle(carrier: RouteCarrier) {
  const result = routeProbe.value?.carriers[carrier]
  if (!result)
    return `暂无路由证据\n${ROUTE_TIER_NOTICE}`
  const success = result.lastSuccess ? new Date(result.lastSuccess).toLocaleString() : '暂无'
  const attempt = new Date(result.lastAttempt).toLocaleString()
  const aged = result.lastSuccess && Date.now() - result.lastSuccess > appStore.routeProbeIntervalMinutes * 60_000
  const evidence = [...result.attempts, ...(result.latestAttempts || [])].map(a => `${a.method} → ${a.target} / exit=${a.exitCode ?? '未知'} / ${a.reached ? '已到达' : '未确认到达'}\n${a.hops.map(h => `${h.distance}: ${h.ips.join(', ') || '*'} [${h.asns.map(n => `AS${n}`).join(', ') || 'ASN未知'}; ${h.source}]${h.timeout ? ' *' : ''}`).join('\n')}`).join('\n')
  return `${ROUTE_TIER_NOTICE}；当前参考：${routeTier(carrier)}\n${result.notes.join('；')}\n已识别 ASN 证据：${result.route}\n上次有效：${success}\n最近尝试：${attempt}\n${result.stale || aged ? '旧结果／待刷新；' : ''}${result.error || ''}\n出发线路为观测到的前段骨干，不是机器接入商；落地线路为国内最后识别骨干／交付网，实际末端接入 ASN 见下方逐跳证据\n服务器 → 指定国内目标；不代表双向或全国线路\n${evidence}`
}

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
          <div class="text-[11px] text-muted-foreground">
            网络概览
          </div>
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
          <div class="route-columns grid items-center gap-y-1" data-route-columns>
            <div class="contents text-[9px] text-muted-foreground">
              <span /><span>出发线路</span><span aria-hidden="true" /><span class="pr-1.5">落地线路</span><span class="text-right" data-route-tier-header />
            </div>
            <div v-for="carrier in routeProbeCarriers" :key="`${carrier.key}-route`" class="contents text-[10px]" :title="routeProfileTitle(carrier.key)" data-route-row>
              <span class="route-carrier-cell flex min-h-7 items-center gap-1 py-1 text-muted-foreground"><span class="size-1.5 shrink-0 rounded-full" :class="routeCarrierDotClass[carrier.key]" />{{ carrier.label }}</span>
              <span class="flex min-h-7 items-center whitespace-nowrap py-1 text-muted-foreground" data-route-passage>{{ routePassageLabel(carrier.key) }}</span>
              <span class="route-dot-cell" aria-hidden="true">
                <span class="route-dotted-line" :class="ROUTE_DOT_COLORS[routeTier(carrier.key)]" data-route-dots="18">
                  <span v-for="dot in 18" :key="dot" class="route-dot" />
                </span>
              </span>
              <span class="flex min-h-7 items-center whitespace-nowrap py-1 pr-1.5 text-muted-foreground" data-route-landing>{{ routeProbe?.carriers[carrier.key].landing || '--' }}</span>
              <span class="min-h-7 whitespace-nowrap py-1 text-right" :class="ROUTE_TIER_COLORS[routeTier(carrier.key)]" data-route-tier>{{ routeTier(carrier.key) }}</span>
            </div>
          </div>
          <div v-if="routeProbeError" class="truncate text-[10px] text-destructive" :title="routeProbeError">
            {{ routeProbeError }}
          </div>
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
/* Shared intrinsic text columns keep all three fixed dot groups aligned. */
.route-columns {
  grid-template-columns: max-content max-content minmax(0, 1fr) max-content 24px;
}
/* Reserve real breathing room after carrier names without spacing text characters. */
.route-carrier-cell {
  padding-inline-end: 2ch;
  white-space: nowrap;
}
.route-dot-cell {
  container-type: inline-size;
  display: flex;
  min-width: 0;
  justify-content: center;
  align-items: center;
  margin-inline: 4px;
}
.route-dotted-line {
  display: flex;
  flex-wrap: nowrap;
  justify-content: center;
  gap: clamp(1px, 2.8cqw, 3px);
}
.route-dot {
  flex: 0 0 auto;
  width: clamp(1px, 2.8cqw, 3px);
  height: clamp(1px, 2.8cqw, 3px);
  border-radius: 50%;
  background-color: currentColor;
}
</style>
