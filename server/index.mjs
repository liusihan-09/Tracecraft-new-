import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cookieParser from 'cookie-parser'
import multer from 'multer'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import { requirementAnalysisSkill } from './skills/requirement-analysis.skill.mjs'
import { designReviewSkill } from './skills/design-review.skill.mjs'
import { requirementFeedbackOptimizerSkill } from './skills/requirement-feedback-optimizer.skill.mjs'
import { reviewFeedbackOptimizerSkill } from './skills/review-feedback-optimizer.skill.mjs'
import { collectPendingItems, recoverRequirementAnalysisPipeline } from './requirement-analysis-pipeline.mjs'
import { indexRequirementSource, normalizeSkillContract, validateSkillContract } from './skill-api-contract.mjs'
import { renderAnalysisHtml } from './analysis-html-template.mjs'
import { runLocalSkillWithDeepSeek } from './local-skill-runner.mjs'
import { generateModelCompetitorComparison, generateModelDesignReview, generateModelRawRequirementReview, generateModelUiDesignReview, renderDesignPreviewHtml } from './design-review-pipeline.mjs'
import { inspectCompetitorVersion } from './competitor-evidence.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const localRequirementSkillDir = path.join(__dirname, 'local-skills', 'designer-requirement-analysis-html')
const wireframeSkillDir = path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.codex'), 'skills', 'wireframe-design')
const reviewUiDesignSkillDir = process.env.DIP_REVIEW_UI_SKILL_DIR
  ? path.resolve(process.env.DIP_REVIEW_UI_SKILL_DIR)
  : path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.codex'), 'skills', 'review-ui-design')
const validateUserExperienceSkillDir = process.env.DIP_VALIDATE_USER_EXPERIENCE_SKILL_DIR
  ? path.resolve(process.env.DIP_VALIDATE_USER_EXPERIENCE_SKILL_DIR)
  : path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.codex'), 'skills', 'validate-user-experience')
const dataDir = process.env.DIP_DATA_DIR ? path.resolve(process.env.DIP_DATA_DIR) : path.join(rootDir, '.data')
const uploadDir = path.join(dataDir, 'uploads')
const feedbackDir = path.join(dataDir, 'feedback')
const dbPath = path.join(dataDir, 'db.json')
const secretPath = path.join(dataDir, 'secrets.json')
const requirementFeedbackPath = path.join(feedbackDir, 'requirement-analysis-feedback.jsonl')
const reviewFeedbackPath = path.join(feedbackDir, 'design-review-feedback.jsonl')
const optimizationRunsPath = path.join(feedbackDir, 'optimization-runs.jsonl')
const port = Number(process.env.PORT || 4318)

fs.mkdirSync(uploadDir, { recursive: true })
fs.mkdirSync(feedbackDir, { recursive: true })

const now = () => new Date().toISOString()
const uid = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString('hex'),
  }
}

function seedDatabase() {
  const adminPassword = hashPassword(process.env.ADMIN_PASSWORD || 'admin123')
  const userPassword = hashPassword(process.env.USER_PASSWORD || 'user123')
  const createdAt = now()
  return {
    users: [
      {
        id: 'user_admin',
        username: process.env.ADMIN_USERNAME || 'admin',
        displayName: '设计平台管理员',
        role: 'admin',
        passwordHash: adminPassword.hash,
        passwordSalt: adminPassword.salt,
      },
      {
        id: 'user_normal',
        username: process.env.USER_USERNAME || 'user',
        displayName: '普通用户',
        role: 'user',
        passwordHash: userPassword.hash,
        passwordSalt: userPassword.salt,
      },
    ],
    settings: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-terra',
      requirementSkillVersion: requirementAnalysisSkill.version,
      reviewSkillVersion: designReviewSkill.version,
    },
    requirements: [createSeedRequirement(createdAt)],
    optimizationRuns: [],
  }
}

function createSeedRequirement(createdAt) {
  const requirementId = 'req_demo'
  const analysisId = 'analysis_demo_v1'
  const sourceText = `# VPC 流日志分析\n\n用户需要创建流日志分析任务，选择目标 VPC、日志存储位置和分析周期。任务创建后可查看处理进度、异常状态和分析结论。平台需要提供明确的失败反馈，并支持重新执行。`
  return {
    id: requirementId,
    productName: '云网络控制台',
    version: '2026.07',
    requirementName: 'VPC 流日志分析',
    summary: '创建并追踪 VPC 流日志分析任务',
    status: 'analyzed',
    source: {
      filename: 'vpc-flow-log.md',
      type: 'text/markdown',
      text: sourceText,
      savedPath: '',
    },
    currentAnalysisVersionId: analysisId,
    analysisVersions: [
      {
        id: analysisId,
        versionNo: 1,
        changeReason: '首次解析',
        sourceText,
        html: demoAnalysisHtml('云网络控制台', 'VPC 流日志分析'),
        pendingItems: [
          {
            id: 'pending_demo_1',
            title: '分析任务失败后的重试规则',
            description: '需求未说明自动重试次数、手动重试入口以及失败后的数据保留策略。',
            sourceHint: '任务异常状态',
            status: 'open',
            answer: '',
          },
          {
            id: 'pending_demo_2',
            title: '日志存储位置的权限校验',
            description: '需要确认无访问权限时是禁止选择，还是允许提交后异步失败。',
            sourceHint: '选择日志存储位置',
            status: 'answered',
            answer: '无权限的存储位置不允许选择，并给出申请权限入口。',
          },
        ],
        skillVersion: 'demo-analysis-v0',
        pipelineMode: 'demo',
        pipelineSkill: '',
        validation: null,
        createdAt,
        createdBy: '设计平台管理员',
      },
    ],
    designVersions: [],
    competitorVersions: [],
    reviews: [],
    analysisFeedback: [],
    createdAt,
    updatedAt: createdAt,
  }
}

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

let db = loadJson(dbPath, null) || seedDatabase()
let secrets = loadJson(secretPath, { apiKey: '' })
const environmentApiKey = process.env.OPENAI_API_KEY || ''
db.optimizationRuns ||= []
db.settings.requirementSkillVersion = requirementAnalysisSkill.version
const adminUsername = process.env.ADMIN_USERNAME || 'admin'
const normalUsername = process.env.USER_USERNAME || 'user'
for (const user of db.users) user.role ||= user.username === adminUsername ? 'admin' : 'user'
if (!db.users.some((user) => user.username === normalUsername)) {
  const password = hashPassword(process.env.USER_PASSWORD || 'user123')
  db.users.push({
    id: 'user_normal',
    username: normalUsername,
    displayName: '普通用户',
    role: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
  })
}

for (const requirement of db.requirements) {
  requirement.requirementName ||= requirement.summary
  requirement.analysisFeedback ||= []
  requirement.designVersions ||= []
  requirement.competitorVersions ||= []
  requirement.reviews ||= []
  for (const review of requirement.reviews) {
    review.saved = review.saved !== false
    if (review.saved) review.savedAt ||= review.createdAt
    else review.savedAt ||= ''
    review.discardedAt ||= ''
    review.status ||= 'completed'
    review.baseReviewStatus ||= review.status === 'partial' ? 'partial' : 'completed'
    review.baseReviewError ||= ''
    review.failedReviewPages ||= []
    review.requirementEvidenceMode ||= review.analysisVersionId ? 'analyzed' : 'raw'
    review.competitorStatus ||= 'not_provided'
    review.validationConclusion ||= ''
    review.experienceSkillVersion ||= ''
    review.experienceValidationSummary ||= ''
    review.experiencePositiveEvidence ||= []
    review.experienceGaps ||= []
    review.experienceRetest ||= []
    review.experienceTaskCoverage ||= []
    review.rawEvidenceStats ||= null
    review.uiDesignReviewEnabled = Boolean(review.uiDesignReviewEnabled)
    review.uiDesignReviewStatus ||= review.uiDesignReviewEnabled ? 'failed' : 'not_selected'
    review.uiDesignReviewSkillVersion ||= ''
    review.uiDesignReviewError ||= ''
    review.uiDesignReviewSummary ||= ''
    review.uiDesignReviewStrengths ||= []
    review.uiDesignReviewEvidenceLimitations ||= []
    review.uiDesignReviewOpenQuestions ||= []
    for (const issue of review.issues || []) {
      issue.basis ||= inferIssueBasis(issue)
      issue.journeyStage ||= ''
      issue.validationDimension ||= ''
      issue.experienceLevel ||= ''
      issue.userPerspective ||= ''
      issue.rootCause ||= ''
      issue.userImpact ||= ''
      issue.solution ||= ''
      issue.analogousCheck ||= ''
      issue.mustFix = Boolean(issue.mustFix)
      issue.evidenceStatus ||= 'sufficient'
      issue.annotation ||= null
      issue.reviewCode ||= ''
      issue.reviewArea ||= ''
      issue.reviewPriority ||= ''
      issue.confidence ||= ''
      issue.evidence ||= ''
      issue.verification ||= ''
    }
  }
  const mayHaveInterruptedRun = requirement.status === 'analyzing'
    || (requirement.status === 'uploaded' && requirement.analysisVersions.length === 0 && requirement.analysisProgress?.status === 'failed')
  if (mayHaveInterruptedRun) {
    const analysis = recoverRequirementAnalysisPipeline({ dataDir, requirement })
    if (analysis) {
      const version = {
        id: uid('analysis'),
        versionNo: requirement.analysisVersions.length + 1,
        changeReason: '服务重启后恢复已完成的解析结果',
        sourceText: requirement.source.text,
        html: analysis.html,
        pendingItems: collectPendingItems(analysis.analysisData).map((item) => ({
          id: uid('pending'), title: item.title, description: item.description, sourceHint: item.sourceHint || '', status: 'open', answer: '',
        })),
        skillVersion: requirementAnalysisSkill.version,
        pipelineMode: analysis.pipelineMode,
        pipelineSkill: analysis.pipelineSkill,
        validation: analysis.validation,
        analysisData: analysis.analysisData,
        runId: analysis.runId,
        artifactPath: analysis.artifactPath,
        createdAt: now(),
        createdBy: '系统恢复',
      }
      requirement.summary = String(analysis.summary || requirement.summary).slice(0, 50)
      requirement.analysisVersions.push(version)
      requirement.currentAnalysisVersionId = version.id
      requirement.status = 'analyzed'
      requirement.analysisProgress = { status: 'completed', percent: 100, title: '已恢复已完成的解析结果', detail: '已通过产物完整性与一致性校验。', updatedAt: now() }
    } else {
      requirement.status = requirement.analysisVersions.length ? 'analyzed' : 'uploaded'
      requirement.analysisProgress = {
        ...(requirement.analysisProgress || {}),
        status: 'failed',
        title: '上次解析任务已中断',
        detail: '服务重启后无法继续原任务，请重新点击“开始解析”。',
        updatedAt: now(),
      }
    }
  }
}

