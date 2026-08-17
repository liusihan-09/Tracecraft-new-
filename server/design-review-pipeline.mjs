import fs from 'node:fs'
import path from 'node:path'
import { extractCompetitorEvidence } from './competitor-evidence.mjs'
import { rawRequirementExtractionPrompt } from './skills/raw-requirement-evidence.prompt.mjs'

const MAX_FRAMES = 20
const MAX_TEXT_ITEMS = 600
const MAX_COMPONENT_ITEMS = 300
const MAX_HTML_SIGNALS = 600
const MAX_MODEL_TEXT_CHARS = 260_000
const REVIEW_CONCURRENCY = 2

const asArray = (value) => Array.isArray(value) ? value : []
const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim()
const round = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : undefined

function compactBox(value, rootBox) {
  if (!value) return undefined
  return {
    x: round(value.x - (rootBox?.x || 0)),
    y: round(value.y - (rootBox?.y || 0)),
    width: round(value.width),
    height: round(value.height),
  }
}

function colorHex(fill) {
  const color = fill?.color
  if (!color) return ''
  const channel = (value) => Math.max(0, Math.min(255, Math.round(Number(value || 0) * 255))).toString(16).padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

function readQuotedAssignment(source, variableName) {
  const marker = source.indexOf(variableName)
  if (marker < 0) return ''
  const equal = source.indexOf('=', marker + variableName.length)
  if (equal < 0) return ''
  let start = equal + 1
  while (/\s/.test(source[start] || '')) start += 1
  const quote = source[start]
  if (!['"', "'"].includes(quote)) return ''
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (!escaped && character === quote) return source.slice(start + 1, index)
    escaped = !escaped && character === '\\'
    if (character !== '\\') escaped = false
  }
  return ''
}

function readObjectAssignment(source, variableName) {
  const marker = source.indexOf(variableName)
  if (marker < 0) return null
  const equal = source.indexOf('=', marker + variableName.length)
  const start = source.indexOf('{', equal + 1)
  if (equal < 0 || start < 0) return null
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (!escaped && character === quote) quote = ''
      escaped = !escaped && character === '\\'
      if (character !== '\\') escaped = false
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(source.slice(start, index + 1))
    }
  }
  return null
}

function meaningfulPath(names) {
  return names.filter((name) => name && !/^(编组|容器|矩形|Frame|Group|图层|路径|直线|椭圆|多边形|星形)[\s\d_-]*$/i.test(name)).slice(-4).join(' > ')
}

function collectPixsoFrame(frame, fallbackName) {
  const rootBox = frame.absoluteBoundingBox || {}
  const typeCounts = {}
  const textMap = new Map()
  const componentMap = new Map()
  const colorCounts = new Map()
  const sections = []
  const interactions = []
  let visibleNodeCount = 0

  const addColor = (fill) => {
    if (fill?.visible === false || fill?.type !== 'SOLID') return
    const value = colorHex(fill)
    if (value) colorCounts.set(value, (colorCounts.get(value) || 0) + 1)
  }

  const walk = (node, ancestors = [], parentVisible = true, depth = 0) => {
    if (!node || typeof node !== 'object') return
    const visible = parentVisible && node.visible !== false
    if (!visible) return
    visibleNodeCount += 1
    typeCounts[node.type || 'UNKNOWN'] = (typeCounts[node.type || 'UNKNOWN'] || 0) + 1
    asArray(node.fills).forEach(addColor)
    const name = cleanText(node.name)
    const nextAncestors = name ? [...ancestors, name] : ancestors

    if (depth === 1 && ['FRAME', 'GROUP', 'INSTANCE'].includes(node.type) && sections.length < 180) {
      sections.push({ name: name || node.type, type: node.type, box: compactBox(node.absoluteBoundingBox, rootBox) })
    }

    if (node.type === 'TEXT') {
      const value = cleanText(node.characters || node.name)
      if (value) {
        const context = meaningfulPath(ancestors)
        const key = `${value}|${context}|${round(node.style?.fontSize)}|${node.style?.fontWeight || ''}`
        const existing = textMap.get(key)
        if (existing) existing.count += 1
        else if (textMap.size < MAX_TEXT_ITEMS) {
          textMap.set(key, {
            text: value,
            context,
            count: 1,
            box: compactBox(node.absoluteBoundingBox, rootBox),
            fontSize: round(node.style?.fontSize),
            fontWeight: node.style?.fontWeight,
            color: colorHex(asArray(node.style?.fills)[0] || asArray(node.fills)[0]) || undefined,
          })
        }
      }
    }

    if (node.type === 'INSTANCE') {
      const component = cleanText(node.mainComponent?.name || node.name || '组件')
      const variants = Object.fromEntries(asArray(node.variantProperties).filter((item) => Array.isArray(item) && item.length >= 2))
      const key = `${component}|${JSON.stringify(variants)}`
      const existing = componentMap.get(key)
      if (existing) existing.count += 1
      else if (componentMap.size < MAX_COMPONENT_ITEMS) componentMap.set(key, { name: component, instanceName: name, variants, count: 1, box: compactBox(node.absoluteBoundingBox, rootBox) })
    }

    const nodeInteractions = node.reactions || node.prototypeInteractions || node.interactions
    if (nodeInteractions && interactions.length < 120) interactions.push({ node: name || node.id, interactions: nodeInteractions })
    for (const child of asArray(node.children)) walk(child, nextAncestors, visible, depth + 1)
  }

  walk(frame)
  return {
    id: frame.id,
    name: fallbackName || cleanText(frame.name) || frame.id,
    size: { width: round(rootBox.width), height: round(rootBox.height) },
    visibleNodeCount,
    nodeTypes: typeCounts,
    sections,
    texts: [...textMap.values()],
    components: [...componentMap.values()],
    interactions,
    dominantColors: [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([color, count]) => ({ color, count })),
  }
}

function findNodes(root, ids) {
  const results = new Map()
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (ids.has(node.id)) results.set(node.id, node)
    for (const child of asArray(node.children)) visit(child)
  }
  visit(root)
  return results
}

function pixsoFrameReferences(document, pagedFrames) {
  const referenced = Object.values(pagedFrames || {}).flatMap((page) => asArray(page?.frames)).filter((item) => item?.id)
  if (referenced.length) return referenced.slice(0, MAX_FRAMES)
  return asArray(document?.children).flatMap((page) => asArray(page?.children).filter((node) => node?.type === 'FRAME').map((node) => ({ id: node.id, name: node.name }))).slice(0, MAX_FRAMES)
}

