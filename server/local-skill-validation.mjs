import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const unique = (values) => [...new Set(values.filter(Boolean))]

function pythonCandidates() {
  const bundled = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe') : ''
  return unique([
    process.env.DIP_PYTHON,
    bundled && fs.existsSync(bundled) ? bundled : '',
    process.platform === 'win32' ? 'py' : 'python3',
    process.platform === 'win32' ? 'python3' : 'python',
    'python',
  ]).map((command) => ({ command, prefix: command === 'py' ? ['-3'] : [] }))
}

function runPython(args, cwd) {
  const candidates = pythonCandidates()
  return new Promise((resolve) => {
    const attempt = (index) => {
      if (index >= candidates.length) return resolve({ ok: false, output: '未找到可用 Python；可通过 DIP_PYTHON 指定 Python 可执行文件。' })
      const candidate = candidates[index]
      const child = spawn(candidate.command, [...candidate.prefix, ...args], { cwd, windowsHide: true })
      let stdout = ''
      let stderr = ''
      let spawnFailed = false
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', () => {
        spawnFailed = true
        attempt(index + 1)
      })
      child.on('close', (code) => {
        if (!spawnFailed) resolve({ ok: code === 0, output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') })
      })
    }
    attempt(0)
  })
}

export async function validateExperienceReport(report, skillDir) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dip-ux-report-'))
  const reportPath = path.join(tempDir, 'report.json')
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
    const result = await runPython([path.join(skillDir, 'scripts', 'validate_report.py'), reportPath], tempDir)
    if (!result.ok) throw new Error(`validate-user-experience 报告校验失败：${result.output}`)
    return result.output
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export async function validateContrastChecks(checks, skillDir) {
  const results = []
  for (const [index, check] of (Array.isArray(checks) ? checks : []).entries()) {
    const foreground = String(check?.foreground || '')
    const background = String(check?.background || '')
    const mode = check?.mode === 'large' ? '--large-text' : check?.mode === 'non_text' ? '--non-text' : ''
    const args = [path.join(skillDir, 'scripts', 'contrast.py'), foreground, background, ...(mode ? [mode] : [])]
    const result = await runPython(args, skillDir)
    if (!result.ok) throw new Error(`review-ui-design 对比度校验第 ${index + 1} 项失败：${result.output}`)
    results.push({ ...check, validatorOutput: result.output })
  }
  return results
}
