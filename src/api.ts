import type { BootstrapData, Requirement, Settings } from './types'

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.message || '请求失败')
  return payload as T
}

export const api = {
  session: () => request<{ authenticated: boolean }>('/api/auth/session'),
  login: (username: string, password: string) =>
    request<{ user: BootstrapData['user'] }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  bootstrap: () => request<BootstrapData>('/api/bootstrap'),
  getRequirement: (id: string) => request<{ requirement: Requirement }>(`/api/requirements/${id}`),
  createRequirement: (form: FormData) => request<{ requirement: Requirement }>('/api/requirements', { method: 'POST', body: form }),
  deleteRequirements: (ids: string[]) => request<{ ok: true; deletedIds: string[]; deletedCount: number; cleanupWarnings: string[] }>('/api/requirements', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  }),
  saveSource: (id: string, text: string) => request<{ requirement: Requirement }>(`/api/requirements/${id}/source`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  }),
  analyze: (id: string, changeReason: string) => request<{ requirement: Requirement; mode: 'codex-skill' }>(`/api/requirements/${id}/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changeReason }),
  }),
  restoreVersion: (id: string, versionId: string) => request<{ requirement: Requirement }>(`/api/requirements/${id}/restore/${versionId}`, { method: 'POST' }),
  updatePending: (id: string, pendingId: string, body: object) => request<{ requirement: Requirement }>(`/api/requirements/${id}/pending/${pendingId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
  generateWireframe: (id: string) => request<{ requirement: Requirement }>(`/api/requirements/${id}/wireframe`, { method: 'POST' }),
  submitAnalysisFeedback: (id: string, body: object) => request<{ requirement: Requirement }>(`/api/requirements/${id}/analysis-feedback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
  uploadDesigns: (id: string, form: FormData) => request<{ requirement: Requirement }>(`/api/requirements/${id}/designs`, { method: 'POST', body: form }),
  clearDesigns: (id: string) => request<{ requirement: Requirement }>(`/api/requirements/${id}/designs`, { method: 'DELETE' }),
  uploadCompetitors: (id: string, form: FormData) => request<{ requirement: Requirement }>(`/api/requirements/${id}/competitors`, { method: 'POST', body: form }),
  runReview: (id: string, options: { useReviewUiDesign: boolean }) => request<{ requirement: Requirement; mode: 'model' | 'demo' }>(`/api/requirements/${id}/reviews`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options),
  }),
  updateIssue: (id: string, reviewId: string, issueId: string, body: object) => request<{ requirement: Requirement }>(`/api/requirements/${id}/reviews/${reviewId}/issues/${issueId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
  saveReview: (id: string, reviewId: string) => request<{ requirement: Requirement }>(`/api/requirements/${id}/reviews/${reviewId}/save`, { method: 'POST' }),
  discardReview: (id: string, reviewId: string) => request<{ requirement: Requirement }>(`/api/requirements/${id}/reviews/${reviewId}`, { method: 'DELETE' }),
  retryReviewPages: (id: string, reviewId: string) => request<{ requirement: Requirement }>(`/api/requirements/${id}/reviews/${reviewId}/base-retry`, { method: 'POST' }),
  retryCompetitor: (id: string, reviewId: string) => request<{ requirement: Requirement }>(`/api/requirements/${id}/reviews/${reviewId}/competitor-retry`, { method: 'POST' }),
  saveSettings: (body: { apiKey: string; baseUrl: string; model: string }) => request<{ settings: Settings }>('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
  testSettings: () => request<{ ok: true; message: string }>('/api/settings/test', { method: 'POST' }),
  changePassword: (body: { username: string; currentPassword: string; newPassword: string }) =>
    request<{ ok: true; message: string }>('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  runOptimization: (type: 'requirement' | 'review') => request<{ run: BootstrapData['optimizationRuns'][number] }>(`/api/optimizations/${type}/run`, { method: 'POST' }),
}