function extractPixsoEvidence(html, fileName) {
  const encoded = readQuotedAssignment(html, 'FILE_DATA')
  if (!encoded) return null
  let payload
  try { payload = JSON.parse(decodeURIComponent(encoded)) } catch (error) { throw new Error(`Pixso FILE_DATA 无法解析：${error.message}`) }
  const pagedFrames = readObjectAssignment(html, 'PAGED_FRAMES') || {}
  const references = pixsoFrameReferences(payload.document, pagedFrames)
  const nodes = findNodes(payload.document, new Set(references.map((item) => item.id)))
  const frames = references.map((reference) => nodes.get(reference.id) ? collectPixsoFrame(nodes.get(reference.id), reference.name) : null).filter(Boolean)
  if (!frames.length) throw new Error('Pixso HTML 中没有找到可评审的 Frame')
  return {
    sourceType: 'pixso-html',
    fileName,
    documentName: cleanText(payload.name || payload.document?.name),
    originalCharacters: html.length,
    encodedCharacters: encoded.length,
    frames,
  }
}

function extractSketchMeasureProject(html) {
  if (!/Spec Export - Sketch MeaXure/i.test(html) || !/meaxure\.render\(data\)/i.test(html)) return null
  const marker = html.lastIndexOf('let data =')
  if (marker < 0) return null
  const equal = html.indexOf('=', marker)
  const start = html.indexOf('{', equal)
  if (equal < 0 || start < 0) return null
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]
    if (quote) {
      if (!escaped && character === quote) quote = ''
      escaped = !escaped && character === '\\'
      if (character !== '\\') escaped = false
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          const project = JSON.parse(html.slice(start, index + 1))
          return asArray(project?.artboards).length ? project : null
        } catch (error) {
          throw new Error(`Sketch MeaXure data 无法解析：${error.message}`)
        }
      }
    }
  }
  return null
}

function sketchColor(value) {
  const rgba = cleanText(value?.['css-rgba'])
  if (/^rgba?\(/i.test(rgba)) return rgba
  return cleanText(value?.['color-hex']).match(/#[0-9a-f]{6,8}/i)?.[0] || ''
}

function sketchBox(rect) {
  if (!rect) return undefined
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) }
}

function collectSketchMeasureFrame(artboard) {
  const texts = []
  const components = []
  const textKeys = new Set()
  const componentKeys = new Set()
  for (const layer of asArray(artboard.layers)) {
    const box = sketchBox(layer.rect)
    if (!box) continue
    if (layer.type === 'text') {
      const text = cleanText(layer.content || layer.name)
      const key = `${text}|${box.x}|${box.y}|${box.width}|${box.height}`
      if (text && !textKeys.has(key) && texts.length < MAX_TEXT_ITEMS) {
        textKeys.add(key)
        texts.push({
          text,
          context: cleanText(layer.name),
          box,
          fontSize: round(layer.fontSize),
          fontWeight: /bold|medium|semibold/i.test(layer.fontFace || layer.styleName || '') ? 600 : 400,
          color: sketchColor(layer.color) || undefined,
        })
      }
    } else if (['symbol', 'slice'].includes(layer.type)) {
      const name = cleanText(layer.name)
      const key = `${name}|${box.x}|${box.y}|${box.width}|${box.height}`
      if (name && !componentKeys.has(key) && components.length < MAX_COMPONENT_ITEMS) {
        componentKeys.add(key)
        components.push({ name, box, count: 1 })
      }
    }
  }
  return {
    id: artboard.objectID,
    name: cleanText(artboard.name) || artboard.objectID,
    pageName: cleanText(artboard.pageName),
    size: { width: round(artboard.width), height: round(artboard.height) },
    visibleNodeCount: asArray(artboard.layers).length,
    texts,
    components,
    interactions: asArray(artboard.layers).filter((layer) => layer.flow).slice(0, 120).map((layer) => ({ node: cleanText(layer.name), flow: layer.flow })),
    previewMode: artboard.imageBase64 ? 'embedded-image' : 'layer-reconstruction',
    missingPreviewAsset: !artboard.imageBase64 && Boolean(artboard.imagePath),
  }
}

function extractSketchMeasureEvidence(html, fileName) {
  const project = extractSketchMeasureProject(html)
  if (!project) return null
  return {
    sourceType: 'sketch-meaxure-html',
    fileName,
    originalCharacters: html.length,
    frames: asArray(project.artboards).slice(0, MAX_FRAMES).map(collectSketchMeasureFrame),
  }
}

function stripTags(value) {
  return cleanText(String(value || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"'))
}

function extractRegularHtmlEvidence(html, fileName) {
  const withoutRuntime = String(html || '').replace(/<!--([\s\S]*?)-->/g, ' ').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  const title = stripTags(withoutRuntime.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1])
  const signals = []
  const pattern = /<(h[1-6]|button|label|a|input|select|textarea|th|td|option)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)\/?>/gi
  for (const match of withoutRuntime.matchAll(pattern)) {
    if (signals.length >= MAX_HTML_SIGNALS) break
    const tag = (match[1] || match[4] || '').toLowerCase()
    const attributes = match[2] || match[5] || ''
    const value = stripTags(match[3]) || cleanText(attributes.match(/(?:aria-label|placeholder|value)=["']([^"']+)["']/i)?.[1])
    if (value) signals.push({ tag, text: value.slice(0, 500) })
  }
  return {
    sourceType: 'html',
    fileName,
    originalCharacters: html.length,
    title,
    visibleText: stripTags(withoutRuntime).slice(0, 100_000),
    signals,
  }
}