function saveDb() {
  const temporary = `${dbPath}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(db, null, 2), 'utf8')
  fs.renameSync(temporary, dbPath)
}

function writeJsonLines(filePath, records) {
  const temporary = `${filePath}.tmp`
  const content = records.map((record) => JSON.stringify(record)).join('\n')
  fs.writeFileSync(temporary, content ? `${content}\n` : '', 'utf8')
  fs.renameSync(temporary, filePath)
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function requirementFeedbackRecords() {
  return db.requirements.flatMap((requirement) => requirement.analysisFeedback.map((feedback) => {
    const analysis = requirement.analysisVersions.find((item) => item.id === feedback.analysisVersionId)
    return {
      feedbackId: feedback.id,
      feedbackType: 'requirement-analysis',
      requirementId: requirement.id,
      productName: feedback.productName || requirement.productName,
      requirementName: feedback.requirementName || requirement.requirementName || requirement.summary,
      productVersion: feedback.productVersion || requirement.version,
      sourceFilename: requirement.source?.filename || '',
      analysisVersionId: feedback.analysisVersionId || '',
      analysisVersionNo: feedback.analysisVersionNo || 0,
      skillVersion: feedback.skillVersion || analysis?.skillVersion || '',
      pipelineMode: analysis?.pipelineMode || '',
      pipelineSkill: analysis?.pipelineSkill || '',
      model: feedback.model || analysis?.model || db.settings.model,
      category: feedback.category,
      target: feedback.target,
      description: feedback.description,
      expectedResult: feedback.expectedResult,
      generalizable: Boolean(feedback.generalizable),
      createdAt: feedback.createdAt,
      createdBy: feedback.createdBy,
    }
  }))
}

function reviewFeedbackRecords() {
  return db.requirements.flatMap((requirement) => requirement.reviews.flatMap((review) => (review.issues || [])
    .filter((issue) => issue.disposition !== 'pending' || issue.reasonCategory || issue.feedbackReason)
    .map((issue) => ({
      feedbackId: issue.id,
      feedbackType: 'design-review',
      requirementId: requirement.id,
      productName: issue.feedbackProductName || requirement.productName,
      requirementName: issue.feedbackRequirementName || requirement.requirementName || requirement.summary,
      productVersion: issue.feedbackProductVersion || requirement.version,
      reviewId: review.id,
      reviewVersionNo: review.versionNo,
      reviewSaved: Boolean(review.saved),
      reviewStatus: review.status,
      reviewSummary: review.summary,
      analysisVersionId: review.analysisVersionId || '',
      analysisVersionNo: review.analysisVersionNo || 0,
      designVersionId: review.designVersionId || '',
      designVersionNo: review.designVersionNo || 0,
      skillVersion: review.skillVersion || '',
      model: issue.feedbackModel || review.model || db.settings.model,
      issueId: issue.id,
      issueType: issue.type,
      issueTitle: issue.title,
      issueDetail: issue.detail,
      process: issue.process,
      people: issue.people,
      severity: issue.severity,
      basis: issue.basis,
      solution: issue.solution || '',
      verification: issue.verification || '',
      annotation: issue.annotation || null,
      disposition: issue.disposition,
      conformity: issue.conformity,
      reasonCategory: issue.reasonCategory,
      feedbackReason: issue.feedbackReason,
      decidedAt: issue.decidedAt || '',
      feedbackUpdatedAt: issue.feedbackUpdatedAt || issue.decidedAt || '',
      reviewCreatedAt: review.createdAt,
      reviewCreatedBy: review.createdBy,
    }))))
}

function syncFeedbackExports() {
  writeJsonLines(requirementFeedbackPath, requirementFeedbackRecords())
  writeJsonLines(reviewFeedbackPath, reviewFeedbackRecords())
  writeJsonLines(optimizationRunsPath, db.optimizationRuns)
}

function saveSecrets() {
  fs.writeFileSync(secretPath, JSON.stringify(secrets, null, 2), 'utf8')
}

for (const requirement of db.requirements) {
  const sourceRequirements = indexRequirementSource(requirement.source?.text, requirement.source?.filename)
  for (const version of requirement.analysisVersions || []) {
    if (!version.analysisData || String(version.html || '').includes('analysis-render-version" content="diagram-router-v8')) continue
    const shouldMigrateContract = version.pipelineMode === 'model-api'
      && !String(version.pipelineSkill || '').startsWith('designer-requirement-analysis-html-api-v2')
    const normalized = shouldMigrateContract
      ? normalizeSkillContract(version.analysisData, sourceRequirements)
      : version.analysisData
    const contract = validateSkillContract(normalized, sourceRequirements)
    version.analysisData = normalized
    version.html = renderAnalysisHtml(normalized)
    if (shouldMigrateContract) version.pipelineSkill = 'designer-requirement-analysis-html-api-v2-render-migrated'
    version.validation = { ...(version.validation || {}), ok: contract.ok, errors: contract.errors, sourceRequirementCount: sourceRequirements.length, pageCount: normalized.pages.length, businessFlowNodeCount: normalized.businessFlow.swimlane.nodes.length, pageFlowEdgeCount: normalized.pageFlow.edges.length, afLayerCount: normalized.afLayers.length, designReviewPageCount: normalized.designReview.pages.length, competitorFeatureCount: normalized.competitors.features.length, competitorEvidenceCount: normalized.competitors.evidence.length, unmappedCount: normalized.coverage.filter((item) => item.status === 'missing').length }
  }
}

saveDb()
saveSecrets()
syncFeedbackExports()

const sessions = new Map()
const activeAnalysisRuns = new Set()
const app = express()
app.use(express.json({ limit: '20mb' }))
app.use(cookieParser())
app.use('/uploads', express.static(uploadDir))

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase()
    callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`)
  },
})
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024, files: 20 } })
const designUpload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024, files: 20 } })
const competitorUpload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024, files: 20 } })

function safeArchivePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..')) return ''
  return normalized
}

async function extractDesignArchive(uploadedFile) {
  const zip = await JSZip.loadAsync(fs.readFileSync(uploadedFile.path))
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && !entry.name.startsWith('__MACOSX/'))
  if (!entries.length) throw new Error('ZIP 中没有可用文件')
  if (entries.length > 3000) throw new Error('ZIP 文件数量超过 3000 个，请精简设计稿导出包')
  const htmlEntries = entries
    .map((entry) => ({ entry, name: safeArchivePath(entry.name) }))
    .filter((item) => item.name && ['.html', '.htm'].includes(path.extname(item.name).toLowerCase()))
    .sort((left, right) => {
      const leftIndex = path.posix.basename(left.name).toLowerCase() === 'index.html' ? 0 : 1
      const rightIndex = path.posix.basename(right.name).toLowerCase() === 'index.html' ? 0 : 1
      return leftIndex - rightIndex || left.name.split('/').length - right.name.split('/').length
    })
  if (!htmlEntries.length) throw new Error('ZIP 中没有找到 HTML 入口文件')

  const packageRoot = `design-package-${crypto.randomUUID()}`
  const packageDirectory = path.join(uploadDir, packageRoot)
  fs.mkdirSync(packageDirectory, { recursive: true })
  let totalBytes = 0
  try {
    for (const entry of entries) {
      const relativePath = safeArchivePath(entry.name)
      if (!relativePath) throw new Error(`ZIP 包含不安全路径：${entry.name}`)
      const content = await entry.async('nodebuffer')
      totalBytes += content.length
      if (totalBytes > 250 * 1024 * 1024) throw new Error('ZIP 解压后超过 250MB，请精简设计稿导出包')
      const target = resolveInside(packageDirectory, relativePath)
      if (!target) throw new Error(`ZIP 包含不安全路径：${entry.name}`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
  } catch (error) {
    fs.rmSync(packageDirectory, { recursive: true, force: true })
    throw error
  }
  return {
    packageRoot,
    savedPath: `${packageRoot}/${htmlEntries[0].name}`,
    name: path.posix.basename(htmlEntries[0].name),
    entryPath: htmlEntries[0].name,
  }
}

function requireAuth(request, response, next) {
  const token = request.cookies.dip_session
  const session = token ? sessions.get(token) : null
  if (!session) return response.status(401).json({ message: '请先登录' })
  request.user = db.users.find((user) => user.id === session.userId)
  next()
}

function requireAdmin(request, response, next) {
  if (request.user?.role !== 'admin') return response.status(403).json({ message: '仅管理员可使用该功能' })
  next()
}

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role }
}

function getRequirement(id) {
  return db.requirements.find((item) => item.id === id)
}

function resolveInside(baseDirectory, relativePath) {
  if (!relativePath) return ''
  const base = path.resolve(baseDirectory)
  const target = path.resolve(base, relativePath)
  return target.startsWith(`${base}${path.sep}`) ? target : ''
}

function deleteRequirementFiles(requirement) {
  const uploadPaths = new Set([
    requirement.source?.savedPath,
    ...(requirement.designVersions || []).flatMap((version) => (version.files || []).flatMap((file) => [file.packageRoot, file.savedPath, file.archiveSavedPath])),
    ...(requirement.competitorVersions || []).flatMap((version) => (version.files || []).map((file) => file.savedPath)),
  ].filter(Boolean))
  for (const savedPath of uploadPaths) {
    const absolutePath = resolveInside(uploadDir, savedPath)
    if (!absolutePath || !fs.existsSync(absolutePath)) continue
    if (fs.statSync(absolutePath).isDirectory()) fs.rmSync(absolutePath, { recursive: true, force: true })
    else fs.unlinkSync(absolutePath)
  }
  const analysisRoot = path.join(dataDir, 'analysis-runs')
  const analysisDirectory = resolveInside(analysisRoot, requirement.id)
  if (analysisDirectory && fs.existsSync(analysisDirectory)) fs.rmSync(analysisDirectory, { recursive: true, force: true })
}

function deleteDesignVersionFiles(designVersions) {
  const uploadPaths = new Set((designVersions || [])
    .flatMap((version) => (version.files || []).flatMap((file) => [file.packageRoot, file.savedPath, file.archiveSavedPath]))
    .filter(Boolean))
  for (const savedPath of uploadPaths) {
    const absolutePath = resolveInside(uploadDir, savedPath)
    if (!absolutePath || !fs.existsSync(absolutePath)) continue
    if (fs.statSync(absolutePath).isDirectory()) fs.rmSync(absolutePath, { recursive: true, force: true })
    else fs.unlinkSync(absolutePath)
  }
}

function getCurrentAnalysis(requirement) {
  return requirement.analysisVersions.find((item) => item.id === requirement.currentAnalysisVersionId)
}

function publicSettings() {
  const apiKey = secrets.apiKey || environmentApiKey
  return {
    ...db.settings,
    apiKeyConfigured: Boolean(apiKey),
    maskedApiKey: apiKey ? `${apiKey.slice(0, 5)}••••${apiKey.slice(-4)}` : '',
  }
}

function summarizeRequirement(requirement) {
  const analysis = getCurrentAnalysis(requirement)
  const latestDesign = requirement.designVersions.at(-1)
  const latestReview = requirement.reviews.filter((review) => review.status !== 'discarded').at(-1)
  return {
    id: requirement.id,
    productName: requirement.productName,
    version: requirement.version,
    requirementName: requirement.requirementName,
    summary: requirement.summary,
    status: requirement.status,
    analysisVersion: analysis?.versionNo || 0,
    pendingCount: analysis?.pendingItems.filter((item) => item.status === 'open').length || 0,
    designVersion: latestDesign?.versionNo || 0,
    reviewStatus: latestReview ? (latestReview.saved ? 'saved' : 'draft') : 'not_started',
    updatedAt: requirement.updatedAt,
  }
}

