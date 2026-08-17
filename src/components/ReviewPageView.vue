<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowLeftBold, ArrowRightBold, Location, Search, WarningFilled } from '@element-plus/icons-vue'
import type { DesignFile, ReviewIssue } from '../types'
import IssueEditor from './IssueEditor.vue'

const props = defineProps<{
  files: DesignFile[]
  issues: ReviewIssue[]
  activeIssueId: string
  readonly: boolean
  loading: string
}>()
const emit = defineEmits<{
  select: [id: string]
  save: [issue: ReviewIssue, body: object]
}>()

const drawerOpen = ref(true)
const currentFileId = ref(props.files[0]?.id || '')
const query = ref('')
const iframeRefs = new Map<string, HTMLIFrameElement>()
const locateTimers = new Set<number>()
const frameObservers = new Map<string, MutationObserver>()
const frameResizeObservers = new Map<string, ResizeObserver>()
const frameClickHandlers = new Map<string, (event: Event) => void>()
const frameScrollHandlers = new Map<string, (event: Event) => void>()
const frameHeights = ref<Record<string, number>>({})
const frameWidths = ref<Record<string, number>>({})
const frameNaturalHeights = ref<Record<string, number>>({})
const frameNaturalWidths = ref<Record<string, number>>({})
const frameScales = ref<Record<string, number>>({})
const frameStages = ref<Record<string, string>>({})
const frameHasStages = ref<Record<string, boolean>>({})
const issueStages = ref<Record<string, string>>({})
const pendingFrameFocusIssueId = ref('')
const anchorPositions = ref<Record<string, { x: number; y: number; accurate: boolean; anchorKey?: string; stageName?: string }>>({})
const minimumCoordinateConfidence = 0.55

const currentFile = computed(() => props.files.find(file => file.id === currentFileId.value) || props.files[0])
const imageFiles = computed(() => props.files.filter(file => !file.extension.includes('htm')).map(file => file.url))

function cleanPageName(value = '') {
  return value.toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[\s·_\-—:：]/g, '')
}

function issuePageName(issue: ReviewIssue) {
  const explicit = issue.annotation?.pageFileName || issue.annotation?.pageName
  if (explicit) return explicit
  return issue.detail.match(/设计页面[：:]\s*([^。；;\n]+)/)?.[1]?.trim() || ''
}

function belongsToFile(issue: ReviewIssue, file: DesignFile) {
  const page = cleanPageName(issuePageName(issue))
  if (!page) return file.id === props.files[0]?.id
  const fileName = cleanPageName(file.name)
  return page.includes(fileName) || fileName.includes(page)
}

const visibleIssues = computed(() => {
  if (!currentFile.value) return []
  const matched = props.issues.filter(issue => belongsToFile(issue, currentFile.value!))
  const source = props.files.length === 1 ? props.issues : (matched.length ? matched : (currentFile.value.id === props.files[0]?.id ? props.issues.filter(issue => !issuePageName(issue)) : []))
  const keyword = query.value.trim().toLowerCase()
  return keyword ? source.filter(issue => `${issue.title}${issue.detail}${issue.type}`.toLowerCase().includes(keyword)) : source
})

function issueNumber(issue: ReviewIssue) {
  return props.issues.findIndex(item => item.id === issue.id) + 1
}

function coordinatePercent(value: unknown) {
  const coordinate = Number(value)
  if (!Number.isFinite(coordinate)) return undefined
  return Math.abs(coordinate) <= 1 ? coordinate * 100 : coordinate
}

function baseMarkerPosition(issue: ReviewIssue) {
  const anchored = anchorPositions.value[issue.id]
  if (anchored) return anchored
  const fileId = currentFile.value?.id || ''
  if (frameHasStages.value[fileId]) return null
  const annotation = issue.annotation
  const confidence = Number(annotation?.confidence)
  const coordinateTrusted = !Number.isFinite(confidence) || confidence >= minimumCoordinateConfidence
  if (annotation && coordinateTrusted && Number.isFinite(annotation.x) && Number.isFinite(annotation.y)) {
    if (annotation.coordinateMode === 'pixel') {
      const frame = iframeRefs.get(currentFile.value?.id || '')
      const width = frame?.contentDocument?.documentElement.scrollWidth || frame?.clientWidth || 1
      const height = frame?.contentDocument?.documentElement.scrollHeight || frame?.clientHeight || 1
      return { x: Math.min(98, Math.max(2, Number(annotation.x) / width * 100)), y: Math.min(98, Math.max(2, Number(annotation.y) / height * 100)), accurate: true }
    }
    const x = coordinatePercent(annotation.x)
    const y = coordinatePercent(annotation.y)
    if (x === undefined || y === undefined) return null
    return { x: Math.min(98, Math.max(2, x)), y: Math.min(98, Math.max(2, y)), accurate: true }
  }
  return null
}