export function extractDesignHtmlEvidence(html, fileName = 'design.html') {
  return extractPixsoEvidence(html, fileName) || extractSketchMeasureEvidence(html, fileName) || extractRegularHtmlEvidence(html, fileName)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function previewFrameSvg(frame) {
  const width = Math.max(320, Number(frame.size?.width) || 1440)
  const height = Math.max(240, Number(frame.size?.height) || 900)
  const sections = asArray(frame.sections).map((section) => {
    const box = section.box
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return ''
    return `<g><rect x="${box.x}" y="${box.y}" width="${Math.max(1, box.width || 1)}" height="${Math.max(1, box.height || 1)}" rx="6" fill="#ffffff" stroke="#e5e9f2"/><text x="${box.x + 10}" y="${box.y + 18}" fill="#9aa3b5" font-size="10">${escapeHtml(section.name)}</text></g>`
  }).join('')
  const components = asArray(frame.components).map((component) => {
    const box = component.box
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return ''
    return `<rect x="${box.x}" y="${box.y}" width="${Math.max(1, box.width || 1)}" height="${Math.max(1, box.height || 1)}" rx="4" fill="rgba(89,104,232,.035)" stroke="rgba(89,104,232,.16)"/>`
  }).join('')
  const texts = asArray(frame.texts).map((item) => {
    const box = item.box
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return ''
    const fontSize = Math.max(8, Number(item.fontSize) || 14)
    const color = /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : '#273044'
    const weight = Number(item.fontWeight) >= 600 ? 600 : 400
    const value = escapeHtml(item.text)
    return `<text data-review-anchor="${value}" x="${box.x}" y="${box.y + Math.min(box.height || fontSize, fontSize)}" fill="${color}" font-size="${fontSize}" font-weight="${weight}">${value}</text>`
  }).join('')
  return `<section class="design-frame" data-page-name="${escapeHtml(frame.name)}"><header><strong>${escapeHtml(frame.name)}</strong><span>${width} × ${height}</span></header><svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeHtml(frame.name)}"><rect width="${width}" height="${height}" fill="#f7f8fb"/>${sections}${components}${texts}</svg></section>`
}

function sketchRadius(layer) {
  const values = asArray(layer.radius).map(Number).filter(Number.isFinite)
  return Math.max(0, Math.min(...(values.length ? values : [0])))
}

function sketchLayerTransform(layer) {
  const rotation = Number(layer.rotation) || 0
  if (!rotation || !layer.rect) return ''
  const centerX = Number(layer.rect.x) + Number(layer.rect.width) / 2
  const centerY = Number(layer.rect.y) + Number(layer.rect.height) / 2
  return ` transform="rotate(${rotation} ${centerX} ${centerY})"`
}

function previewSketchShape(layer) {
  const box = layer.rect
  if (!box || !Number.isFinite(Number(box.x)) || !Number.isFinite(Number(box.y)) || Number(box.width) <= 0 || Number(box.height) <= 0) return ''
  const fill = asArray(layer.fills).filter((item) => item?.fillType === 'Color').map((item) => sketchColor(item.color)).find(Boolean) || 'none'
  const border = asArray(layer.borders).map((item) => ({ color: sketchColor(item.color), width: Number(item.thickness) || 1 })).find((item) => item.color)
  const opacity = Math.max(0, Math.min(1, Number.isFinite(Number(layer.opacity)) ? Number(layer.opacity) : 1))
  return `<rect x="${round(box.x)}" y="${round(box.y)}" width="${Math.max(0.5, round(box.width))}" height="${Math.max(0.5, round(box.height))}" rx="${sketchRadius(layer)}" fill="${escapeHtml(fill)}"${border ? ` stroke="${escapeHtml(border.color)}" stroke-width="${border.width}"` : ''} opacity="${opacity}"${sketchLayerTransform(layer)}/>`
}

function previewSketchText(layer) {
  const box = layer.rect
  const value = cleanText(layer.content || layer.name)
  if (!box || !value || !Number.isFinite(Number(box.x)) || !Number.isFinite(Number(box.y))) return ''
  const color = sketchColor(layer.color) || '#273044'
  const fontSize = Math.max(8, Number(layer.fontSize) || 14)
  const lineHeight = Math.max(fontSize, Number(layer.lineHeight) || fontSize * 1.4)
  const weight = /bold|medium|semibold/i.test(layer.fontFace || layer.styleName || '') ? 600 : 400
  const align = ['center', 'right'].includes(String(layer.textAlign).toLowerCase()) ? String(layer.textAlign).toLowerCase() : 'left'
  const opacity = Math.max(0, Math.min(1, Number.isFinite(Number(layer.opacity)) ? Number(layer.opacity) : 1))
  return `<foreignObject x="${round(box.x)}" y="${round(box.y)}" width="${Math.max(1, round(box.width))}" height="${Math.max(1, round(box.height))}" opacity="${opacity}"${sketchLayerTransform(layer)}><div xmlns="http://www.w3.org/1999/xhtml" data-review-anchor="${escapeHtml(value)}" style="width:100%;height:100%;overflow:hidden;color:${escapeHtml(color)};font-family:${escapeHtml(layer.fontFace || 'Microsoft YaHei')},sans-serif;font-size:${fontSize}px;font-weight:${weight};line-height:${lineHeight}px;text-align:${align};white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(value)}</div></foreignObject>`
}

function previewSketchFrameSvg(artboard) {
  const width = Math.max(320, Number(artboard.width) || 1440)
  const height = Math.max(240, Number(artboard.height) || 900)
  const layers = asArray(artboard.layers).map((layer) => {
    if (layer.type === 'shape') return previewSketchShape(layer)
    if (layer.type === 'text') return previewSketchText(layer)
    return ''
  }).join('')
  return `<section class="design-frame sketch-frame" data-page-name="${escapeHtml(artboard.name)}"><header><strong>${escapeHtml(artboard.name)}</strong><span>${width} × ${height}</span></header><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(artboard.name)}"><rect width="${width}" height="${height}" fill="#fff"/>${layers}</svg></section>`
}

function previewSketchImageFrameSvg(artboard, assetBaseUrl) {
  const width = Math.max(320, Number(artboard.width) || 1440)
  const height = Math.max(240, Number(artboard.height) || 900)
  const source = artboard.imageBase64 || `${assetBaseUrl.replace(/\/?$/, '/')}${String(artboard.imagePath || '').replace(/^\.\//, '')}`
  const anchors = asArray(artboard.layers).filter((layer) => layer.type === 'text' && layer.rect && cleanText(layer.content || layer.name)).map((layer) => {
    const box = layer.rect
    return `<rect data-review-anchor="${escapeHtml(cleanText(layer.content || layer.name))}" x="${round(box.x)}" y="${round(box.y)}" width="${Math.max(1, round(box.width))}" height="${Math.max(1, round(box.height))}" fill="transparent" pointer-events="none"/>`
  }).join('')
  return `<section class="design-frame sketch-frame" data-page-name="${escapeHtml(artboard.name)}"><header><strong>${escapeHtml(artboard.name)}</strong><span>${width} × ${height}</span></header><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(artboard.name)}"><image href="${escapeHtml(source)}" width="${width}" height="${height}" preserveAspectRatio="xMinYMin meet"/>${anchors}</svg></section>`
}

function injectHtmlBase(html, assetBaseUrl) {
  if (!assetBaseUrl) return html
  const base = `<base href="${escapeHtml(assetBaseUrl.replace(/\/?$/, '/'))}">`
  return /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (head) => `${head}${base}`) : `${base}${html}`
}