function analytics() {
  const allRecords = db.requirements.flatMap((requirement) =>
    requirement.reviews.map((review) => ({
      requirementId: requirement.id,
      requirementVersion: requirement.version,
      requirementSummary: requirement.requirementName || requirement.summary,
      productName: requirement.productName,
      reviewId: review.id,
      reviewVersionNo: review.versionNo,
      designVersionNo: review.designVersionNo,
      opinionCount: review.issues.length,
      feedbackCount: review.issues.filter((issue) => issue.disposition !== 'pending').length,
      state: review.status === 'discarded' ? 'discarded' : review.saved ? 'saved' : 'draft',
      createdAt: review.createdAt,
      savedAt: review.savedAt || '',
      discardedAt: review.discardedAt || '',
    })),
  ).sort((a, b) => (b.savedAt || b.discardedAt || b.createdAt).localeCompare(a.savedAt || a.discardedAt || a.createdAt))
  const allReviews = db.requirements.flatMap((requirement) =>
    requirement.reviews.filter((review) => review.saved).map((review) => ({
      ...review,
      productName: requirement.productName,
      requirementId: requirement.id,
      requirementVersion: requirement.version,
    })),
  )
  const issues = allReviews.flatMap((review) =>
    review.issues.map((issue) => ({ ...issue, productName: review.productName, decidedAt: issue.decidedAt || review.createdAt })),
  )
  const decided = issues.filter((issue) => ['accepted', 'partial', 'rejected'].includes(issue.disposition))
  const accepted = decided.filter((issue) => issue.disposition === 'accepted').length
  const covered = decided.filter((issue) => ['accepted', 'partial'].includes(issue.disposition)).length
  const products = Object.values(allReviews.reduce((result, review) => {
    result[review.productName] ||= { name: review.productName, total: 0, accepted: 0, reviewCount: 0, records: [] }
    const product = result[review.productName]
    product.reviewCount += 1
    const reviewDecided = review.issues.filter((issue) => ['accepted', 'partial', 'rejected'].includes(issue.disposition))
    const reviewAccepted = reviewDecided.filter((issue) => ['accepted', 'partial'].includes(issue.disposition)).length
    product.total += review.issues.length
    product.accepted += review.issues.filter((issue) => ['accepted', 'partial'].includes(issue.disposition)).length
    product.records.push({
      requirementId: review.requirementId,
      requirementVersion: review.requirementVersion,
      reviewId: review.id,
      reviewVersionNo: review.versionNo,
      validationConclusion: review.validationConclusion || '',
      requirementEvidenceMode: review.requirementEvidenceMode,
      analysisVersionNo: review.analysisVersionNo || 0,
      designVersionNo: review.designVersionNo,
      competitorFeatureName: review.competitorFeatureName || '',
      competitorStatus: review.competitorStatus,
      opinionCount: review.issues.length,
      feedbackCount: review.issues.filter((issue) => issue.disposition !== 'pending').length,
      acceptanceRate: reviewDecided.length ? Math.round((reviewAccepted / reviewDecided.length) * 100) : 0,
      savedAt: review.savedAt,
      createdBy: review.createdBy,
    })
    return result
  }, {})).map((product) => ({ ...product, records: product.records.sort((a, b) => b.savedAt.localeCompare(a.savedAt)) }))
  const monthly = Object.values(
    issues.reduce((result, issue) => {
      const month = issue.decidedAt.slice(0, 7)
      result[month] ||= { month, total: 0, accepted: 0 }
      result[month].total += 1
      if (['accepted', 'partial'].includes(issue.disposition)) result[month].accepted += 1
      return result
    }, {}),
  ).sort((a, b) => a.month.localeCompare(b.month))
  return {
    requirementCount: db.requirements.length,
    analyzedCount: db.requirements.filter((item) => item.status === 'analyzed').length,
    reviewCount: allReviews.length,
    opinionCount: issues.length,
    strictAcceptanceRate: decided.length ? Math.round((accepted / decided.length) * 1000) / 10 : 0,
    overallAcceptanceRate: decided.length ? Math.round((covered / decided.length) * 1000) / 10 : 0,
    products,
    allRecords,
    monthly,
  }
}

app.post('/api/auth/login', (request, response) => {
  const { username, password } = request.body || {}
  const user = db.users.find((item) => item.username === username)
  if (!user) return response.status(401).json({ message: '账号或密码错误' })
  const candidate = hashPassword(password || '', user.passwordSalt).hash
  const valid = crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.passwordHash, 'hex'))
  if (!valid) return response.status(401).json({ message: '账号或密码错误' })
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, { userId: user.id, createdAt: Date.now() })
  response.cookie('dip_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 })
  response.json({ user: publicUser(user) })
})

app.get('/api/auth/session', (request, response) => {
  const token = request.cookies.dip_session
  response.json({ authenticated: Boolean(token && sessions.has(token)) })
})

app.post('/api/auth/logout', requireAuth, (request, response) => {
  sessions.delete(request.cookies.dip_session)
  response.clearCookie('dip_session')
  response.json({ ok: true })
})

app.get('/api/bootstrap', requireAuth, (request, response) => {
  const analyticsData = analytics()
  const isAdmin = request.user.role === 'admin'
  response.json({
    user: publicUser(request.user),
    settings: publicSettings(),
    requirements: db.requirements.map(summarizeRequirement),
    analytics: isAdmin ? analyticsData : { ...analyticsData, allRecords: [] },
    optimizationRuns: isAdmin ? db.optimizationRuns.slice().reverse() : [],
  })
})

app.put('/api/settings', requireAuth, (request, response) => {
  const { apiKey, baseUrl, model } = request.body || {}
  if (typeof baseUrl === 'string' && baseUrl.trim()) db.settings.baseUrl = baseUrl.trim().replace(/\/$/, '')
  if (typeof model === 'string' && model.trim()) db.settings.model = model.trim()
  if (typeof apiKey === 'string' && apiKey.trim()) secrets.apiKey = apiKey.trim()
  if (apiKey === '') secrets.apiKey = ''
  saveDb()
  saveSecrets()
  response.json({ settings: publicSettings() })
})

app.post('/api/settings/test', requireAuth, async (_request, response) => {
  if (!(secrets.apiKey || environmentApiKey)) return response.status(400).json({ message: '请先配置 API Key' })
  try {
    const result = await callResponses('只回复“连接成功”。', [{ type: 'input_text', text: '测试模型连接。' }])
    response.json({ ok: true, message: result.slice(0, 40) || '连接成功' })
  } catch (error) {
    response.status(502).json({ message: error.message })
  }
})

app.post('/api/requirements', requireAuth, upload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) return response.status(400).json({ message: '请选择需求文档' })
  const extension = path.extname(file.originalname).toLowerCase()
  if (!['.md', '.markdown', '.docx'].includes(extension)) {
    fs.unlinkSync(file.path)
    return response.status(400).json({ message: '需求文档仅支持 MD 和 DOCX' })
  }
  const sourceText = await extractRequirementText(file.path, extension)
  const productName = String(request.body.productName || '').trim()
  const version = String(request.body.version || '').trim()
  const requirementName = String(request.body.requirementName || request.body.summary || '').trim().slice(0, 50)
  if (!productName || !version || !requirementName) return response.status(400).json({ message: '产品名称、版本号和需求名称不能为空' })
  const createdAt = now()
  const requirement = {
    id: uid('req'),
    productName,
    version,
    requirementName,
    summary: requirementName,
    status: 'uploaded',
    source: {
      filename: file.originalname,
      type: file.mimetype,
      text: sourceText,
      savedPath: file.filename,
    },
    currentAnalysisVersionId: '',
    analysisVersions: [],
    designVersions: [],
    competitorVersions: [],
    reviews: [],
    analysisFeedback: [],
    createdAt,
    updatedAt: createdAt,
  }
  db.requirements.unshift(requirement)
  saveDb()
  response.status(201).json({ requirement })
})

app.get('/api/requirements/:id', requireAuth, (request, response) => {
  const requirement = getRequirement(request.params.id)
  if (!requirement) return response.status(404).json({ message: '需求不存在' })
  response.json({ requirement })
})

app.get('/api/design-files/:fileId/preview', requireAuth, (request, response) => {
  const file = db.requirements
    .flatMap((requirement) => requirement.designVersions || [])
    .flatMap((version) => version.files || [])
    .find((item) => item.id === request.params.fileId)
  if (!file) return response.status(404).send('设计文件不存在')
  const absolutePath = path.resolve(uploadDir, file.savedPath)
  if (!absolutePath.startsWith(`${path.resolve(uploadDir)}${path.sep}`) || !fs.existsSync(absolutePath)) return response.status(404).send('设计文件不存在')
  if (!file.extension.includes('htm')) return response.sendFile(absolutePath)
  try {
    const assetBaseUrl = file.packageRoot ? `/uploads/${path.posix.dirname(file.savedPath).replace(/\\/g, '/')}/` : ''
    const preview = renderDesignPreviewHtml(fs.readFileSync(absolutePath, 'utf8'), file.name, { assetBaseUrl })
    response.type('html').send(preview)
  } catch (error) {
    response.status(500).type('html').send(`<!doctype html><meta charset="utf-8"><title>预览失败</title><p>设计稿预览生成失败：${String(error.message || error)}</p>`)
  }
})

app.delete('/api/requirements', requireAuth, (request, response) => {
  const ids = [...new Set(Array.isArray(request.body?.ids) ? request.body.ids.map(String) : [])]
  if (!ids.length) return response.status(400).json({ message: '请选择需要删除的需求' })
  const selected = ids.map((id) => getRequirement(id))
  const missingIds = ids.filter((_id, index) => !selected[index])
  if (missingIds.length) return response.status(404).json({ message: '部分需求已不存在，请刷新列表后重试' })
  const running = selected.filter((requirement) => requirement.status === 'analyzing' || activeAnalysisRuns.has(requirement.id))
  if (running.length) return response.status(409).json({ message: `“${running[0].productName}”正在解析，完成或停止后才能删除` })

  const selectedIds = new Set(ids)
  db.requirements = db.requirements.filter((requirement) => !selectedIds.has(requirement.id))
  saveDb()
  syncFeedbackExports()
  const cleanupWarnings = []
  for (const requirement of selected) {
    try {
      deleteRequirementFiles(requirement)
    } catch (error) {
      cleanupWarnings.push(requirement.id)
      console.error(`清理需求 ${requirement.id} 的本地文件失败`, error)
    }
  }
  response.json({ ok: true, deletedIds: ids, deletedCount: ids.length, cleanupWarnings })
})

app.put('/api/requirements/:id/source', requireAuth, (request, response) => {
  const requirement = getRequirement(request.params.id)
  if (!requirement) return response.status(404).json({ message: '需求不存在' })
  const text = String(request.body.text || '').trim()
  if (!text) return response.status(400).json({ message: '需求内容不能为空' })
  requirement.source.text = text
  requirement.updatedAt = now()
  saveDb()
  response.json({ requirement })
})