function markerPosition(issue: ReviewIssue) {
  const base = baseMarkerPosition(issue)
  if (!base) return null
  const currentStage = frameStages.value[currentFile.value?.id || '']
  if (base.stageName && currentStage && base.stageName !== currentStage) return null
  const cluster = visibleIssues.value.filter(item => {
    const candidate = baseMarkerPosition(item)
    if (!candidate) return false
    if (base.anchorKey && candidate.anchorKey && base.anchorKey === candidate.anchorKey) return true
    return Math.abs(candidate.x - base.x) < 3 && Math.abs(candidate.y - base.y) < 5
  })
  if (cluster.length <= 1) return base
  const index = cluster.findIndex(item => item.id === issue.id)
  const angle = index / cluster.length * Math.PI * 2 - Math.PI / 2
  const fileId = currentFile.value?.id || ''
  const width = Math.max(1, frameNaturalWidths.value[fileId] || 1200)
  const height = Math.max(1, frameNaturalHeights.value[fileId] || 900)
  const radiusPixels = Math.min(30, 18 + cluster.length * 2)
  return {
    x: Math.min(98, Math.max(2, base.x + Math.cos(angle) * radiusPixels / width * 100)),
    y: Math.min(98, Math.max(2, base.y + Math.sin(angle) * radiusPixels / height * 100)),
    accurate: base.accurate,
  }
}

const locatedIssues = computed(() => visibleIssues.value.filter(issue => Boolean(markerPosition(issue))))
const otherStageIssueCount = computed(() => {
  const currentStage = frameStages.value[currentFile.value?.id || '']
  if (!currentStage) return 0
  return visibleIssues.value.filter(issue => issueStages.value[issue.id] && issueStages.value[issue.id] !== currentStage).length
})
const unlocatedIssueCount = computed(() => visibleIssues.value.length - locatedIssues.value.length - otherStageIssueCount.value)
const locationAlertText = computed(() => {
  const parts: string[] = []
  if (otherStageIssueCount.value) parts.push(`${otherStageIssueCount.value} 条意见位于其他画面，点击左侧意见可自动切换`)
  if (unlocatedIssueCount.value) parts.push(`${unlocatedIssueCount.value} 条意见缺少唯一、可靠的定位，仅保留在左侧列表中`)
  return parts.join('；')
})