export function renderDesignPreviewHtml(html, fileName = 'design.html', options = {}) {
  const evidence = extractDesignHtmlEvidence(html, fileName)
  if (!['pixso-html', 'sketch-meaxure-html'].includes(evidence.sourceType)) return injectHtmlBase(html, options.assetBaseUrl)
  if (evidence.sourceType === 'pixso-html' && options.assetBaseUrl) return injectHtmlBase(html, options.assetBaseUrl)
  const project = evidence.sourceType === 'sketch-meaxure-html' ? extractSketchMeasureProject(html) : null
  const frames = evidence.sourceType === 'sketch-meaxure-html'
    ? asArray(project?.artboards).slice(0, MAX_FRAMES).map((artboard) => options.assetBaseUrl ? previewSketchImageFrameSvg(artboard, options.assetBaseUrl) : previewSketchFrameSvg(artboard)).join('')
    : asArray(evidence.frames).map(previewFrameSvg).join('')
  const notice = evidence.sourceType === 'sketch-meaxure-html'
    ? options.assetBaseUrl
      ? '<aside class="preview-notice is-complete"><strong>原始设计图预览</strong><span>已加载完整 Sketch MeaXure 导出资源，标注将依据图层文本坐标定位。</span></aside>'
      : '<aside class="preview-notice"><strong>结构还原预览</strong><span>原始 PNG 未随 HTML 上传，当前依据内嵌 Sketch 图层恢复页面；如需完整视觉效果，请上传包含 preview 与 assets 的 ZIP 导出包。</span></aside>'
    : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(evidence.documentName || fileName)}</title><style>*{box-sizing:border-box}html,body{margin:0;background:#edf0f6;color:#182033;font-family:"Microsoft YaHei",sans-serif}body{padding:20px}.preview-notice{max-width:1440px;margin:0 auto 16px;padding:12px 16px;display:flex;gap:12px;align-items:center;color:#72521f;background:#fff8e8;border:1px solid #f0d79c;border-radius:8px;font-size:13px}.preview-notice.is-complete{color:#245b3d;background:#edf9f2;border-color:#b7dfc8}.preview-notice strong{white-space:nowrap}.design-frame{max-width:1440px;margin:0 auto 24px;overflow:hidden;background:#fff;border:1px solid #dfe4ee;border-radius:10px;box-shadow:0 8px 24px rgba(31,42,68,.1)}.design-frame header{height:44px;padding:0 14px;display:flex;align-items:center;justify-content:space-between;background:#fff;border-bottom:1px solid #e7eaf1}.design-frame header span{color:#8a93a6;font-size:12px}.design-frame svg{display:block;width:100%;height:auto;background:#fff}</style></head><body>${notice}${frames}</body></html>`
}

function compactPage(page) {
  return {
    id: page.id,
    name: page.name,
    module: page.module,
    path: page.path,
    pageType: page.pageType,
    preconditions: asArray(page.preconditions),
    openQuestions: asArray(page.openQuestions),
    fields: asArray(page.fields),
    interactionRules: asArray(page.interactionRules),
    steps: asArray(page.steps),
    feedback: page.feedback,
    designPoints: asArray(page.designPoints),
    designRisks: asArray(page.designRisks),
  }
}

export function buildRequirementReviewContext(analysis) {
  const data = analysis?.analysisData || {}
  return {
    overview: data.overview || { summary: cleanText(analysis?.sourceText).slice(0, 3000) },
    globalConstraints: asArray(data.designReview?.crossPageConstraints),
    terminology: asArray(data.designReview?.terminology),
    pages: asArray(data.pages).map(compactPage),
  }
}

function normalizedName(value) {
  return cleanText(value).toLowerCase().replace(/[\s·_/@（）()\-—]/g, '').replace(/页面|页|控制台|管理/g, '')
}

function pageScore(frameName, pageName) {
  const frame = normalizedName(frameName)
  const page = normalizedName(pageName)
  if (!frame || !page) return 0
  if (frame === page) return 100
  if (frame.includes(page) || page.includes(frame)) return 60 + Math.min(frame.length, page.length)
  const shared = [...new Set([...frame].filter((character) => page.includes(character)))].length
  return shared / Math.max(frame.length, page.length)
}

function requirementForFrame(context, frameName) {
  const ranked = context.pages.map((page) => ({ page, score: pageScore(frameName, page.name) })).sort((a, b) => b.score - a.score)
  const matched = ranked.filter((item) => item.score >= 0.45).slice(0, 3).map((item) => item.page)
  return { overview: context.overview, globalConstraints: context.globalConstraints, terminology: context.terminology, matchedPages: matched, pageIndex: matched.length ? undefined : context.pages.map((page) => ({ id: page.id, name: page.name, module: page.module })) }
}

function parseJsonResponse(text) {
  const cleaned = String(text || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(cleaned) } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1))
    throw new Error('模型没有返回可解析的设计评审 JSON')
  }
}

function compactFrameForGlobal(frame) {
  return {
    name: frame.name,
    size: frame.size,
    texts: asArray(frame.texts).slice(0, 120).map((item) => item.text),
    components: asArray(frame.components).slice(0, 80).map((item) => ({ name: item.name, variants: item.variants, count: item.count })),
    signals: asArray(frame.signals).slice(0, 120),
  }
}

function boundedJson(value) {
  const bounded = structuredClone(value)
  const serialized = JSON.stringify(bounded)
  if (serialized.length <= MAX_MODEL_TEXT_CHARS) return serialized
  if (bounded?.designEvidence?.texts) bounded.designEvidence.texts = bounded.designEvidence.texts.slice(0, 250)
  if (bounded?.designEvidence?.components) bounded.designEvidence.components = bounded.designEvidence.components.slice(0, 150)
  if (bounded?.designEvidence?.sections) bounded.designEvidence.sections = bounded.designEvidence.sections.slice(0, 100)
  if (bounded?.designEvidence?.interactions) bounded.designEvidence.interactions = bounded.designEvidence.interactions.slice(0, 60)
  if (bounded?.designEvidence?.visibleText) bounded.designEvidence.visibleText = bounded.designEvidence.visibleText.slice(0, 50_000)
  if (bounded?.designEvidence?.signals) bounded.designEvidence.signals = bounded.designEvidence.signals.slice(0, 300)
  bounded.truncatedForModelContext = true
  const compacted = JSON.stringify(bounded)
  if (compacted.length > MAX_MODEL_TEXT_CHARS) throw new Error(`单页结构化评审证据仍过大（${compacted.length} 字符），需要进一步拆分该设计页面`)
  return compacted
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let index = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await worker(items[current], current)
    }
  })
  await Promise.all(runners)
  return results
}

async function reviewJobsWithFailures(jobs, concurrency, worker) {
  const settled = await mapWithConcurrency(jobs, concurrency, async (job, index) => {
    try {
      return { result: await worker(job, index), failure: null }
    } catch (error) {
      return { result: null, failure: { pageName: job.name, message: error.message } }
    }
  })
  return {
    results: settled.map((item) => item.result).filter(Boolean),
    failures: settled.map((item) => item.failure).filter(Boolean),
  }
}