app.post('/api/requirements/:id/analyze', requireAuth, async (request, response) => {
  const requirement = getRequirement(request.params.id)
  if (!requirement) return response.status(404).json({ message: '需求不存在' })
  if (activeAnalysisRuns.has(requirement.id)) return response.status(409).json({ message: '该需求正在执行完整 Skill 解析，请勿重复提交。' })
  activeAnalysisRuns.add(requirement.id)
  requirement.status = 'analyzing'
  requirement.analysisProgress = {
    status: 'running',
    percent: 2,
    title: '正在准备完整 Skill 解析',
    detail: '正在建立独立运行目录并核对原始需求文件。',
    steps: [
      ['source', '原文读取与编号', '读取段落、表格、图片、批注和嵌入附件'],
      ['requirement', '需求结构解析', '生成业务泳道、A-F 分层、页面流程和逐页详情'],
      ['design', '设计要点归纳', '汇总跨页面约束、阻塞问题和全部页面风险'],
      ['competitor', '同类竞品分析', '整理竞品功能矩阵、证据和设计启示'],
      ['assemble', 'HTML 组装', '使用固定模板渲染交互式单文件 HTML'],
      ['validate', '完整度校验', '检查原文覆盖、页面对应关系和两张流程图'],
    ].map(([id, label, description]) => ({ id, label, description, status: 'pending' })),
    startedAt: now(),
    updatedAt: now(),
  }
  saveDb()
  try {
    const previous = getCurrentAnalysis(requirement)
    const baselineAnalysis = requirement.analysisVersions.reduce((best, version) => (version.analysisData?.pages?.length || 0) > (best?.pages?.length || 0) ? version.analysisData : best, previous?.analysisData)
    const answered = previous?.pendingItems.filter((item) => item.status === 'answered') || []
    const ignored = previous?.pendingItems.filter((item) => item.status === 'ignored') || []
    requirement.analysisProgress = {
      ...requirement.analysisProgress,
      percent: 35,
      title: '正在启动本地 Skill Runner',
      detail: '将通过多轮工具调用读取材料、生成产物并执行本地校验修复。',
      updatedAt: now(),
    }
    saveDb()
    const analysis = await generateAnalysisWithModel(requirement, answered, ignored, baselineAnalysis)
    const versionNo = requirement.analysisVersions.length + 1
    const version = {
      id: uid('analysis'),
      versionNo,
      changeReason: String(request.body.changeReason || '').trim() || (versionNo === 1 ? '首次解析' : '根据设计师反馈重新解析'),
      sourceText: requirement.source.text,
      html: analysis.html,
      pendingItems: (analysis.pendingItems || []).map((item) => ({
        id: uid('pending'),
        title: item.title,
        description: item.description,
        sourceHint: item.sourceHint || '',
        status: 'open',
        answer: '',
      })),
      skillVersion: requirementAnalysisSkill.version,
      pipelineMode: analysis.pipelineMode,
      pipelineSkill: analysis.pipelineSkill,
      validation: analysis.validation,
      analysisData: analysis.analysisData,
      runId: analysis.runId,
      artifactPath: analysis.artifactPath,
      createdAt: now(),
      createdBy: request.user.displayName,
    }
    requirement.summary = String(analysis.summary || requirement.summary).slice(0, 50)
    requirement.analysisVersions.push(version)
    requirement.currentAnalysisVersionId = version.id
    requirement.status = 'analyzed'
    requirement.analysisProgress = {
      ...(requirement.analysisProgress || {}),
      status: 'completed',
      percent: 100,
      title: '完整 Skill 解析已完成',
      detail: '正式解析版本已通过全部质量门禁。',
      updatedAt: now(),
    }
    requirement.updatedAt = now()
    saveDb()
    response.json({ requirement, version, mode: analysis.pipelineMode })
  } catch (error) {
    requirement.status = requirement.analysisVersions.length ? 'analyzed' : 'uploaded'
    requirement.analysisProgress = {
      ...(requirement.analysisProgress || {}),
      status: 'failed',
      title: '本次解析未完成',
      detail: error.message,
      updatedAt: now(),
    }
    requirement.updatedAt = now()
    saveDb()
    response.status(502).json({ message: error.message })
  } finally {
    activeAnalysisRuns.delete(requirement.id)
  }
})

app.post('/api/requirements/:id/restore/:versionId', requireAuth, (request, response) => {
  const requirement = getRequirement(request.params.id)
  const target = requirement?.analysisVersions.find((item) => item.id === request.params.versionId)
  if (!requirement || !target) return response.status(404).json({ message: '解析版本不存在' })
  const restored = {
    ...structuredClone(target),
    id: uid('analysis'),
    versionNo: requirement.analysisVersions.length + 1,
    changeReason: `从 V${target.versionNo} 恢复`,
    pendingItems: target.pendingItems.map((item) => ({ ...item, id: uid('pending') })),
    createdAt: now(),
    createdBy: request.user.displayName,
  }
  requirement.source.text = restored.sourceText
  requirement.analysisVersions.push(restored)
  requirement.currentAnalysisVersionId = restored.id
  requirement.status = 'analyzed'
  requirement.updatedAt = now()
  saveDb()
  response.json({ requirement })
})

app.put('/api/requirements/:id/pending/:pendingId', requireAuth, (request, response) => {
  const requirement = getRequirement(request.params.id)
  const analysis = requirement && getCurrentAnalysis(requirement)
  const pending = analysis?.pendingItems.find((item) => item.id === request.params.pendingId)
  if (!pending) return response.status(404).json({ message: '待确认项不存在' })
  const action = request.body.action
  if (action === 'answer') {
    const answer = String(request.body.answer || '').trim()
    if (!answer) return response.status(400).json({ message: '请填写确认答案' })
    pending.status = 'answered'
    pending.answer = answer
  } else if (action === 'ignore') {
    pending.status = 'ignored'
    pending.answer = String(request.body.reason || '').trim()
  } else if (action === 'restore') {
    pending.status = 'open'
    pending.answer = ''
  } else {
    return response.status(400).json({ message: '不支持的操作' })
  }
  requirement.updatedAt = now()
  saveDb()
  response.json({ requirement })
})

app.post('/api/requirements/:id/wireframe', requireAuth, async (request, response) => {
  const requirement = getRequirement(request.params.id)
  const analysis = requirement && getCurrentAnalysis(requirement)
  if (!requirement || !analysis) return response.status(404).json({ message: '请先完成需求解析后再生成线稿' })
  try {
    const wireframe = await generateWireframeWithSkill(requirement, analysis)
    analysis.wireframe = { ...wireframe, createdBy: request.user.displayName }
    requirement.updatedAt = now()
    saveDb()
    response.json({ requirement, wireframe: analysis.wireframe })
  } catch (error) {
    analysis.wireframe = {
      status: 'failed',
      skillVersion: 'wireframe-design',
      generatedAt: now(),
      createdBy: request.user.displayName,
      summary: '线稿生成失败',
      files: [],
      interactions: [],
      fields: [],
      navigation: [],
      error: error.message,
    }
    requirement.updatedAt = now()
    saveDb()
    response.status(502).json({ message: error.message, requirement, wireframe: analysis.wireframe })
  }
})

app.post('/api/requirements/:id/analysis-feedback', requireAuth, (request, response) => {
  const requirement = getRequirement(request.params.id)
  if (!requirement) return response.status(404).json({ message: '需求不存在' })
  const analysis = getCurrentAnalysis(requirement)
  const { category, target, description, expectedResult, generalizable } = request.body || {}
  if (!category || !description) return response.status(400).json({ message: '反馈类型和问题描述不能为空' })
  const feedback = {
    id: uid('af'),
    productName: requirement.productName,
    requirementName: requirement.requirementName || requirement.summary,
    productVersion: requirement.version,
    analysisVersionId: analysis?.id,
    analysisVersionNo: analysis?.versionNo,
    skillVersion: analysis?.skillVersion,
    model: analysis?.model || db.settings.model,
    category,
    target: target || '整体解析结果',
    description,
    expectedResult: expectedResult || '',
    generalizable: Boolean(generalizable),
    createdAt: now(),
    createdBy: request.user.displayName,
  }
  requirement.analysisFeedback.push(feedback)
  saveDb()
  syncFeedbackExports()
  response.status(201).json({ feedback, requirement })
})

app.post('/api/requirements/:id/designs', requireAuth, designUpload.array('files', 20), async (request, response) => {
  const requirement = getRequirement(request.params.id)
  if (!requirement) return response.status(404).json({ message: '需求不存在' })
  const files = request.files || []
  if (!files.length) return response.status(400).json({ message: '请选择设计稿' })
  const allowed = new Set(['.html', '.htm', '.jpg', '.jpeg', '.png', '.zip'])
  const invalid = files.find((file) => !allowed.has(path.extname(file.originalname).toLowerCase()))
  if (invalid) return response.status(400).json({ message: '设计稿仅支持 HTML、ZIP、JPG 和 PNG' })
  const designFiles = []
  try {
    for (const [index, file] of files.entries()) {
      const extension = path.extname(file.originalname).toLowerCase()
      if (extension === '.zip') {
        const extracted = await extractDesignArchive(file)
        designFiles.push({
          id: uid('file'),
          name: extracted.name,
          type: 'text/html',
          extension: path.extname(extracted.name).toLowerCase(),
          url: `/uploads/${extracted.savedPath}`,
          savedPath: extracted.savedPath,
          packageRoot: extracted.packageRoot,
          packageEntryPath: extracted.entryPath,
          archiveSavedPath: file.filename,
          archiveName: file.originalname,
          order: index + 1,
        })
      } else {
        designFiles.push({
          id: uid('file'),
          name: file.originalname,
          type: file.mimetype,
          extension,
          url: `/uploads/${file.filename}`,
          savedPath: file.filename,
          order: index + 1,
        })
      }
    }
  } catch (error) {
    for (const item of designFiles) {
      const packageDirectory = item.packageRoot ? resolveInside(uploadDir, item.packageRoot) : ''
      if (packageDirectory && fs.existsSync(packageDirectory)) fs.rmSync(packageDirectory, { recursive: true, force: true })
    }
    for (const file of files) {
      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path)
    }
    return response.status(400).json({ message: `设计稿 ZIP 无法读取：${error.message}` })
  }
  const version = {
    id: uid('design'),
    versionNo: requirement.designVersions.length + 1,
    files: designFiles,
    note: String(request.body.note || '').trim(),
    createdAt: now(),
    createdBy: request.user.displayName,
  }
  requirement.designVersions.push(version)
  requirement.updatedAt = now()
  saveDb()
  response.status(201).json({ requirement, version })
})

app.delete('/api/requirements/:id/designs', requireAuth, (request, response) => {
  const requirement = getRequirement(request.params.id)
  if (!requirement) return response.status(404).json({ message: '需求不存在' })
  if (requirement.reviews.some((review) => review.saved)) {
    return response.status(409).json({ message: '已有保存的评审记录引用当前设计稿，无法清空' })
  }
  deleteDesignVersionFiles(requirement.designVersions)
  requirement.designVersions = []
  requirement.reviews = []
  requirement.updatedAt = now()
  saveDb()
  response.json({ requirement })
})

app.post('/api/requirements/:id/competitors', requireAuth, competitorUpload.array('files', 20), async (request, response) => {
  const requirement = getRequirement(request.params.id)
  if (!requirement) return response.status(404).json({ message: '需求不存在' })
  const files = request.files || []
  const featureName = String(request.body.featureName || '').trim()
  if (!featureName) return response.status(400).json({ message: '请填写参考竞品的功能名称' })
  if (!files.length) return response.status(400).json({ message: '请选择竞品材料' })
  const allowed = new Set(['.xlsx', '.xls', '.jpg', '.jpeg', '.png'])
  const invalid = files.find((file) => !allowed.has(path.extname(file.originalname).toLowerCase()))
  if (invalid) return response.status(400).json({ message: '竞品材料仅支持 XLSX、XLS、PNG、JPG 和 JPEG' })
  const version = {
    id: uid('competitor'),
    versionNo: Math.max(0, ...requirement.competitorVersions.map((item) => item.versionNo)) + 1,
    featureName,
    files: files.map((file, index) => ({
      id: uid('file'),
      name: file.originalname,
      type: file.mimetype,
      extension: path.extname(file.originalname).toLowerCase(),
      url: `/uploads/${file.filename}`,
      savedPath: file.filename,
      order: index + 1,
    })),
    createdAt: now(),
    createdBy: request.user.displayName,
  }
  try {
    version.evidenceStats = await inspectCompetitorVersion(version, uploadDir)
  } catch (error) {
    return response.status(400).json({ message: `竞品材料无法读取：${error.message}` })
  }
  requirement.competitorVersions.push(version)
  requirement.updatedAt = now()
  saveDb()
  response.status(201).json({ requirement, version })
})