function textCandidates(issue: ReviewIssue) {
  const quoted = [...`${issue.title} ${issue.detail}`.matchAll(/[“‘'\"]([^”’'\"]{2,24})[”’'\"]/g)].map(match => match[1])
  return [issue.annotation?.anchorText, ...quoted, issue.title]
    .filter(Boolean)
    .map(value => String(value).trim())
    .filter(value => value.length >= 2)
    .filter((value, index, values) => values.indexOf(value) === index)
}

function normalizedText(value = '') {
  return value.replace(/[\s：:，,。；;（）()【】\[\]「」『』“”‘’'\"\/／+＋·•]/g, '').toLowerCase()
}

function pixsoPageItems(document: Document) {
  return Array.from(document.querySelectorAll<HTMLElement>('.left-sider-list .list-item'))
    .filter(element => element.offsetParent !== null && elementText(element).trim())
}

function pixsoPageName(issue: ReviewIssue, pageItems: HTMLElement[]) {
  const expected = cleanPageName(issuePageName(issue))
  if (!expected) return ''
  return pageItems.map(element => elementText(element).trim()).find(name => {
    const candidate = cleanPageName(name)
    return candidate === expected || candidate.includes(expected) || expected.includes(candidate)
  }) || ''
}

function numberFlexibleMatch(text: string, candidate: string) {
  if (!/\d/.test(candidate)) return false
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+')
  return new RegExp(`^${escaped}$`).test(text)
}

function elementText(element: HTMLElement) {
  return `${element.getAttribute('data-review-anchor') || ''}${element.innerText || element.textContent || ''}${element.getAttribute('aria-label') || ''}${element.getAttribute('placeholder') || ''}`
}

function elementIsVisible(element: HTMLElement) {
  return !element.hidden && !element.closest('[hidden]') && element.offsetParent !== null
}

function designFrameName(element: HTMLElement) {
  return element.closest<HTMLElement>('.design-frame[data-page-name]')?.dataset.pageName || ''
}

function issueElements(issue: ReviewIssue, elements: HTMLElement[]) {
  const expected = cleanPageName(issuePageName(issue))
  if (!expected) return elements
  const scoped = elements.filter(element => {
    const frameName = cleanPageName(designFrameName(element))
    return frameName && (frameName === expected || frameName.includes(expected) || expected.includes(frameName))
  })
  return scoped.length ? scoped : elements
}

function annotationDistance(issue: ReviewIssue, element: HTMLElement) {
  const expectedX = coordinatePercent(issue.annotation?.x)
  const expectedY = coordinatePercent(issue.annotation?.y)
  if (expectedX === undefined || expectedY === undefined) return Number.POSITIVE_INFINITY
  const surface = element.closest<SVGSVGElement>('svg') || element.closest<HTMLElement>('.design-frame')
  if (!surface) return Number.POSITIVE_INFINITY
  const surfaceRect = surface.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  if (!surfaceRect.width || !surfaceRect.height) return Number.POSITIVE_INFINITY
  const actualX = (elementRect.left + elementRect.width / 2 - surfaceRect.left) / surfaceRect.width * 100
  const actualY = (elementRect.top + elementRect.height / 2 - surfaceRect.top) / surfaceRect.height * 100
  return Math.hypot(actualX - expectedX, actualY - expectedY)
}

function visibleTargetFor(element: HTMLElement) {
  if (elementIsVisible(element)) return element
  const field = element.closest<HTMLElement>('.form-row,[data-required-select],.form-item,.el-form-item')
  if (!field || field.closest('[hidden]')) return undefined
  return Array.from(field.querySelectorAll<HTMLElement>('.select-trigger,input:not([type="hidden"]),select,textarea,[role="combobox"],button'))
    .find(elementIsVisible)
}

function stageNameFor(element: HTMLElement) {
  return element.closest<HTMLElement>('.stage')?.id.replace(/^stage-/, '') || ''
}

function stagePreferenceScore(issue: ReviewIssue, stageName: string) {
  const title = issue.title
  const primaryLocation = issue.detail.match(/位置[：:]\s*([^；;。]+)/)?.[1] || ''
  const detail = issue.detail
  const anchorText = issue.annotation?.anchorText || ''
  const keywords: Record<string, string[]> = {
    list: ['列表', '筛选', '表头'],
    create: ['创建', '名称字段', '资源实例'],
    edit: ['修改'],
    copy: ['复制'],
    scope: ['采集范围'],
    delete: ['删除确认', '删除'],
    enable: ['开启确认', '开启'],
    pause: ['暂停确认', '暂停'],
  }
  return (keywords[stageName] || []).reduce((score, keyword) => {
    return score + (anchorText.includes(keyword) ? 12 : 0) + (title.startsWith(keyword) ? 9 : 0) + (title.includes(keyword) ? 5 : 0) + (primaryLocation.includes(keyword) ? 7 : 0) + (detail.includes(keyword) ? 1 : 0)
  }, 0)
}

function domStageForView(viewName: string) {
  if (viewName === 'edit' || viewName === 'copy') return 'create'
  if (viewName === 'pause') return 'enable'
  return viewName
}

function issueViewName(issue: ReviewIssue, domStageName: string, availableViews: string[]) {
  const compatible = availableViews.filter(viewName => domStageForView(viewName) === domStageName)
  if (!compatible.length) return domStageName
  const scored = compatible.map(viewName => ({ viewName, score: stagePreferenceScore(issue, viewName) }))
  const bestScore = Math.max(...scored.map(item => item.score))
  const best = scored.filter(item => item.score === bestScore)
  if (bestScore > 0 && best.length === 1) return best[0].viewName
  return compatible.includes(domStageName) ? domStageName : compatible[0]
}

function findIssueTarget(issue: ReviewIssue, elements: HTMLElement[]) {
  const candidates = issueElements(issue, elements)
  for (const candidate of textCandidates(issue)) {
    const normalizedCandidate = normalizedText(candidate)
    if (!normalizedCandidate) continue
    const matches = candidates.map(element => {
      const text = normalizedText(elementText(element))
      if (!text) return null
      const exact = text === normalizedCandidate
      const numberFlexible = numberFlexibleMatch(text, normalizedCandidate)
      const contains = normalizedCandidate.length >= 4 && text.includes(normalizedCandidate)
      if (!exact && !numberFlexible && !contains) return null
      return {
        element,
        stageName: stageNameFor(element),
        score: (exact ? 1000 : numberFlexible ? 900 : 500) + Math.min(100, normalizedCandidate.length),
      }
    }).filter(Boolean) as Array<{ element: HTMLElement; stageName: string; score: number }>
    if (!matches.length) continue
    const bestTextScore = Math.max(...matches.map(match => match.score))
    const bestTextMatches = matches.filter(match => match.score === bestTextScore)
    const bestStageScore = Math.max(...bestTextMatches.map(match => stagePreferenceScore(issue, match.stageName)))
    const preferred = bestStageScore > 0
      ? bestTextMatches.filter(match => stagePreferenceScore(issue, match.stageName) === bestStageScore)
      : bestTextMatches
    if (preferred.length === 1) return preferred[0]
    const leafMatches = preferred.filter(match => !preferred.some(other => other !== match && match.element.contains(other.element)))
    if (leafMatches.length === 1) return leafMatches[0]
    const positioned = leafMatches
      .map(match => ({ match, distance: annotationDistance(issue, match.element) }))
      .filter(item => Number.isFinite(item.distance))
      .sort((left, right) => left.distance - right.distance)
    if (positioned.length) return positioned[0].match
  }
  return null
}

function locateInFrame(file: DesignFile) {
  const frame = iframeRefs.get(file.id)
  const document = frame?.contentDocument
  if (!frame || !document) return
  const root = document.documentElement
  root.style.removeProperty('zoom')
  const stages = Array.from(document.querySelectorAll<HTMLElement>('.stage'))
  const visibleStage = stages.find(stage => !stage.hidden && stage.offsetParent !== null)
  const naturalWidth = Math.max(1, frameNaturalWidths.value[file.id] || 0, root.scrollWidth, document.body?.scrollWidth || 0, frame.clientWidth)
  const visibleStageBottom = visibleStage
    ? visibleStage.getBoundingClientRect().bottom + (document.defaultView?.scrollY || root.scrollTop || 0)
    : 0
  const naturalHeight = stages.length
    ? Math.max(1, root.scrollHeight, visibleStageBottom, frame.clientHeight)
    : Math.max(1, root.scrollHeight, document.body?.scrollHeight || 0, frame.clientHeight)
  const scrollContainer = frame.closest<HTMLElement>('.annotated-page-scroll')
  const availableWidth = Math.max(1, (scrollContainer?.clientWidth || frame.clientWidth) - 36)
  const contentScale = Math.min(1, availableWidth / naturalWidth)
  const visualWidth = naturalWidth * contentScale
  const measuredHeight = naturalHeight * contentScale
  frameNaturalWidths.value = { ...frameNaturalWidths.value, [file.id]: naturalWidth }
  frameNaturalHeights.value = { ...frameNaturalHeights.value, [file.id]: naturalHeight }
  frameScales.value = { ...frameScales.value, [file.id]: contentScale }
  frameWidths.value = { ...frameWidths.value, [file.id]: visualWidth }
  frameHeights.value = { ...frameHeights.value, [file.id]: measuredHeight }
  const pixsoFrame = document.querySelector<HTMLElement>('.container-mark')
  const pixsoPages = pixsoPageItems(document)
  const hasStructuredAnchors = Boolean(document.querySelector('[data-review-anchor]'))
  const selectedPixsoPage = pixsoPages.find(element => element.classList.contains('selected'))
  const selectedPixsoPageName = selectedPixsoPage ? elementText(selectedPixsoPage).trim() : ''
  const activeView = document.querySelector<HTMLElement>('.review-bar [data-stage].is-active')?.dataset.stage
  const availableViews = [...new Set(Array.from(document.querySelectorAll<HTMLElement>('.review-bar [data-stage]')).map(element => element.dataset.stage || '').filter(Boolean))]
  frameHasStages.value = { ...frameHasStages.value, [file.id]: stages.length > 0 || pixsoPages.length > 0 || hasStructuredAnchors }
  frameStages.value = { ...frameStages.value, [file.id]: selectedPixsoPageName || activeView || visibleStage?.id.replace(/^stage-/, '') || '' }
  const selector = stages.length
    ? '.stage *'
    : '[data-review-anchor],h1,h2,h3,h4,h5,h6,p,button,a,label,th,td,input,select,textarea,[role="button"],[aria-label]'
  const searchRoot = pixsoFrame || document.body
  const elements = Array.from(searchRoot?.querySelectorAll(selector) || [])
    .filter(element => Boolean((element as HTMLElement).tagName) && Boolean(elementText(element as HTMLElement).trim()))
    .slice(0, 6000) as HTMLElement[]
  const next = { ...anchorPositions.value }
  const nextIssueStages = { ...issueStages.value }
  let focusedIssue: ReviewIssue | undefined
  const issuesForFile = props.files.length === 1 ? props.issues : props.issues.filter(item => belongsToFile(item, file))
  for (const issue of issuesForFile) {
    const match = findIssueTarget(issue, elements)
    const viewName = pixsoPages.length
      ? pixsoPageName(issue, pixsoPages)
      : match?.stageName ? issueViewName(issue, match.stageName, availableViews) : ''
    if (viewName) nextIssueStages[issue.id] = viewName
    else delete nextIssueStages[issue.id]
    const target = match?.element ? visibleTargetFor(match.element) : undefined
    const viewIsVisible = !viewName || viewName === frameStages.value[file.id]
    const targetIsVisible = target && viewIsVisible
    if (target && targetIsVisible) {
      if (pendingFrameFocusIssueId.value === issue.id) {
        target.scrollIntoView({ block: 'center', inline: 'center' })
        pendingFrameFocusIssueId.value = ''
        focusedIssue = issue
      }
      const rect = target.getBoundingClientRect()
      const width = Math.max(1, naturalWidth)
      const scrollX = document.defaultView?.scrollX || root.scrollLeft || 0
      const scrollY = document.defaultView?.scrollY || root.scrollTop || 0
      const centerX = rect.left + scrollX + rect.width / 2
      const centerY = rect.top + scrollY + rect.height / 2
      if (centerX >= 0 && centerX <= width && centerY >= 0 && centerY <= naturalHeight) {
        next[issue.id] = {
          x: centerX / width * 100,
          y: centerY / naturalHeight * 100,
          accurate: true,
          anchorKey: `${viewName || 'page'}:${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`,
          stageName: viewName,
        }
      } else {
        delete next[issue.id]
      }
    } else if (pixsoFrame && viewIsVisible && issue.annotation?.coordinateMode !== 'pixel') {
      const x = coordinatePercent(issue.annotation?.x)
      const y = coordinatePercent(issue.annotation?.y)
      const confidence = Number(issue.annotation?.confidence)
      if (x === undefined || y === undefined || (Number.isFinite(confidence) && confidence < minimumCoordinateConfidence)) {
        delete next[issue.id]
        continue
      }
      const rect = pixsoFrame.getBoundingClientRect()
      const centerX = rect.left + rect.width * Math.min(100, Math.max(0, x)) / 100
      const centerY = rect.top + rect.height * Math.min(100, Math.max(0, y)) / 100
      next[issue.id] = {
        x: centerX / naturalWidth * 100,
        y: centerY / naturalHeight * 100,
        accurate: true,
        anchorKey: `${viewName || 'page'}:${Math.round(centerX)}:${Math.round(centerY)}`,
        stageName: viewName,
      }
    } else delete next[issue.id]
  }
  issueStages.value = nextIssueStages
  anchorPositions.value = next
  if (focusedIssue) nextTick(() => scrollToIssue(focusedIssue!, 0))
}

function scheduleLocate(file: DesignFile) {
  setupFrameTracking(file)
  locateInFrame(file)
  for (const delay of [300, 1000, 2200]) {
    const timer = window.setTimeout(() => {
      locateTimers.delete(timer)
      locateInFrame(file)
      syncActiveIssue(file)
    }, delay)
    locateTimers.add(timer)
  }
}

function setupFrameTracking(file: DesignFile) {
  const frame = iframeRefs.get(file.id)
  const document = frame?.contentDocument
  if (!frame || !document?.body) return
  frameObservers.get(file.id)?.disconnect()
  const observer = new MutationObserver(() => {
    const timer = window.setTimeout(() => { locateTimers.delete(timer); locateInFrame(file) }, 0)
    locateTimers.add(timer)
  })
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['hidden'] })
  frameObservers.set(file.id, observer)

  frameResizeObservers.get(file.id)?.disconnect()
  const resizeObserver = new ResizeObserver(() => {
    const timer = window.setTimeout(() => { locateTimers.delete(timer); locateInFrame(file) }, 0)
    locateTimers.add(timer)
  })
  const previewContainer = frame.closest<HTMLElement>('.annotated-page-scroll')
  if (previewContainer) resizeObserver.observe(previewContainer)
  frameResizeObservers.set(file.id, resizeObserver)

  const previousHandler = frameClickHandlers.get(file.id)
  if (previousHandler) document.removeEventListener('click', previousHandler)
  const clickHandler = () => {
    for (const delay of [80, 260]) {
      const timer = window.setTimeout(() => { locateTimers.delete(timer); locateInFrame(file) }, delay)
      locateTimers.add(timer)
    }
  }
  document.addEventListener('click', clickHandler)
  frameClickHandlers.set(file.id, clickHandler)

  const previousScrollHandler = frameScrollHandlers.get(file.id)
  if (previousScrollHandler) document.removeEventListener('scroll', previousScrollHandler, true)
  const scrollHandler = () => {
    const timer = window.setTimeout(() => { locateTimers.delete(timer); locateInFrame(file) }, 0)
    locateTimers.add(timer)
  }
  document.addEventListener('scroll', scrollHandler, true)
  frameScrollHandlers.set(file.id, scrollHandler)
}

function setFrameRef(file: DesignFile, element: unknown) {
  if (element instanceof HTMLIFrameElement) iframeRefs.set(file.id, element)
}

function previewUrl(file: DesignFile) {
  return file.extension.includes('htm') ? `/api/design-files/${encodeURIComponent(file.id)}/preview` : file.url
}

function activateIssueStage(issue: ReviewIssue, file: DesignFile) {
  const document = iframeRefs.get(file.id)?.contentDocument
  if (!document) return false
  let stageName = issueStages.value[issue.id]
  const stages = Array.from(document.querySelectorAll<HTMLElement>('.stage'))
  if (stages.length) {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('.stage *'))
      .filter(element => elementText(element).trim())
      .slice(0, 6000)
    const match = findIssueTarget(issue, elements)
    const availableViews = [...new Set(Array.from(document.querySelectorAll<HTMLElement>('.review-bar [data-stage]')).map(element => element.dataset.stage || '').filter(Boolean))]
    const resolvedStage = match?.stageName ? issueViewName(issue, match.stageName, availableViews) : ''
    if (resolvedStage) {
      stageName = resolvedStage
      issueStages.value = { ...issueStages.value, [issue.id]: resolvedStage }
    }
  }
  const activeView = document.querySelector<HTMLElement>('.review-bar [data-stage].is-active')?.dataset.stage
  const visibleStage = stages.find(stage => !stage.hidden)?.id.replace(/^stage-/, '')
  const currentStage = activeView || visibleStage || ''
  if (!stageName || currentStage === stageName) {
    if (currentStage) frameStages.value = { ...frameStages.value, [file.id]: currentStage }
    return false
  }
  const button = Array.from(document?.querySelectorAll<HTMLElement>('.review-bar [data-stage]') || [])
    .find(element => element.dataset.stage === stageName && !element.dataset.nameDemo && !element.dataset.listDemo && !element.dataset.pickerDemo)
  const pixsoPage = pixsoPageItems(document)
    .find(element => cleanPageName(elementText(element)) === cleanPageName(stageName))
  const target = button || pixsoPage
  if (!target) return false
  target.click()
  frameStages.value = { ...frameStages.value, [file.id]: stageName }
  return true
}

function scrollToIssue(issue: ReviewIssue, delay = 0) {
  const timer = window.setTimeout(() => {
    locateTimers.delete(timer)
    const marker = document.getElementById(`review-marker-${issue.id}`)
    if (!marker) return
    const view = marker.closest<HTMLElement>('.el-scrollbar__view')
    const wrap = view?.parentElement
    if (wrap && wrap.scrollHeight > wrap.clientHeight) {
      const markerRect = marker.getBoundingClientRect()
      const wrapRect = wrap.getBoundingClientRect()
      const top = wrap.scrollTop + markerRect.top - wrapRect.top - wrap.clientHeight / 2 + markerRect.height / 2
      wrap.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      return
    }
    marker.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
  }, delay)
  locateTimers.add(timer)
}

function syncActiveIssue(file: DesignFile) {
  const issue = props.issues.find(item => item.id === props.activeIssueId)
  if (!issue || (props.files.length > 1 && !belongsToFile(issue, file))) return
  const stageName = issueStages.value[issue.id]
  const targetIsReady = anchorPositions.value[issue.id] && (!stageName || frameStages.value[file.id] === stageName)
  if (targetIsReady) return
  pendingFrameFocusIssueId.value = issue.id
  const switched = activateIssueStage(issue, file)
  if (!switched) locateInFrame(file)
  scrollToIssue(issue, switched ? 340 : 80)
}

function selectIssue(issue: ReviewIssue) {
  emit('select', issue.id)
  pendingFrameFocusIssueId.value = issue.id
  const file = currentFile.value
  if (!file) return
  const isHtml = file.extension.includes('htm')
  const switched = isHtml && activateIssueStage(issue, file)
  if (isHtml && !switched) locateInFrame(file)
  nextTick(() => scrollToIssue(issue, switched ? 340 : 80))
}

function selectFile(file: DesignFile) {
  currentFileId.value = file.id
  nextTick(() => { if (file.extension.includes('htm')) locateInFrame(file) })
}

watch(() => props.files, files => {
  if (!files.some(file => file.id === currentFileId.value)) currentFileId.value = files[0]?.id || ''
}, { immediate: true })

watch(() => props.activeIssueId, id => {
  const issue = props.issues.find(item => item.id === id)
  if (!issue) return
  pendingFrameFocusIssueId.value = issue.id
  const file = props.files.length === 1 ? props.files[0] : props.files.find(item => belongsToFile(issue, item))
  if (file && file.id !== currentFileId.value) selectFile(file)
  else if (file?.extension.includes('htm')) {
    const switched = activateIssueStage(issue, file)
    if (!switched) locateInFrame(file)
    scrollToIssue(issue, switched ? 340 : 80)
  }
})

onBeforeUnmount(() => {
  frameObservers.forEach(observer => observer.disconnect())
  frameObservers.clear()
  frameResizeObservers.forEach(observer => observer.disconnect())
  frameResizeObservers.clear()
  frameClickHandlers.forEach((handler, fileId) => iframeRefs.get(fileId)?.contentDocument?.removeEventListener('click', handler))
  frameClickHandlers.clear()
  frameScrollHandlers.forEach((handler, fileId) => iframeRefs.get(fileId)?.contentDocument?.removeEventListener('scroll', handler, true))
  frameScrollHandlers.clear()
  iframeRefs.clear()
  locateTimers.forEach(timer => window.clearTimeout(timer))
  locateTimers.clear()
})
</script>

<template>
  <el-card shadow="never" class="page-review-card">
    <template #header>
      <div class="card-header page-review-header">
        <div><span class="eyebrow">ANNOTATED PAGE VIEW</span><h2>页面问题标注</h2><p>点击标注点查看并处理对应评审问题。</p></div>
        <el-space wrap>
          <el-tag type="danger" effect="plain">{{ issues.length }} 个问题</el-tag>
          <el-select v-if="files.length > 1" :model-value="currentFile?.id" style="width: 220px" @change="id => selectFile(files.find(item => item.id === id)!)">
            <el-option v-for="file in files" :key="file.id" :label="`${file.order}. ${file.name}`" :value="file.id" />
          </el-select>
        </el-space>
      </div>
    </template>

    <el-alert v-if="!files.length" title="当前评审没有可展示的设计页面" type="warning" :closable="false" show-icon />
    <div v-else class="page-review-shell" :class="{ 'is-drawer-closed': !drawerOpen }">
      <el-card shadow="never" class="page-issue-drawer">
        <template #header>
          <div class="drawer-title">
            <div><strong>评审问题</strong><span>{{ visibleIssues.length }} 条</span></div>
            <el-button circle text :icon="ArrowLeftBold" aria-label="收起问题列表" @click="drawerOpen = false" />
          </div>
        </template>
        <div class="drawer-search"><el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索问题" /></div>
        <el-scrollbar height="640px">
          <el-menu :default-active="activeIssueId" class="annotation-issue-menu" @select="id => selectIssue(issues.find(item => item.id === id)!)">
            <el-menu-item v-for="issue in visibleIssues" :key="issue.id" :index="issue.id">
              <el-badge :value="issueNumber(issue)" :type="issue.severity === 'high' ? 'danger' : 'warning'" />
              <div><strong>{{ issue.title }}</strong><span>{{ issue.type }} · {{ issue.disposition === 'pending' ? '待处理' : '已处理' }}</span></div>
            </el-menu-item>
          </el-menu>
        </el-scrollbar>
      </el-card>

      <el-button v-if="!drawerOpen" class="drawer-open-button" type="primary" :icon="ArrowRightBold" @click="drawerOpen = true">评审问题 {{ visibleIssues.length }}</el-button>

      <div class="annotated-page-stage">
        <div class="annotated-page-toolbar">
          <el-space><el-icon><Location /></el-icon><strong>{{ currentFile?.name }}</strong></el-space>
          <el-tag type="info" effect="plain">标注点与问题编号一一对应</el-tag>
        </div>
        <el-alert v-if="locationAlertText" class="annotation-location-alert" :title="locationAlertText" type="warning" :closable="false" show-icon />
        <el-scrollbar class="annotated-page-scroll" height="720px">
          <div v-if="currentFile" class="annotation-canvas" :class="{ 'is-html': currentFile.extension.includes('htm') }" :style="currentFile.extension.includes('htm') && frameWidths[currentFile.id] ? { width: `${frameWidths[currentFile.id]}px`, height: `${frameHeights[currentFile.id]}px` } : undefined">
            <iframe
              v-if="currentFile.extension.includes('htm')"
              :ref="element => setFrameRef(currentFile!, element)"
              :src="previewUrl(currentFile)"
              :title="currentFile.name"
              scrolling="auto"
              :style="{
                width: `${frameNaturalWidths[currentFile.id] || 1280}px`,
                height: `${frameNaturalHeights[currentFile.id] || 720}px`,
                transform: `scale(${frameScales[currentFile.id] || 1})`,
              }"
              @load="scheduleLocate(currentFile)"
            />
            <el-image v-else :src="currentFile.url" :preview-src-list="imageFiles" fit="contain" />

            <el-popover v-for="issue in locatedIssues" :key="issue.id" placement="right-start" :width="480" trigger="click" popper-class="annotation-popover">
              <template #reference>
                <el-button
                  :id="`review-marker-${issue.id}`"
                  circle
                  type="danger"
                  class="review-marker"
                  :class="{ 'is-active': issue.id === activeIssueId, 'is-estimated': !markerPosition(issue)!.accurate }"
                  :style="{ left: `${markerPosition(issue)!.x}%`, top: `${markerPosition(issue)!.y}%` }"
                  @click="emit('select', issue.id)"
                >{{ issueNumber(issue) }}</el-button>
              </template>
              <div class="annotation-detail-title"><el-icon color="#d9545d"><WarningFilled /></el-icon><div><span>问题 #{{ issueNumber(issue) }}</span><strong>{{ issue.title }}</strong></div></div>
              <IssueEditor :issue="issue" :readonly="readonly" :loading="loading === issue.id" @save="body => emit('save', issue, body)" />
            </el-popover>
          </div>
        </el-scrollbar>
      </div>
    </div>
  </el-card>
</template>
