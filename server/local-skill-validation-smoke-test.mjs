import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateContrastChecks, validateExperienceReport } from './local-skill-validation.mjs'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const skillsDir = path.join(serverDir, 'local-skills')

const report = {
  review: {
    title: '用户体验验证报告',
    mode: 'design',
    product: '测试产品',
    evidence_status: 'partial',
    conclusion: 'undetermined',
    summary: '静态证据不足，暂不判定。',
  },
  task_coverage: [{ id: 'TASK-01', name: '完成核心任务', role: '管理员', criticality: 'critical', status: 'not_tested', evidence: ['设计稿'], gaps: ['缺少运行状态'] }],
  positive_evidence: [],
  issues: [],
  cross_cutting_risks: [],
  gaps: ['缺少运行环境'],
  retest: ['补充运行环境后复测'],
}

const reportOutput = await validateExperienceReport(report, path.join(skillsDir, 'validate-user-experience'))
assert.match(reportOutput, /OK: report is valid/)

await assert.rejects(
  validateExperienceReport({ review: {} }, path.join(skillsDir, 'validate-user-experience')),
  /报告校验失败/,
)

const contrast = await validateContrastChecks([
  { foreground: '#333333', background: '#ffffff', mode: 'normal', location: '正文' },
], path.join(skillsDir, 'review-ui-design'))
assert.match(contrast[0].validatorOutput, /Contrast ratio:/)

console.log('local-skill-validation-smoke: ok')