function toStoredReviewIssue(issue) {
  return {
    id: uid('issue'),
    type: issue.basis === 'competitor' ? '优化建议' : issue.type,
    process: issue.process,
    title: issue.title,
    detail: issue.detail,
    people: issue.people,
    severity: issue.severity || 'medium',
    conformity: issue.basis === 'competitor' ? 'conforming' : (issue.conformity || 'nonconforming'),
    basis: issue.basis || inferIssueBasis(issue),
    journeyStage: issue.journeyStage || '',
    validationDimension: issue.validationDimension || '',
    experienceLevel: issue.experienceLevel || '',
    userPerspective: issue.userPerspective || '',
    rootCause: issue.rootCause || '',
    userImpact: issue.userImpact || '',
    solution: issue.solution || '',
    analogousCheck: issue.analogousCheck || '',
    reviewCode: issue.reviewCode || '',
    reviewArea: issue.reviewArea || '',
    reviewPriority: issue.reviewPriority || '',
    confidence: issue.confidence || '',
    evidence: issue.evidence || '',
    verification: issue.verification || '',
    mustFix: Boolean(issue.mustFix),
    evidenceStatus: issue.evidenceStatus || 'sufficient',
    disposition: 'pending',
    reasonCategory: '',
    feedbackReason: '',
    decidedAt: '',
    annotation: issue.annotation && typeof issue.annotation === 'object' ? {
      pageName: String(issue.annotation.pageName || ''),
      pageFileName: String(issue.annotation.pageFileName || ''),
      anchorText: String(issue.annotation.anchorText || ''),
      x: Number.isFinite(Number(issue.annotation.x)) ? Number(issue.annotation.x) : undefined,
      y: Number.isFinite(Number(issue.annotation.y)) ? Number(issue.annotation.y) : undefined,
      width: Number.isFinite(Number(issue.annotation.width)) ? Number(issue.annotation.width) : undefined,
      height: Number.isFinite(Number(issue.annotation.height)) ? Number(issue.annotation.height) : undefined,
      coordinateMode: issue.annotation.coordinateMode === 'pixel' ? 'pixel' : 'normalized',
      confidence: Number.isFinite(Number(issue.annotation.confidence)) ? Number(issue.annotation.confidence) : undefined,
    } : null,
  }
}

function appendUniqueReviewIssues(review, issues) {
  const keys = new Set(review.issues.map((issue) => `${issue.basis}|${issue.title}|${issue.detail}`))
  for (const issue of issues || []) {
    const stored = toStoredReviewIssue(issue)
    const key = `${stored.basis}|${stored.title}|${stored.detail}`
    if (keys.has(key)) continue
    keys.add(key)
    review.issues.push(stored)
  }
}

app.post('/api/requirements/:id/reviews', requireAuth, async (request, response) => {
  const requirement = getRequirement(request.params.id)
  if (!requirement) return response.status(404).json({ message: '需求不存在' })
  const useReviewUiDesign = request.body?.useReviewUiDesign === true
  const analysis = getCurrentAnalysis(requirement)
  const design = requirement.designVersions.at(-1)
  const competitor = requirement.competitorVersions.at(-1)
  if (!String(requirement.source?.text || '').trim()) return response.status(400).json({ message: '没有可用于评审的需求内容' })
  if (!design) return response.status(400).json({ message: '请先上传设计稿' })
  try {
    const hasModel = Boolean(secrets.apiKey || environmentApiKey)
    const experienceSkill = analysis ? null : getValidateUserExperienceSkillBundle(requirement, design)
    const baseResult = hasModel
      ? (analysis
          ? await generateReviewWithModel(requirement, analysis, design)
          : await generateRawReviewWithModel(requirement, design, experienceSkill))
      : generateDemoReview(requirement, Boolean(analysis), experienceSkill?.version || '')
    const baseReviewPartial = Boolean(baseResult.partial)
    let uiDesignResult = null
    let uiDesignReviewStatus = useReviewUiDesign ? 'failed' : 'not_selected'
    let uiDesignReviewSkillVersion = ''
    let uiDesignReviewError = baseReviewPartial && useReviewUiDesign ? '基础评审仍有失败页面，请先完成失败页面重试' : ''
    if (useReviewUiDesign && !baseReviewPartial) {
      try {
        const skill = getReviewUiDesignSkillBundle()
        uiDesignReviewSkillVersion = skill.version
        uiDesignResult = hasModel
          ? await generateUiDesignReviewWithModel(requirement, analysis, design, skill.systemPrompt)
          : generateDemoUiDesignReview(requirement, design)
        uiDesignReviewStatus = 'completed'
      } catch (error) {
        uiDesignReviewError = error.message
      }
    }
    const baseWithUiDesign = uiDesignResult
      ? {
          summary: `${baseResult.summary} UI 专家评审：${uiDesignResult.summary}`,
          issues: [...(baseResult.issues || []), ...(uiDesignResult.issues || [])],
        }
      : baseResult
    let competitorResult = null
    let competitorStatus = competitor ? 'failed' : 'not_provided'
    let competitorError = baseReviewPartial && competitor ? '基础评审仍有失败页面，请先完成失败页面重试' : ''
    if (competitor && !baseReviewPartial) {
      try {
        competitorResult = hasModel
          ? await generateCompetitorReviewWithModel(requirement, analysis, design, competitor, baseWithUiDesign)
          : generateDemoCompetitorReview(competitor)
        competitorStatus = 'completed'
      } catch (error) {
        competitorError = error.message
      }
    }
    const result = mergeReviewOutputs(baseWithUiDesign, competitorResult)
    const review = {
      id: uid('review'),
      versionNo: Math.max(0, ...requirement.reviews.map((item) => item.versionNo)) + 1,
      saved: false,
      savedAt: '',
      discardedAt: '',
      requirementEvidenceMode: analysis ? 'analyzed' : 'raw',
      requirementSourceFilename: requirement.source.filename,
      analysisVersionId: analysis?.id || '',
      analysisVersionNo: analysis?.versionNo || 0,
      designVersionId: design.id,
      designVersionNo: design.versionNo,
      competitorVersionId: competitor?.id || '',
      competitorVersionNo: competitor?.versionNo || 0,
      competitorFeatureName: competitor?.featureName || '',
      competitorStatus,
      competitorError,
      competitorEvidenceStats: competitorResult?.evidenceStats || competitor?.evidenceStats || null,
      uiDesignReviewEnabled: useReviewUiDesign,
      uiDesignReviewStatus,
      uiDesignReviewSkillVersion,
      uiDesignReviewError,
      uiDesignReviewSummary: uiDesignResult?.summary || '',
      uiDesignReviewStrengths: uiDesignResult?.strengths || [],
      uiDesignReviewEvidenceLimitations: uiDesignResult?.evidenceLimitations || [],
      uiDesignReviewOpenQuestions: uiDesignResult?.openQuestions || [],
      baseReviewStatus: baseReviewPartial ? 'partial' : 'completed',
      baseReviewError: (baseResult.pageErrors || []).map((item) => `${item.pageName}：${item.message}`).join('；'),
      failedReviewPages: baseResult.failedPages || [],
      status: baseReviewPartial ? 'partial' : 'completed',
      baseSummary: baseWithUiDesign.summary,
      validationConclusion: baseResult.validationConclusion || '',
      experienceSkillVersion: baseResult.experienceSkillVersion || '',
      experienceValidationSummary: baseResult.experienceValidationSummary || '',
      experiencePositiveEvidence: baseResult.experiencePositiveEvidence || [],
      experienceGaps: baseResult.experienceGaps || [],
      experienceRetest: baseResult.experienceRetest || [],
      experienceTaskCoverage: baseResult.experienceTaskCoverage || [],
      rawEvidenceStats: baseResult.rawEvidenceStats || null,
      summary: result.summary,
      issues: (result.issues || []).map(toStoredReviewIssue),
      skillVersion: db.settings.reviewSkillVersion,
      model: db.settings.model,
      createdAt: now(),
      createdBy: request.user.displayName,
    }
    requirement.reviews.push(review)
    requirement.updatedAt = now()
    saveDb()
    response.status(201).json({ requirement, review, mode: hasModel ? 'model' : 'demo' })
  } catch (error) {
    response.status(502).json({ message: error.message })
  }
})

app.post('/api/requirements/:id/reviews/:reviewId/base-retry', requireAuth, async (request, response) => {
  const requirement = getRequirement(request.params.id)
  const review = requirement?.reviews.find((item) => item.id === request.params.reviewId)
  if (!review) return response.status(404).json({ message: '评审记录不存在' })
  if (review.saved) return response.status(409).json({ message: '已保存的评审记录不可重试' })
  if (review.status === 'discarded') return response.status(409).json({ message: '已放弃的评审记录不可重试' })
  if (review.baseReviewStatus !== 'partial' || !review.failedReviewPages?.length) {
    return response.status(409).json({ message: '当前评审没有需要重试的失败页面' })
  }
  if (!(secrets.apiKey || environmentApiKey)) return response.status(400).json({ message: '请先配置模型 API Key' })

  const analysis = requirement.analysisVersions.find((item) => item.id === review.analysisVersionId)
  const design = requirement.designVersions.find((item) => item.id === review.designVersionId)
  if (!analysis || !design) return response.status(400).json({ message: '缺少原评审使用的需求解析或设计稿版本' })

  try {
    const retryResult = await generateReviewWithModel(requirement, analysis, design, { pageNames: review.failedReviewPages })
    appendUniqueReviewIssues(review, retryResult.issues)
    review.baseSummary = [review.baseSummary, retryResult.summary].filter(Boolean).join(' ')
    review.failedReviewPages = retryResult.failedPages || []
    review.baseReviewError = (retryResult.pageErrors || []).map((item) => `${item.pageName}：${item.message}`).join('；')
    review.baseReviewStatus = retryResult.partial ? 'partial' : 'completed'
    review.status = retryResult.partial ? 'partial' : 'completed'

    if (!retryResult.partial) {
      const baseResult = {
        summary: review.baseSummary,
        issues: review.issues.filter((issue) => !['ui_review_skill', 'competitor'].includes(issue.basis)),
      }
      let uiDesignResult = null
      if (review.uiDesignReviewEnabled) {
        try {
          const skill = getReviewUiDesignSkillBundle()
          review.uiDesignReviewSkillVersion = skill.version
          uiDesignResult = await generateUiDesignReviewWithModel(requirement, analysis, design, skill.systemPrompt)
          review.uiDesignReviewStatus = 'completed'
          review.uiDesignReviewError = ''
          review.uiDesignReviewSummary = uiDesignResult.summary || ''
          review.uiDesignReviewStrengths = uiDesignResult.strengths || []
          review.uiDesignReviewEvidenceLimitations = uiDesignResult.evidenceLimitations || []
          review.uiDesignReviewOpenQuestions = uiDesignResult.openQuestions || []
          appendUniqueReviewIssues(review, uiDesignResult.issues)
        } catch (error) {
          review.uiDesignReviewStatus = 'failed'
          review.uiDesignReviewError = error.message
        }
      }

      const baseWithUiDesign = uiDesignResult
        ? { summary: `${baseResult.summary} UI 专家评审：${uiDesignResult.summary}`, issues: [...baseResult.issues, ...(uiDesignResult.issues || [])] }
        : baseResult
      const competitor = requirement.competitorVersions.find((item) => item.id === review.competitorVersionId)
      let competitorResult = null
      if (competitor) {
        try {
          competitorResult = await generateCompetitorReviewWithModel(requirement, analysis, design, competitor, baseWithUiDesign)
          review.competitorStatus = 'completed'
          review.competitorError = ''
          review.competitorEvidenceStats = competitorResult.evidenceStats || competitor.evidenceStats || null
          appendUniqueReviewIssues(review, competitorResult.issues)
        } catch (error) {
          review.competitorStatus = 'failed'
          review.competitorError = error.message
        }
      }
      review.summary = mergeReviewOutputs(baseWithUiDesign, competitorResult).summary
    } else {
      review.summary = `${review.baseSummary} 仍有 ${review.failedReviewPages.length} 个页面评审失败，可继续重试。`
    }

    requirement.updatedAt = now()
    saveDb()
    response.json({ requirement, review })
  } catch (error) {
    review.baseReviewError = error.message
    requirement.updatedAt = now()
    saveDb()
    response.status(502).json({ message: error.message, requirement, review })
  }
})