function mergeReviewResults(results, reviewedCount) {
  const issues = []
  const seen = new Set()
  for (const result of results) {
    for (const issue of asArray(result?.issues)) {
      const key = `${cleanText(issue.type)}|${normalizedName(issue.title)}|${normalizedName(issue.detail).slice(0, 80)}`
      if (!key || seen.has(key)) continue
      seen.add(key)
      issues.push(issue)
    }
  }
  const summaries = [...new Set(results.map((item) => cleanText(item?.summary)).filter(Boolean))].join('；').slice(0, 1000)
  return { summary: `已完成 ${reviewedCount} 个设计页面或文件的结构化评审，共识别 ${issues.length} 个问题。${summaries ? ` ${summaries}` : ''}`, issues }
}

function collectDesignReviewJobs(design, uploadDir) {
  const jobs = []
  const pixsoFrames = []
  for (const file of design.files) {
    const absolutePath = path.join(uploadDir, file.savedPath)
    if (['.jpg', '.jpeg', '.png'].includes(file.extension)) {
      const mime = file.extension === '.png' ? 'image/png' : 'image/jpeg'
      jobs.push({ kind: 'image', name: file.name, imageUrl: `data:${mime};base64,${fs.readFileSync(absolutePath).toString('base64')}` })
      continue
    }
    const evidence = extractDesignHtmlEvidence(fs.readFileSync(absolutePath, 'utf8'), file.name)
    if (asArray(evidence.frames).length) {
      for (const frame of evidence.frames) {
        pixsoFrames.push(frame)
        jobs.push({ kind: 'structured', name: frame.name, evidence: frame, sourceType: evidence.sourceType })
      }
    } else jobs.push({ kind: 'structured', name: file.name, evidence, sourceType: evidence.sourceType })
  }
  if (!jobs.length) throw new Error('设计稿中没有可评审的页面或图片')
  return { jobs, pixsoFrames }
}

function contentForJob(text, job) {
  const content = [{ type: 'input_text', text }]
  if (job.kind === 'image') content.push({ type: 'input_image', image_url: job.imageUrl, detail: 'high' })
  return content
}

export async function generateModelDesignReview({ requirement, analysis, design, uploadDir, callModel, systemPrompt, concurrency = REVIEW_CONCURRENCY, pageNames = null }) {
  const requirementContext = buildRequirementReviewContext(analysis)
  const { jobs, pixsoFrames } = collectDesignReviewJobs(design, uploadDir)
  const selectedNames = pageNames?.length ? new Set(pageNames) : null
  const selectedJobs = selectedNames ? jobs.filter((job) => selectedNames.has(job.name)) : jobs
  if (!selectedJobs.length) throw new Error('没有找到需要重试的设计页面')
  const { results: pageResults, failures } = await reviewJobsWithFailures(selectedJobs, concurrency, async (job) => {
    const requirementEvidence = requirementForFrame(requirementContext, job.name)
    const payload = boundedJson({ product: requirement.productName, reviewScope: { type: 'single-design-page', name: job.name, sourceType: job.sourceType || job.kind }, requirementEvidence, designEvidence: job.evidence })
    const content = [{ type: 'input_text', text: `请只评审本轮指定的设计页面，并在每条问题 detail 开头标注“设计页面：${job.name}”。每条 issue 必须输出 annotation：pageName 与 pageFileName 均填写“${job.name}”，anchorText 引用设计证据中真实存在且最接近问题的可见文本，x/y 为页面宽高 0-100 的归一化百分比，coordinateMode 为 normalized，confidence 为 0-1。标注必须落在具体问题控件或文本中心，不得把多个问题堆在同一位置。输入证据：\n${payload}` }]
    if (job.kind === 'image') content.push({ type: 'input_image', image_url: job.imageUrl, detail: 'high' })
    try { return parseJsonResponse(await callModel(systemPrompt, content)) } catch (error) { throw new Error(`设计页面“${job.name}”评审失败：${error.message}`) }
  })

  if (!pageResults.length) throw new Error(failures[0]?.message || '设计页面评审全部失败')
  const reviewedPageCount = pageResults.length

  if (!failures.length && pixsoFrames.length > 1) {
    const globalPayload = boundedJson({ product: requirement.productName, reviewScope: 'cross-page-consistency', requirementEvidence: { overview: requirementContext.overview, globalConstraints: requirementContext.globalConstraints, terminology: requirementContext.terminology }, designPages: pixsoFrames.map(compactFrameForGlobal) })
    try {
      pageResults.push(parseJsonResponse(await callModel(systemPrompt, [{ type: 'input_text', text: `本轮只检查跨页面一致性、术语、流程衔接和全局约束，不重复逐页问题。输入证据：\n${globalPayload}` }])))
    } catch (error) {
      throw new Error(`跨页面一致性评审失败：${error.message}`)
    }
  }
  return {
    ...mergeReviewResults(pageResults, reviewedPageCount),
    partial: failures.length > 0,
    failedPages: failures.map((item) => item.pageName),
    pageErrors: failures,
  }
}

function normalizeUiReviewArea(value) {
  const text = cleanText(value).toLowerCase()
  if (text.includes('access') || text.includes('无障碍')) return 'accessibility'
  if (text.includes('system') || text.includes('系统')) return 'system'
  if (text.includes('interaction') || text.includes('交互')) return 'interaction'
  return 'visual'
}

function normalizeUiReviewIssue(issue, counters) {
  const area = normalizeUiReviewArea(issue.area || issue.label || issue.type)
  const prefix = { visual: 'V', interaction: 'I', system: 'S', accessibility: 'A' }[area]
  counters[area] += 1
  const priority = ['P0', 'P1', 'P2'].includes(issue.priority) ? issue.priority : 'P2'
  const confidence = ['confirmed', 'high', 'needs_review'].includes(issue.confidence) ? issue.confidence : 'needs_review'
  const type = {
    visual: '【视觉】视觉质量',
    interaction: '【体验】交互体验',
    system: '【系统】设计系统',
    accessibility: '【无障碍】可访问性',
  }[area]
  const detailParts = [
    issue.location ? `位置：${cleanText(issue.location)}` : '',
    issue.phenomenon ? `现象：${cleanText(issue.phenomenon)}` : '',
    issue.evidence ? `证据：${cleanText(issue.evidence)}` : '',
    issue.impact ? `影响：${cleanText(issue.impact)}` : '',
  ].filter(Boolean)
  return {
    type,
    process: 'UX设计与评审',
    title: cleanText(issue.title) || 'UI 设计质量问题',
    detail: detailParts.join('；') || cleanText(issue.detail) || '当前设计存在需要复核的 UI 质量问题。',
    people: cleanText(issue.people) || '设计、产品经理',
    severity: priority === 'P0' || priority === 'P1' ? 'high' : 'medium',
    conformity: priority === 'P2' ? 'partial' : 'nonconforming',
    basis: 'ui_review_skill',
    reviewCode: `${prefix}${counters[area]}`,
    reviewArea: area,
    reviewPriority: priority,
    confidence,
    evidence: cleanText(issue.evidence),
    solution: cleanText(issue.advice || issue.solution),
    verification: cleanText(issue.verification),
    evidenceStatus: confidence === 'needs_review' ? 'needs_confirmation' : 'sufficient',
    mustFix: priority === 'P0' || priority === 'P1',
    annotation: issue.annotation,
  }
}