app.put('/api/requirements/:id/reviews/:reviewId/issues/:issueId', requireAuth, (request, response) => {
  const requirement = getRequirement(request.params.id)
  const review = requirement?.reviews.find((item) => item.id === request.params.reviewId)
  const issue = review?.issues.find((item) => item.id === request.params.issueId)
  if (!issue) return response.status(404).json({ message: '评审意见不存在' })
  if (review.saved) return response.status(409).json({ message: '已保存的评审记录不可修改' })
  if (review.status === 'discarded') return response.status(409).json({ message: '已放弃的评审记录不可修改' })
  const { disposition, reasonCategory, feedbackReason, conformity } = request.body || {}
  if (!['pending', 'accepted', 'partial', 'rejected', 'deferred'].includes(disposition)) {
    return response.status(400).json({ message: '评审状态不正确' })
  }
  if (['partial', 'rejected'].includes(disposition) && !String(feedbackReason || '').trim()) {
    return response.status(400).json({ message: '部分采纳或不采纳时必须填写理由' })
  }
  issue.disposition = disposition
  issue.conformity = conformity || issue.conformity
  issue.reasonCategory = reasonCategory || ''
  issue.feedbackReason = feedbackReason || ''
  issue.feedbackProductName = requirement.productName
  issue.feedbackRequirementName = requirement.requirementName || requirement.summary
  issue.feedbackProductVersion = requirement.version
  issue.feedbackModel = review.model || db.settings.model
  issue.feedbackUpdatedAt = now()
  issue.decidedAt = ['accepted', 'partial', 'rejected'].includes(disposition) ? now() : ''
  saveDb()
  syncFeedbackExports()
  response.json({ requirement, review })
})

app.post('/api/requirements/:id/reviews/:reviewId/save', requireAuth, (request, response) => {
  const requirement = getRequirement(request.params.id)
  const review = requirement?.reviews.find((item) => item.id === request.params.reviewId)
  if (!review) return response.status(404).json({ message: '评审记录不存在' })
  if (review.saved) return response.status(409).json({ message: '该评审记录已经保存' })
  if (review.status === 'discarded') return response.status(409).json({ message: '已放弃的评审记录不可保存' })
  if (review.baseReviewStatus === 'partial') return response.status(409).json({ message: '仍有失败页面，请完成重试后再保存评审记录' })
  review.saved = true
  review.savedAt = now()
  requirement.updatedAt = now()
  saveDb()
  syncFeedbackExports()
  response.json({ requirement, review })
})

app.delete('/api/requirements/:id/reviews/:reviewId', requireAuth, (request, response) => {
  const requirement = getRequirement(request.params.id)
  const reviewIndex = requirement?.reviews.findIndex((item) => item.id === request.params.reviewId) ?? -1
  if (!requirement || reviewIndex < 0) return response.status(404).json({ message: '评审记录不存在' })
  if (requirement.reviews[reviewIndex].saved) return response.status(409).json({ message: '已保存的评审记录不可删除' })
  requirement.reviews[reviewIndex].status = 'discarded'
  requirement.reviews[reviewIndex].discardedAt = now()
  requirement.updatedAt = now()
  saveDb()
  syncFeedbackExports()
  response.json({ requirement })
})

app.post('/api/requirements/:id/reviews/:reviewId/competitor-retry', requireAuth, async (request, response) => {
  const requirement = getRequirement(request.params.id)
  const review = requirement?.reviews.find((item) => item.id === request.params.reviewId)
  if (!review) return response.status(404).json({ message: '评审记录不存在' })
  if (review.saved) return response.status(409).json({ message: '已保存的评审记录不可修改' })
  if (review.status === 'discarded') return response.status(409).json({ message: '已放弃的评审记录不可修改' })
  const competitor = requirement.competitorVersions.find((item) => item.id === review.competitorVersionId)
  const design = requirement.designVersions.find((item) => item.id === review.designVersionId)
  const analysis = requirement.analysisVersions.find((item) => item.id === review.analysisVersionId)
  if (!competitor || !design) return response.status(400).json({ message: '该评审缺少可重试的竞品或设计稿版本' })
  const baseResult = { summary: review.baseSummary, issues: review.issues.filter((issue) => issue.basis !== 'competitor') }
  try {
    const competitorResult = (secrets.apiKey || environmentApiKey)
      ? await generateCompetitorReviewWithModel(requirement, analysis, design, competitor, baseResult)
      : generateDemoCompetitorReview(competitor)
    const merged = mergeReviewOutputs(baseResult, competitorResult)
    review.summary = merged.summary
    review.issues = [
      ...baseResult.issues,
      ...competitorResult.issues.map((issue) => ({
        id: uid('issue'), ...issue, type: '优化建议', basis: 'competitor', conformity: 'conforming',
        disposition: 'pending', reasonCategory: '', feedbackReason: '', decidedAt: '',
      })),
    ]
    review.competitorStatus = 'completed'
    review.competitorError = ''
    review.competitorEvidenceStats = competitorResult.evidenceStats || competitor.evidenceStats
    saveDb()
    response.json({ requirement, review })
  } catch (error) {
    review.competitorStatus = 'failed'
    review.competitorError = error.message
    saveDb()
    response.status(502).json({ message: error.message, requirement, review })
  }
})

app.post('/api/optimizations/:type/run', requireAuth, requireAdmin, async (request, response) => {
  const type = request.params.type
  if (!['requirement', 'review'].includes(type)) return response.status(400).json({ message: '优化类型不正确' })
  const optimizerSkill = type === 'requirement' ? requirementFeedbackOptimizerSkill : reviewFeedbackOptimizerSkill
  syncFeedbackExports()
  const samples = type === 'requirement'
    ? readJsonLines(requirementFeedbackPath)
    : readJsonLines(reviewFeedbackPath).filter((feedback) => feedback.reviewSaved && feedback.reviewStatus !== 'discarded')
  const report = (secrets.apiKey || environmentApiKey)
    ? await generateOptimizationWithModel(type, samples)
    : generateDemoOptimization(type, samples)
  const run = {
    id: uid('opt'),
    type,
    targetSkill: type === 'requirement' ? db.settings.requirementSkillVersion : db.settings.reviewSkillVersion,
    optimizerVersion: optimizerSkill.version,
    sampleCount: samples.length,
    status: 'candidate',
    report,
    createdAt: now(),
    createdBy: request.user.displayName,
  }
  db.optimizationRuns.push(run)
  saveDb()
  syncFeedbackExports()
  response.status(201).json({ run })
})

app.get('/api/analytics', requireAuth, (request, response) => {
  const analyticsData = analytics()
  response.json({ analytics: request.user.role === 'admin' ? analyticsData : { ...analyticsData, allRecords: [] } })
})

async function extractRequirementText(filePath, extension) {
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value.trim()
  }
  return fs.readFileSync(filePath, 'utf8').trim()
}

function makeSummary(text) {
  return text.replace(/[#>*_`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || '待补充需求概述'
}

const MODEL_REQUEST_TIMEOUT_MS = 120_000
const MODEL_REQUEST_MAX_ATTEMPTS = 3

function isDeepSeekBaseUrl(baseUrl = db.settings.baseUrl) {
  try {
    return new URL(baseUrl).hostname.endsWith('deepseek.com')
  } catch {
    return false
  }
}

/** 仅 OpenAI 官方默认走 Responses；其余自定义网关/兼容代理默认走 Chat Completions */
function preferChatCompletions(baseUrl = db.settings.baseUrl) {
  try {
    const host = new URL(baseUrl).hostname
    return !(host === 'api.openai.com' || host.endsWith('.openai.com'))
  } catch {
    return true
  }
}

function reviewModelConcurrency() {
  return isDeepSeekBaseUrl() ? 1 : 2
}

function isRetryableModelStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function isMissingEndpointStatus(status) {
  return status === 404 || status === 405
}

function waitForRetry(attempt) {
  const delay = 800 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250)
  return new Promise((resolve) => setTimeout(resolve, delay))
}

function modelTransportMessage(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '请求超时'
  const code = error?.cause?.code || error?.code || ''
  return code ? `网络连接失败（${code}）` : '网络连接失败'
}

function buildModelRequest(baseUrl, useChatCompletions, systemPrompt, userContent) {
  const url = `${baseUrl}${useChatCompletions ? '/chat/completions' : '/responses'}`
  const body = useChatCompletions
    ? {
      model: db.settings.model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: userContent.map((item) => item.type === 'input_image'
            ? { type: 'image_url', image_url: { url: item.image_url } }
            : { type: 'text', text: item.text }),
        },
      ],
    }
    : {
      model: db.settings.model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        { role: 'user', content: userContent },
      ],
      text: { verbosity: 'medium' },
    }
  return { url, body }
}

function extractModelOutputText(payload) {
  return payload.choices?.[0]?.message?.content || payload.output_text || payload.output
    ?.flatMap((item) => item.content || [])
    .map((item) => item.text || '')
    .join('') || ''
}

async function callModelEndpoint(url, body, apiKey) {
  for (let attempt = 1; attempt <= MODEL_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      if (attempt < MODEL_REQUEST_MAX_ATTEMPTS) {
        await waitForRetry(attempt)
        continue
      }
      throw new Error(`模型服务${modelTransportMessage(error)}，已自动重试 ${MODEL_REQUEST_MAX_ATTEMPTS} 次，请稍后重试失败页面`)
    }

    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = payload.error?.message || `模型调用失败（${response.status}）`
      if (isMissingEndpointStatus(response.status)) {
        const error = new Error(message)
        error.status = response.status
        error.missingEndpoint = true
        throw error
      }
      if (isRetryableModelStatus(response.status) && attempt < MODEL_REQUEST_MAX_ATTEMPTS) {
        await waitForRetry(attempt)
        continue
      }
      const suffix = isRetryableModelStatus(response.status) ? `，已自动重试 ${attempt} 次` : ''
      throw new Error(`${message}${suffix}`)
    }
    return extractModelOutputText(payload).trim()
  }
  throw new Error('模型调用失败')
}

async function callResponses(systemPrompt, userContent) {
  const apiKey = secrets.apiKey || environmentApiKey
  const baseUrl = db.settings.baseUrl.replace(/\/$/, '')
  const modes = preferChatCompletions(baseUrl) ? [true, false] : [false, true]
  let lastError

  for (let index = 0; index < modes.length; index += 1) {
    const useChatCompletions = modes[index]
    const { url, body } = buildModelRequest(baseUrl, useChatCompletions, systemPrompt, userContent)
    try {
      return await callModelEndpoint(url, body, apiKey)
    } catch (error) {
      lastError = error
      // 当前协议路径不存在时，自动改试另一种（Chat Completions ↔ Responses）
      if (error?.missingEndpoint && index < modes.length - 1) continue
      throw error
    }
  }
  throw lastError || new Error('模型调用失败')
}

async function generateAnalysisWithModel(requirement, answered, ignored, previousAnalysisData) {
  if (!(secrets.apiKey || environmentApiKey)) throw new Error('请先在模型设置中配置 API Key 后再解析需求')
  return runLocalSkillWithDeepSeek({
    requirement,
    answered,
    ignored,
    previousAnalysisData,
    dataDir,
    uploadDir,
    skillDir: localRequirementSkillDir,
    baseUrl: db.settings.baseUrl,
    model: db.settings.model,
    apiKey: secrets.apiKey || environmentApiKey,
    onProgress: (progress) => {
      requirement.analysisProgress = { ...requirement.analysisProgress, ...progress }
      saveDb()
    },
  })
}

function getReviewUiDesignSkillBundle() {
  const requiredFiles = [
    'SKILL.md',
    'references/visual-quality.md',
    'references/icon-quality.md',
    'references/interaction-quality.md',
    'references/design-system-quality.md',
    'references/report-template.md',
  ]
  const sections = requiredFiles.map((relativePath) => {
    const filePath = path.join(reviewUiDesignSkillDir, relativePath)
    if (!fs.existsSync(filePath)) throw new Error(`review-ui-design skill 文件缺失：${relativePath}`)
    return `\n\n===== ${relativePath} =====\n${fs.readFileSync(filePath, 'utf8')}`
  })
  const systemPrompt = sections.join('')
  return {
    systemPrompt,
    version: `review-ui-design-${crypto.createHash('sha256').update(systemPrompt).digest('hex').slice(0, 8)}`,
  }
}

function getValidateUserExperienceSkillBundle(requirement, design) {
  const sourceSignals = `${requirement.source?.text || ''}\n${(design.files || []).map((file) => file.name).join('\n')}`
  const includeInternationalization = /国际版|国际化|本地化|多语言|英文版|英语|English|RTL|i18n|locale/i.test(sourceSignals)
  const requiredFiles = [
    'SKILL.md',
    'references/evaluation-framework.md',
    'references/report-contract.md',
    'references/interaction-accessibility.md',
    'references/web-uiue-standard.md',
    ...(includeInternationalization ? ['references/internationalization.md'] : []),
  ]
  const sections = requiredFiles.map((relativePath) => {
    const filePath = path.join(validateUserExperienceSkillDir, relativePath)
    if (!fs.existsSync(filePath)) throw new Error(`validate-user-experience skill 文件缺失：${relativePath}`)
    return `\n\n===== ${relativePath} =====\n${fs.readFileSync(filePath, 'utf8')}`
  })
  const systemPrompt = sections.join('')
  return {
    systemPrompt,
    version: `validate-user-experience-${crypto.createHash('sha256').update(systemPrompt).digest('hex').slice(0, 8)}`,
  }
}

function getWireframeSkillPrompt() {
  const skillPath = path.join(wireframeSkillDir, 'SKILL.md')
  if (!fs.existsSync(skillPath)) throw new Error('wireframe-design skill 未安装，请先安装后再生成线稿。')
  return fs.readFileSync(skillPath, 'utf8')
}

function normalizeWireframeResult(result, requirement, analysis) {
  const files = (Array.isArray(result.files) ? result.files : []).map((file, index) => ({
    name: String(file.name || `${String(index + 1).padStart(2, '0')}-wireframe.svg`).replace(/[\\/:*?"<>|]/g, '-'),
    title: String(file.title || file.name || `线稿 ${index + 1}`),
    svg: String(file.svg || '').trim(),
  })).filter((file) => file.svg.startsWith('<svg') && file.svg.includes('</svg>'))
  if (!files.length) throw new Error('wireframe-design 未返回有效 SVG 线稿。')
  return {
    status: 'completed',
    skillVersion: 'wireframe-design',
    generatedAt: now(),
    summary: String(result.summary || `${requirement.productName} V${analysis.versionNo} 线稿`).slice(0, 220),
    files,
    interactions: (Array.isArray(result.interactions) ? result.interactions : []).map((item) => String(item)).filter(Boolean),
    fields: (Array.isArray(result.fields) ? result.fields : []).map((item) => ({
      page: String(item.page || ''),
      name: String(item.name || ''),
      type: String(item.type || ''),
      required: String(item.required || ''),
      description: String(item.description || ''),
    })).filter((item) => item.page || item.name),
    navigation: (Array.isArray(result.navigation) ? result.navigation : []).map((item) => ({
      from: String(item.from || ''),
      to: String(item.to || ''),
      trigger: String(item.trigger || ''),
      condition: String(item.condition || ''),
    })).filter((item) => item.from || item.to),
  }
}

function demoWireframe(requirement, analysis) {
  const data = analysis.analysisData || {}
  const pages = (data.pages || []).slice(0, 6)
  const sourcePages = pages.length ? pages : [{ id: 'main', name: requirement.productName, fields: [], interactionRules: [], steps: [] }]
  const files = sourcePages.map((page, index) => {
    const fields = (page.fields || []).slice(0, 6)
    const rows = fields.map((field, fieldIndex) => {
      const y = 170 + fieldIndex * 52
      return `<rect class="stroke" x="32" y="${y}" width="296" height="36"/><text class="text" x="44" y="${y + 23}">${escapeHtml(field.name || `字段${fieldIndex + 1}`)}</text>`
    }).join('')
    const actions = (page.interactionRules || page.steps || []).slice(0, 3).map((item, actionIndex) => {
      const x = 32 + actionIndex * 102
      return `<rect class="stroke" x="${x}" y="532" width="88" height="38"/><text class="text" x="${x + 12}" y="556">${escapeHtml(String(item).slice(0, 6) || '操作')}</text>`
    }).join('')
    const svg = `<svg width="360" height="640" viewBox="0 0 360 640" xmlns="http://www.w3.org/2000/svg"><style>.stroke{fill:none;stroke:#333;stroke-width:1.5}.stroke-thin{fill:none;stroke:#999;stroke-width:1}.text{font-family:sans-serif;font-size:14px;fill:#666}.text-title{font-family:sans-serif;font-size:18px;font-weight:bold;fill:#333}</style><rect class="stroke" x="0" y="0" width="360" height="640"/><line class="stroke-thin" x1="0" y1="42" x2="360" y2="42"/><text class="text-title" x="24" y="28">${escapeHtml(page.name || `页面${index + 1}`)}</text><rect class="stroke" x="24" y="64" width="312" height="72"/><text class="text" x="40" y="104">页面入口 / 状态 / 待确认提示</text>${rows || '<rect class="stroke" x="32" y="170" width="296" height="120"/><text class="text" x="44" y="232">字段区域</text>'}<line class="stroke-thin" x1="24" y1="500" x2="336" y2="500"/><text class="text" x="32" y="520">交互操作</text>${actions || '<rect class="stroke" x="32" y="532" width="88" height="38"/><text class="text" x="50" y="556">提交</text>'}</svg>`
    return { name: `${String(index + 1).padStart(2, '0')}-${page.id || 'screen'}.svg`, title: page.name || `页面${index + 1}`, svg }
  })
  return normalizeWireframeResult({
    summary: '已基于当前需求解析生成简化线稿，覆盖页面结构、字段区域和主要操作入口。',
    files,
    interactions: sourcePages.flatMap((page) => page.interactionRules || page.steps || []).map(String).slice(0, 12),
    fields: sourcePages.flatMap((page) => (page.fields || []).map((field) => ({ page: page.name, ...field }))),
    navigation: ((data.pageFlow || {}).edges || []).map((edge) => ({ from: edge.from, to: edge.to, trigger: edge.trigger || edge.label || '', condition: edge.condition || '' })),
  }, requirement, analysis)
}

async function generateWireframeWithSkill(requirement, analysis) {
  const skillPrompt = getWireframeSkillPrompt()
  if (!(secrets.apiKey || environmentApiKey)) return demoWireframe(requirement, analysis)
  const payload = {
    productName: requirement.productName,
    version: requirement.version,
    requirementSummary: requirement.summary,
    sourceText: requirement.source.text,
    analysisVersionNo: analysis.versionNo,
    pendingItems: analysis.pendingItems,
    analysisData: analysis.analysisData,
  }
  const text = await callResponses(`${skillPrompt}\n\n你现在作为平台内置 wireframe-design 生成器工作。只返回 JSON，不要 Markdown。`, [{ type: 'input_text', text: `请根据以下需求解析内容生成一份低保真 SVG 线稿。必须覆盖：页面字段、交互规则、操作步骤、页面跳转逻辑、待确认项提示。返回结构：{"summary":"","files":[{"name":"01-page.svg","title":"","svg":"<svg ...>...</svg>"}],"interactions":[],"fields":[{"page":"","name":"","type":"","required":"","description":""}],"navigation":[{"from":"","to":"","trigger":"","condition":""}]}。\n\n输入：\n${JSON.stringify(payload)}` }])
  return normalizeWireframeResult(parseJsonResponse(text), requirement, analysis)
}

function parseJsonResponse(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1))
    throw new Error('模型没有返回可解析的结构化结果')
  }
}

async function generateReviewWithModel(requirement, analysis, design, options = {}) {
  return generateModelDesignReview({
    requirement,
    analysis,
    design,
    uploadDir,
    callModel: callResponses,
    systemPrompt: designReviewSkill.systemPrompt,
    concurrency: reviewModelConcurrency(),
    ...options,
  })
}

async function generateRawReviewWithModel(requirement, design, experienceSkill) {
  return generateModelRawRequirementReview({
    requirement,
    design,
    uploadDir,
    callModel: callResponses,
    compliancePrompt: designReviewSkill.systemPrompt,
    experiencePrompt: experienceSkill.systemPrompt,
    experienceSkillVersion: experienceSkill.version,
    concurrency: reviewModelConcurrency(),
  })
}

async function generateUiDesignReviewWithModel(requirement, analysis, design, systemPrompt) {
  return generateModelUiDesignReview({ requirement, analysis, design, uploadDir, callModel: callResponses, systemPrompt, concurrency: reviewModelConcurrency() })
}

async function generateCompetitorReviewWithModel(requirement, analysis, design, competitor, baseReview) {
  return generateModelCompetitorComparison({ requirement, analysis, design, competitor, baseReview, uploadDir, callModel: callResponses })
}

function inferIssueBasis(issue) {
  if (issue.basis === 'competitor') return 'competitor'
  if (issue.basis === 'experience_skill') return 'experience_skill'
  if (issue.basis === 'validate_user_experience') return 'validate_user_experience'
  if (issue.basis === 'ui_review_skill') return 'ui_review_skill'
  return String(issue.type || '').includes('产品') || String(issue.type || '').includes('业务') ? 'requirement' : 'design_principle'
}

function mergeReviewOutputs(baseResult, competitorResult) {
  if (!competitorResult) return baseResult
  return {
    summary: `${baseResult.summary} 竞品对比：${competitorResult.summary}`,
    issues: [...(baseResult.issues || []), ...(competitorResult.issues || [])],
  }
}

async function generateOptimizationWithModel(type, samples) {
  const optimizer = type === 'requirement' ? requirementFeedbackOptimizerSkill : reviewFeedbackOptimizerSkill
  return parseJsonResponse(await callResponses(optimizer.systemPrompt, [{ type: 'input_text', text: JSON.stringify(samples) }]))
}