export async function generateModelUiDesignReview({ requirement, analysis, design, uploadDir, callModel, systemPrompt, validateContrastChecks = async () => [], concurrency = REVIEW_CONCURRENCY }) {
  const requirementContext = buildRequirementReviewContext(analysis || { sourceText: requirement.source?.text })
  const { jobs } = collectDesignReviewJobs(design, uploadDir)
  const contract = `只返回有效 JSON，不要 Markdown。输出：
{"summary":"总体判断","strengths":["值得保留"],"evidenceLimitations":["证据限制"],"openQuestions":["待确认项"],"contrastChecks":[{"foreground":"#333333","background":"#ffffff","mode":"normal|large|non_text","location":"可定位位置"}],"issues":[{"area":"visual|interaction|system|accessibility","priority":"P0|P1|P2","confidence":"confirmed|high|needs_review","title":"根因式标题","location":"可定位位置","phenomenon":"客观现象","evidence":"证据及来源","impact":"用户或系统影响","advice":"具体修改动作","verification":"修改后验证方法","people":"涉及角色","annotation":{"pageName":"页面名","pageFileName":"文件名","anchorText":"真实可见文本","x":50,"y":50,"coordinateMode":"normalized","confidence":0.8}}]}。
contrastChecks 只有在输入证据提供了准确颜色值或设计 Token 时才能输出；截图估算颜色不得进入该字段。平台会调用 Skill 自带 contrast.py 复核每一项。
平台会把 annotation 渲染为交互式问题标注点，因此本次不生成派生图片；无法可靠定位时不要编造坐标，annotation 可省略并把 confidence 设为 needs_review。不要把未展示的 hover、focus、loading、error 等状态直接判定为缺失，应写入 openQuestions。相同根因只输出一次。`
  const pageResults = await mapWithConcurrency(jobs, concurrency, async (job) => {
    const payload = boundedJson({
      product: requirement.productName,
      reviewScope: { type: 'single-design-page', name: job.name, sourceType: job.sourceType || job.kind },
      requirementContext: requirementForFrame(requirementContext, job.name),
      designEvidence: job.evidence,
    })
    const instruction = `按照 review-ui-design 完成当前页面的首轮 UI 设计评审，执行三秒印象、结构检查、细节检查和反证检查。页面名称：${job.name}。截图无法证明的精确像素、色值、隐藏状态或真实热区不得写成确定事实。${contract}\n输入证据：\n${payload}`
    try {
      const result = parseJsonResponse(await callModel(systemPrompt, contentForJob(instruction, job)))
      result.contrastChecks = await validateContrastChecks(result.contrastChecks)
      return result
    } catch (error) {
      throw new Error(`review-ui-design 页面“${job.name}”评审失败：${error.message}`)
    }
  })

  if (jobs.length > 1) {
    const crossPagePayload = boundedJson({
      product: requirement.productName,
      reviewScope: 'cross-page-ui-quality',
      requirementContext: {
        overview: requirementContext.overview,
        globalConstraints: requirementContext.globalConstraints,
        terminology: requirementContext.terminology,
      },
      designPages: jobs.map((job) => job.kind === 'image'
        ? { name: job.name, sourceType: 'image' }
        : { name: job.name, sourceType: job.sourceType, evidence: compactFrameForGlobal(job.evidence || { name: job.name, texts: [], components: [] }) }),
    })
    const content = [{
      type: 'input_text',
      text: `按照 review-ui-design 只检查跨页面的信息层级、交互模式、设计系统、术语和无障碍一致性，不重复逐页问题。${contract}\n输入证据：\n${crossPagePayload}`,
    }]
    for (const job of jobs.filter((item) => item.kind === 'image').slice(0, 12)) content.push({ type: 'input_image', image_url: job.imageUrl, detail: 'high' })
    try {
      const result = parseJsonResponse(await callModel(systemPrompt, content))
      result.contrastChecks = await validateContrastChecks(result.contrastChecks)
      pageResults.push(result)
    } catch (error) {
      throw new Error(`review-ui-design 跨页面评审失败：${error.message}`)
    }
  }

  const merged = mergeReviewResults(pageResults, jobs.length)
  const counters = { visual: 0, interaction: 0, system: 0, accessibility: 0 }
  return {
    summary: merged.summary,
    strengths: uniqueTextItems(pageResults.flatMap((result) => asArray(result?.strengths).map(cleanText)).filter(Boolean)),
    evidenceLimitations: uniqueTextItems(pageResults.flatMap((result) => asArray(result?.evidenceLimitations).map(cleanText)).filter(Boolean)),
    openQuestions: uniqueTextItems(pageResults.flatMap((result) => asArray(result?.openQuestions).map(cleanText)).filter(Boolean)),
    issues: merged.issues.map((issue) => normalizeUiReviewIssue(issue, counters)),
  }
}

function splitRequirementText(sourceText, maximumCharacters = 30_000) {
  const paragraphs = String(sourceText || '').split(/\n{2,}/)
  const chunks = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > maximumCharacters) {
      chunks.push(current)
      current = ''
    }
    if (paragraph.length > maximumCharacters) {
      if (current) chunks.push(current)
      for (let start = 0; start < paragraph.length; start += maximumCharacters) chunks.push(paragraph.slice(start, start + maximumCharacters))
    } else current += `${current ? '\n\n' : ''}${paragraph}`
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : ['']
}