function demoAnalysisHtml(productName, summary, sourceText = '', answered = []) {
  const answerList = answered.length
    ? `<ul>${answered.map((item) => `<li><strong>${escapeHtml(item.title)}</strong>：${escapeHtml(item.answer)}</li>`).join('')}</ul>`
    : '<p>当前版本暂无已确认补充。</p>'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{font-family:"Microsoft YaHei",sans-serif;color:#172033;line-height:1.75;padding:32px;max-width:980px;margin:auto}h1{font-family:STZhongsong,serif;font-size:30px;border-bottom:3px solid #ff6b35;padding-bottom:12px}h2{margin-top:30px;color:#163d71}.lead{background:#f2f5f9;border-left:4px solid #2f6fed;padding:16px 18px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.card{border:1px solid #dbe1ea;padding:15px}.tag{display:inline-block;background:#e9f0ff;color:#174da5;padding:3px 9px;margin-right:6px;font-size:12px}</style></head><body><h1>${escapeHtml(productName)} · 需求解析</h1><div class="lead"><strong>需求概述：</strong>${escapeHtml(summary || '待补充')}<br><strong>解析版本：</strong>本地演示分析</div><h2>业务目标</h2><p>将需求材料转化为设计师可以直接执行和复核的页面、流程、字段、状态与风险约束，减少需求理解偏差。</p><h2>核心业务链路</h2><p><span class="tag">材料输入</span> → <span class="tag">信息解析</span> → <span class="tag">问题确认</span> → <span class="tag">结果更新</span> → <span class="tag">设计评审</span></p><h2>页面与能力建议</h2><div class="grid"><div class="card"><strong>列表页</strong><p>展示产品、版本、概述、解析状态、更新时间和可执行操作。</p></div><div class="card"><strong>详情页</strong><p>提供需求原文、解析结果、待确认项和版本历史。</p></div><div class="card"><strong>设计评审页</strong><p>关联已解析需求和设计稿版本，输出结构化评审意见。</p></div><div class="card"><strong>反馈优化页</strong><p>汇总可泛化反馈，生成 Skill 候选优化报告。</p></div></div><h2>状态与反馈</h2><ul><li>所有耗时任务需要显示处理中、成功和失败状态。</li><li>解析版本不得覆盖历史结果，恢复历史版本时创建新版本。</li><li>部分采纳和不采纳评审意见时必须填写理由。</li></ul><h2>已确认补充</h2>${answerList}<h2>需求原文摘要</h2><p>${escapeHtml(makeSummary(sourceText || summary || ''))}</p></body></html>`
}

function generateDemoReview(requirement, hasAnalysis = true, experienceSkillVersion = '') {
  const result = {
    summary: `已依据 ${requirement.productName} 的${hasAnalysis ? '最新需求解析结果' : '原始需求文档（轻量提取）'}完成设计稿检查，共识别 4 项需要确认或优化的问题。`,
    issues: [
      { type: '【体验】任务效率', process: 'UX设计与评审', title: '重新解析入口缺少批量反馈提示', detail: '设计稿将“重新解析”作为单一按钮，但没有提示本次会合并哪些已回复待确认项，用户无法预判操作影响。', people: '设计、产品经理', severity: 'high', conformity: 'partial' },
      { type: '【体验】易用性', process: 'UX设计与评审', title: '上传失败状态缺少可恢复操作', detail: '设计稿只有错误文案，没有保留已填写产品信息或提供重新选择文件的明确入口。', people: '设计、产品经理', severity: 'medium', conformity: 'nonconforming' },
      { type: '【体验】一致性', process: 'UX设计与评审', title: '版本标识在不同页面表达不一致', detail: '需求列表使用“第 3 版”，详情页使用“V3”，建议统一版本表达和时间信息结构。', people: '设计、产品经理', severity: 'low', conformity: 'partial' },
      { type: '【产品】业务设计缺陷', process: '需求设计与评审', title: '忽略待确认项后缺少恢复路径', detail: '需求明确要求忽略项可恢复，但当前设计稿未展示被忽略问题的查看和恢复入口。', people: '产品经理、设计、研发、测试', severity: 'high', conformity: 'nonconforming' },
    ],
  }
  if (!hasAnalysis) {
    result.summary = `已完整读取 ${requirement.productName} 的原始需求文档，并完成需求符合性和用户成功双轨评审。`
    result.validationConclusion = 'conditional'
    result.experienceSkillVersion = experienceSkillVersion
    result.experienceValidationSummary = '已使用 validate-user-experience 演示模式检查用户任务成功、失败恢复和证据缺口。'
    result.experiencePositiveEvidence = ['评审流程保留需求符合性与用户任务成功两类证据，不将启发式建议写成需求事实。']
    result.experienceGaps = ['当前未配置模型 API Key，动态交互、键盘、响应式和真实错误状态仍需在模型或运行环境中验证。']
    result.experienceRetest = ['配置模型后重新发起评审，复核核心任务、失败恢复和状态覆盖。']
    result.experienceTaskCoverage = []
    result.rawEvidenceStats = { sourceCharacters: requirement.source.text.length, chunkCount: 1, pageCount: 0, openQuestionCount: 0 }
    result.issues.push({
      type: '【体验】易用性', process: 'UX设计与评审', title: '失败后缺少明确恢复路径', detail: '用户看到失败反馈后，不清楚应修改什么以及如何重新尝试。',
      people: '设计、产品经理', severity: 'medium', conformity: 'nonconforming', basis: 'validate_user_experience', journeyStage: '结果',
      validationDimension: '可恢复性', experienceLevel: 'P2', userPerspective: '是不是只能退出后重新开始？', rootCause: '失败反馈没有连接到可执行的恢复动作。',
      userImpact: '用户可能重复操作、求助或直接放弃任务。', solution: '保留已填写内容，说明失败原因并提供修改和重试入口。',
      analogousCheck: '检查所有提交、异步任务和批量操作失败场景。', reviewCode: 'EVA-001', reviewPriority: 'P2', confidence: 'low',
      evidence: '演示模式，需结合真实设计证据复核。', verification: '失败后保留已填写内容，展示具体原因，并提供可执行的修改或重试入口。',
      mustFix: false, evidenceStatus: 'needs_confirmation',
    })
  }
  return result
}

function generateDemoUiDesignReview(requirement, design) {
  const pageName = design.files[0]?.name || `${requirement.productName} 设计稿`
  return {
    summary: `已使用 review-ui-design 演示模式完成 ${design.files.length} 个设计文件的视觉、交互、设计系统和无障碍检查。`,
    strengths: ['页面已建立基础内容分组，核心任务具备继续深化的结构基础。'],
    evidenceLimitations: ['当前未配置模型 API Key，本轮为演示结果，精确视觉结论需在真实模型评审中复核。'],
    openQuestions: ['需在可交互原型或实现环境中继续核对 hover、focus、loading、error 和键盘操作状态。'],
    issues: [
      {
        type: '【视觉】视觉质量', process: 'UX设计与评审', title: '主任务与次要信息的视觉层级需要进一步拉开',
        detail: `位置：${pageName} 主内容区；现象：主操作与辅助信息的视觉重量接近；影响：用户首次进入时需要额外判断当前页面的核心任务。`,
        people: '设计、产品经理', severity: 'high', conformity: 'nonconforming', basis: 'ui_review_skill',
        reviewCode: 'V1', reviewArea: 'visual', reviewPriority: 'P1', confidence: 'needs_review', evidence: '演示模式，需结合真实设计画面复核。',
        solution: '优先强化一个主焦点，并通过字重、位置和留白弱化次要信息，不增加无目的装饰。', verification: '缩小或轻微模糊页面后，首个视觉焦点仍应指向核心任务。',
        mustFix: true, evidenceStatus: 'needs_confirmation', annotation: { pageName, pageFileName: pageName, x: 50, y: 20, coordinateMode: 'normalized', confidence: 0.4 },
      },
      {
        type: '【无障碍】可访问性', process: 'UX设计与评审', title: '关键控件状态与操作热区需要在实现前形成验证基线',
        detail: `位置：${pageName} 交互控件；现象：静态材料无法确认焦点、键盘和实际热区；影响：实现后可能出现仅鼠标可用或小目标难操作的问题。`,
        people: '设计、研发、测试', severity: 'medium', conformity: 'partial', basis: 'ui_review_skill',
        reviewCode: 'A1', reviewArea: 'accessibility', reviewPriority: 'P2', confidence: 'needs_review', evidence: '静态设计材料不能证明实现层焦点与热区。',
        solution: '交付时补齐 focus、disabled、loading、error 等状态，并验证 Web 指针目标与键盘焦点顺序。', verification: '在实现环境完成键盘遍历、200% 文本缩放和目标尺寸检查。',
        mustFix: false, evidenceStatus: 'needs_confirmation', annotation: null,
      },
    ],
  }
}

function generateDemoCompetitorReview(competitor) {
  return {
    summary: `已结合“${competitor.featureName}”竞品材料完成补充对比，竞品差异仅作为优化机会。`,
    issues: [{
      type: '优化建议',
      process: 'UX设计与评审',
      title: '补充竞品常见的关键状态引导',
      detail: `参考“${competitor.featureName}”材料，建议核对当前设计是否覆盖首次使用、处理中与失败恢复的连续引导；该差异不作为需求不符合的判断依据。`,
      people: '设计、产品经理',
      severity: 'low',
      conformity: 'conforming',
      basis: 'competitor',
    }],
    evidenceStats: competitor.evidenceStats,
  }
}

function generateDemoOptimization(type, samples) {
  const requirement = type === 'requirement'
  return {
    overview: samples.length
      ? `本次汇总 ${samples.length} 条反馈，已区分项目特有补充与可泛化能力问题。`
      : '当前反馈样本较少，以下为基于现有规则生成的候选优化方向。',
    patterns: requirement
      ? ['待确认项容易混合“必须确认”和“优化建议”', '跨页面约束的来源引用不够明确', '部分输出缺少异常状态与恢复路径']
      : ['有效但暂不处理的意见容易被误判为 Skill 错误', '问题类型与研发流程的映射需要更多边界案例', '重复意见需要在同一页面和跨页面两个层级去重'],
    recommendations: requirement
      ? ['为每个待确认项增加“阻塞等级”和原文依据', '把页面级异常状态纳入固定输出检查表', '在提示词中明确项目事实不能直接沉淀为全局规则']
      : ['新增“意见有效但受排期限制”原因，避免污染负样本', '为任务效率与易用性补充相邻分类对照案例', '评审输出增加需求版本与设计稿版本引用'],
    regressionCases: requirement
      ? ['需求明确失败重试规则时，不应再次提出相同待确认项', '只有单页面需求时仍需检查空状态、错误状态和权限状态']
      : ['问题真实存在但选择延期时，应保留为有效意见', '设计合理但研发未还原时，应归入需求开发而非 UX 设计与评审'],
    risks: ['样本量不足时不得自动发布 Skill 新版本', '上线前需要固定回归集验证并保留旧版本回滚能力'],
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character])
}

if (fs.existsSync(path.join(rootDir, 'dist'))) {
  app.use(express.static(path.join(rootDir, 'dist')))
  app.get('/{*splat}', (_request, response) => response.sendFile(path.join(rootDir, 'dist', 'index.html')))
}

app.use((error, _request, response, _next) => {
  console.error(error)
  if (error instanceof multer.MulterError) return response.status(400).json({ message: `上传失败：${error.message}` })
  response.status(500).json({ message: error.message || '服务器发生错误' })
})

app.listen(port, '127.0.0.1', () => {
  console.log(`Design intelligence platform running at http://127.0.0.1:${port}`)
})