function uniqueTextItems(items) {
  const seen = new Set()
  return items.filter((item) => {
    const key = normalizedName(typeof item === 'string' ? item : JSON.stringify(item))
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function mergeRawRequirementEvidence(parts, sourceCharacters) {
  const keys = ['userGoals', 'roles', 'scenarios', 'businessRules', 'fields', 'states', 'exceptions', 'acceptanceCriteria', 'openQuestions', 'sourceExcerpts']
  const result = Object.fromEntries(keys.map((key) => [key, uniqueTextItems(parts.flatMap((part) => asArray(part?.[key])))]))
  const pages = new Map()
  for (const page of parts.flatMap((part) => asArray(part?.pages))) {
    const name = cleanText(page?.name) || '未命名页面'
    const key = normalizedName(name) || name
    const existing = pages.get(key) || { name, facts: [] }
    existing.facts = uniqueTextItems([...existing.facts, ...asArray(page?.facts)])
    pages.set(key, existing)
  }
  return { ...result, pages: [...pages.values()], sourceCharacters, chunkCount: parts.length }
}

async function extractRawRequirementEvidence(requirement, callModel, concurrency = REVIEW_CONCURRENCY) {
  const sourceText = String(requirement.source?.text || '')
  if (sourceText.length > 1_200_000) throw new Error('未解析需求正文超过 120 万字符，请拆分文档后再评审；系统不会静默截断需求内容')
  const chunks = splitRequirementText(sourceText)
  const parts = await mapWithConcurrency(chunks, concurrency, async (chunk, index) => {
    const prompt = `这是完整需求文档的第 ${index + 1}/${chunks.length} 个片段。请提取本片段全部可核对事实：\n${chunk}`
    try { return parseJsonResponse(await callModel(rawRequirementExtractionPrompt, [{ type: 'input_text', text: prompt }])) } catch (error) {
      throw new Error(`需求文档第 ${index + 1} 段证据提取失败：${error.message}`)
    }
  })
  return mergeRawRequirementEvidence(parts, sourceText.length)
}

function rawRequirementEvidenceForJob(evidence, jobName) {
  const ranked = evidence.pages
    .map((page) => ({ page, score: pageScore(jobName, page.name) }))
    .sort((a, b) => b.score - a.score)
  const matchedPages = ranked.filter((item) => item.score >= 0.45).slice(0, 3).map((item) => item.page)
  return {
    userGoals: evidence.userGoals,
    roles: evidence.roles,
    scenarios: evidence.scenarios,
    businessRules: evidence.businessRules,
    fields: evidence.fields,
    states: evidence.states,
    exceptions: evidence.exceptions,
    acceptanceCriteria: evidence.acceptanceCriteria,
    openQuestions: evidence.openQuestions,
    sourceExcerpts: evidence.sourceExcerpts,
    matchedPages,
    pageIndex: matchedPages.length ? undefined : evidence.pages.map((page) => page.name),
  }
}

function normalizeExperienceIssue(issue, index = 0) {
  const level = ['P0', 'P1', 'P2', 'P3', 'P4'].includes(issue.severity || issue.experienceLevel) ? (issue.severity || issue.experienceLevel) : 'P4'
  const severity = ['P0', 'P1'].includes(level) ? 'high' : level === 'P2' ? 'medium' : 'low'
  const evidenceType = ['observed', 'inferred', 'unverified'].includes(issue.evidence_type) ? issue.evidence_type : 'unverified'
  const confidence = ['high', 'medium', 'low'].includes(issue.confidence) ? issue.confidence : 'low'
  const evidence = asArray(issue.evidence).map(cleanText).filter(Boolean)
  const acceptanceCriteria = asArray(issue.acceptance_criteria).map(cleanText).filter(Boolean)
  const similarChecks = asArray(issue.similar_checks).map(cleanText).filter(Boolean)
  const reviewCode = /^EVA-\d{3,}$/.test(cleanText(issue.id)) ? cleanText(issue.id) : `EVA-${String(index + 1).padStart(3, '0')}`
  const observation = cleanText(issue.observation || issue.detail || issue.title)
  return {
    ...issue,
    type: level === 'P3' ? '【体验】任务效率' : '【体验】易用性',
    process: 'UX设计与评审',
    detail: `${observation}${evidence.length ? `；证据：${evidence.join('、')}` : ''}`,
    people: issue.people || '设计、产品经理',
    severity,
    conformity: 'nonconforming',
    basis: 'validate_user_experience',
    experienceLevel: level,
    journeyStage: cleanText(issue.task_stage || issue.journeyStage),
    validationDimension: cleanText(issue.dimension || issue.validationDimension),
    userPerspective: cleanText(issue.user_perspective || issue.userPerspective),
    rootCause: cleanText(issue.root_cause || issue.rootCause),
    userImpact: cleanText(issue.user_impact || issue.userImpact),
    solution: cleanText(issue.recommendation || issue.solution),
    analogousCheck: similarChecks.join('；') || cleanText(issue.analogousCheck),
    reviewCode,
    reviewPriority: level,
    confidence,
    evidence: evidence.join('；'),
    verification: acceptanceCriteria.join('；'),
    evidenceStatus: evidenceType === 'unverified' ? 'needs_confirmation' : 'sufficient',
    mustFix: ['P0', 'P1'].includes(level) && evidenceType !== 'unverified',
  }
}

function normalizeExperienceReport(report) {
  const review = report?.review || {}
  return {
    summary: cleanText(review.summary || report?.summary),
    conclusion: cleanText(review.conclusion || report?.conclusion),
    evidenceStatus: cleanText(review.evidence_status || report?.evidence_status),
    positiveEvidence: asArray(report?.positive_evidence).map(cleanText).filter(Boolean),
    gaps: asArray(report?.gaps).map(cleanText).filter(Boolean),
    retest: asArray(report?.retest).map(cleanText).filter(Boolean),
    taskCoverage: asArray(report?.task_coverage),
    issues: asArray(report?.issues).map(normalizeExperienceIssue),
  }
}

function rawValidationConclusion(issues, reportedConclusions = []) {
  const sufficient = issues.filter((issue) => issue.evidenceStatus !== 'needs_confirmation')
  if (sufficient.some((issue) => ['P0', 'P1'].includes(issue.experienceLevel)) || sufficient.some((issue) => issue.basis === 'requirement' && issue.severity === 'high' && issue.conformity === 'nonconforming')) return 'not_passed'
  if (sufficient.some((issue) => issue.experienceLevel === 'P2' || issue.mustFix)
    || sufficient.some((issue) => issue.basis === 'requirement' && ['partial', 'nonconforming'].includes(issue.conformity))) return 'conditional'
  if (reportedConclusions.includes('fail')) return 'not_passed'
  if (reportedConclusions.includes('conditional_pass')) return 'conditional'
  if (reportedConclusions.includes('undetermined')) return 'undetermined'
  return 'passed'
}

export async function generateModelRawRequirementReview({ requirement, design, uploadDir, callModel, compliancePrompt, experiencePrompt, experienceSkillVersion, validateExperienceReport = async () => {}, concurrency = REVIEW_CONCURRENCY }) {
  const rawEvidence = await extractRawRequirementEvidence(requirement, callModel, concurrency)
  const { jobs, pixsoFrames } = collectDesignReviewJobs(design, uploadDir)
  const results = await mapWithConcurrency(jobs, 1, async (job) => {
    const requirementEvidence = rawRequirementEvidenceForJob(rawEvidence, job.name)
    const payload = boundedJson({
      product: requirement.productName,
      reviewScope: { type: 'single-design-page', name: job.name, sourceType: job.sourceType || job.kind },
      requirementEvidence,
      designEvidence: job.evidence,
    })
    const locatorInstruction = `每条 issue 必须输出 annotation：pageName 与 pageFileName 均填写“${job.name}”，anchorText 引用设计证据中真实存在且最接近问题的可见文本，x/y 为页面宽高 0-100 的归一化百分比，coordinateMode 为 normalized，confidence 为 0-1；标注必须落在具体问题控件或文本中心。`
    const complianceInstruction = `请只做需求符合性检查。需求证据没有明确的内容只能标记为待确认，不得自行推断；每条 issue 增加 basis:"requirement" 和 evidenceStatus:"sufficient|needs_confirmation"，detail 开头标注“设计页面：${job.name}”。${locatorInstruction}输入证据：\n${payload}`
    const experienceInstruction = `请严格使用 validate-user-experience 的 design 模式验证用户任务是否能够成功完成，不得把专家启发式建议写成需求不符合。当前设计页面：${job.name}。静态设计证据不能证明点击、键盘、加载、权限、响应式或读屏行为，未展示状态必须进入 gaps 或标记 unverified。只返回 report-contract 定义的 JSON，并为每条 issue 增加 annotation。${locatorInstruction}输入证据：\n${payload}`
    try {
      const compliance = parseJsonResponse(await callModel(compliancePrompt, contentForJob(complianceInstruction, job)))
      const experienceReport = parseJsonResponse(await callModel(experiencePrompt, contentForJob(experienceInstruction, job)))
      await validateExperienceReport(experienceReport)
      const experience = normalizeExperienceReport(experienceReport)
      return {
        summary: `${cleanText(compliance.summary)}；${cleanText(experience.summary)}`,
        issues: [
          ...asArray(compliance.issues).map((issue) => ({ ...issue, basis: 'requirement', evidenceStatus: issue.evidenceStatus || 'sufficient' })),
          ...experience.issues,
        ],
        experience,
      }
    } catch (error) {
      throw new Error(`设计页面“${job.name}”评审失败：${error.message}`)
    }
  })

  if (pixsoFrames.length > 1) {
    const globalPayload = boundedJson({
      product: requirement.productName,
      reviewScope: 'complete-user-journey',
      requirementEvidence: rawEvidence,
      designPages: pixsoFrames.map(compactFrameForGlobal),
    })
    try {
      const journeyReport = parseJsonResponse(await callModel(experiencePrompt, [{
        type: 'input_text',
        text: `请使用 validate-user-experience 的 design 模式，只检查跨页面完整用户旅程、状态衔接、数据一致性和失败恢复，不重复逐页问题。只返回 report-contract JSON；每条 issue 增加可定位 annotation，无法证明的动态状态写入 gaps。输入证据：\n${globalPayload}`,
      }]))
      await validateExperienceReport(journeyReport)
      const journey = normalizeExperienceReport(journeyReport)
      results.push({ summary: cleanText(journey.summary), issues: journey.issues, experience: journey })
    } catch (error) {
      throw new Error(`完整用户旅程评审失败：${error.message}`)
    }
  }

  const merged = mergeReviewResults(results, jobs.length)
  const experienceReports = results.map((result) => result.experience).filter(Boolean)
  return {
    ...merged,
    validationConclusion: rawValidationConclusion(merged.issues, experienceReports.map((report) => report.conclusion)),
    experienceSkillVersion,
    experienceValidationSummary: uniqueTextItems(experienceReports.map((report) => report.summary).filter(Boolean)).join('；'),
    experiencePositiveEvidence: uniqueTextItems(experienceReports.flatMap((report) => report.positiveEvidence)),
    experienceGaps: uniqueTextItems(experienceReports.flatMap((report) => report.gaps)),
    experienceRetest: uniqueTextItems(experienceReports.flatMap((report) => report.retest)),
    experienceTaskCoverage: uniqueTextItems(experienceReports.flatMap((report) => report.taskCoverage)),
    rawEvidenceStats: {
      sourceCharacters: rawEvidence.sourceCharacters,
      chunkCount: rawEvidence.chunkCount,
      pageCount: rawEvidence.pages.length,
      openQuestionCount: rawEvidence.openQuestions.length,
    },
  }
}

export async function generateModelCompetitorComparison({ requirement, analysis, design, competitor, baseReview, uploadDir, callModel }) {
  const evidence = await extractCompetitorEvidence(competitor, uploadDir)
  if (!evidence.sheets.length && !evidence.images.length) throw new Error('竞品材料中没有提取到可分析的表格内容或图片')
  const requirementContext = buildRequirementReviewContext(analysis || { sourceText: requirement.source?.text })
  const payload = boundedJson({
    product: requirement.productName,
    principle: '需求决定对错，设计原则判断体验，竞品仅用于发现遗漏和优化机会',
    competitorFeatureName: competitor.featureName,
    requirementEvidence: requirementContext,
    designVersion: design.versionNo,
    designPages: design.files.map((file) => ({ name: file.name, order: file.order })),
    baseReview: {
      summary: baseReview.summary,
      issues: asArray(baseReview.issues).map((issue) => ({ type: issue.type, title: issue.title, detail: issue.detail })),
    },
    competitorEvidence: {
      files: competitor.files.map((file) => file.name),
      sheets: evidence.sheets,
      imageCount: evidence.images.length,
      embeddedImageCount: evidence.embeddedImageCount,
    },
  })
  const content = [{
    type: 'input_text',
    text: `请在基础评审完成后执行独立竞品对比。竞品差异不得作为判断设计错误或需求不符合的证据，只能发现遗漏和优化机会。输出 JSON：{"summary":"...","issues":[{"type":"优化建议","process":"UX设计与评审","title":"...","detail":"...","people":"设计、产品经理","severity":"low|medium|high","conformity":"conforming","basis":"competitor","annotation":{"pageName":"设计页面名","pageFileName":"设计文件名","anchorText":"页面真实可见文本","x":50,"y":50,"coordinateMode":"normalized","confidence":0.8}}]}。所有 issue 的 type 必须为“优化建议”、conformity 必须为“conforming”、basis 必须为“competitor”。annotation 必须指向本品设计稿中需要补充或优化的具体页面问题点，x/y 使用页面宽高 0-100 的归一化百分比。输入证据：\n${payload}`,
  }]
  for (const image of evidence.images.slice(0, 20)) content.push({ type: 'input_image', image_url: image.imageUrl, detail: 'high' })
  const result = parseJsonResponse(await callModel('你是设计评审中的竞品对比分析器。严格遵守：需求决定对错，设计原则判断体验，竞品只用于发现遗漏和优化机会。', content))
  return {
    summary: cleanText(result.summary),
    issues: asArray(result.issues).map((issue) => ({
      ...issue,
      type: '优化建议',
      conformity: 'conforming',
      basis: 'competitor',
    })),
    evidenceStats: {
      fileCount: evidence.fileCount,
      sheetCount: evidence.sheetCount,
      embeddedImageCount: evidence.embeddedImageCount,
      directImageCount: evidence.directImageCount,
    },
  }
}
