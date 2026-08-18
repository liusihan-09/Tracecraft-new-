<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Aim, Histogram, Checked, DataAnalysis, Document, Lock, Menu as MenuIcon,
  Operation, Setting, SwitchButton, User, UserFilled,
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from './api'
import type { BootstrapData } from './types'
import DashboardView from './views/DashboardView.vue'
import RequirementsView from './views/RequirementsView.vue'
import RequirementWorkspace from './views/RequirementWorkspace.vue'
import ReviewView from './views/ReviewView.vue'
import FeedbackView from './views/FeedbackView.vue'
import AnalyticsView from './views/AnalyticsView.vue'
import SettingsView from './views/SettingsView.vue'

type View = 'dashboard' | 'requirements' | 'requirement' | 'review' | 'feedback' | 'analytics' | 'settings'

const loading = ref(true)
const data = ref<BootstrapData | null>(null)
const view = ref<View>('dashboard')
const selectedRequirementId = ref('')
const reviewTarget = ref<{ requirementId: string; reviewId: string } | null>(null)
const mobileNav = ref(false)
const loginBusy = ref(false)
const loginForm = ref({ username: 'admin', password: 'admin123' })
const changePasswordVisible = ref(false)
const changePasswordBusy = ref(false)
const changePasswordForm = ref({
  username: '',
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
})

const isAdmin = computed(() => data.value?.user.role === 'admin')
const pageLabel = computed(() => ({
  dashboard: '工作台', requirements: '需求解析', requirement: '需求详情', review: '设计评审',
  feedback: '反馈优化', analytics: '评审数据', settings: '模型设置',
}[view.value]))

const navItems = computed(() => [
  { id: 'dashboard', label: '工作台', icon: Operation },
  { id: 'requirements', label: '需求解析', icon: Document },
  { id: 'review', label: '设计评审', icon: Checked },
  ...(isAdmin.value ? [{ id: 'feedback', label: '反馈优化', icon: Aim }] : []),
  { id: 'analytics', label: '评审数据', icon: Histogram },
  { id: 'settings', label: '模型设置', icon: Setting },
] as { id: View; label: string; icon: typeof Operation }[])

async function refresh() {
  const next = await api.bootstrap()
  data.value = next
  return next
}

async function login() {
  loginBusy.value = true
  try {
    await api.login(loginForm.value.username, loginForm.value.password)
    await refresh()
    ElMessage.success('欢迎进入 TRACECRAFT')
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    loginBusy.value = false
  }
}

function openChangePassword() {
  changePasswordForm.value = {
    username: loginForm.value.username,
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  }
  changePasswordVisible.value = true
}

async function submitChangePassword() {
  const username = changePasswordForm.value.username.trim()
  const currentPassword = changePasswordForm.value.currentPassword
  const newPassword = changePasswordForm.value.newPassword.trim()
  const confirmPassword = changePasswordForm.value.confirmPassword.trim()
  if (!username) {
    ElMessage.warning('请填写账号')
    return
  }
  if (!currentPassword) {
    ElMessage.warning('请填写当前密码')
    return
  }
  if (newPassword.length < 6) {
    ElMessage.warning('新密码至少 6 位')
    return
  }
  if (newPassword !== confirmPassword) {
    ElMessage.warning('两次输入的新密码不一致')
    return
  }

  changePasswordBusy.value = true
  try {
    const result = await api.changePassword({ username, currentPassword, newPassword })
    changePasswordVisible.value = false
    loginForm.value.username = username
    loginForm.value.password = ''
    ElMessage.success(result.message)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    changePasswordBusy.value = false
  }
}

async function logout() {
  await api.logout()
  data.value = null
  view.value = 'dashboard'
}

function navigate(next: View) {
  if (next === 'feedback' && !isAdmin.value) return
  if (next === 'review') reviewTarget.value = null
  view.value = next
  mobileNav.value = false
}

function openRequirement(id: string) {
  selectedRequirementId.value = id
  view.value = 'requirement'
  mobileNav.value = false
}

function openReview(requirementId: string, reviewId: string) {
  reviewTarget.value = { requirementId, reviewId }
  view.value = 'review'
  mobileNav.value = false
}

onMounted(async () => {
  try {
    const session = await api.session()
    if (session.authenticated) await refresh()
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div v-if="loading" class="full-loader">
    <el-icon class="is-loading" :size="38" color="#5968e8"><DataAnalysis /></el-icon>
    <span>正在装载工作台…</span>
  </div>

  <div v-else-if="!data" class="login-page">
    <el-card class="login-story" shadow="never">
      <div class="brand-line"><span class="brand-mark"><Aim /></span><strong>TRACECRAFT</strong></div>
      <div class="login-copy">
        <span class="eyebrow">DESIGN INTELLIGENCE PLATFORM</span>
        <h1>让需求、设计与评审，<em>在一条证据链上协作。</em></h1>
        <p>从原始需求到设计结论，每个版本、问题和反馈都有迹可循，让团队更快完成判断与协作。</p>
        <el-space wrap>
          <el-tag effect="plain" round><el-icon><Lock /></el-icon>证据可追溯</el-tag>
          <el-tag effect="plain" round><el-icon><Aim /></el-icon>AI 辅助分析</el-tag>
        </el-space>
      </div>
      <el-steps :active="4" simple finish-status="success" class="login-steps">
        <el-step title="需求材料" /><el-step title="结构化解析" /><el-step title="设计评审" /><el-step title="反馈优化" />
      </el-steps>
    </el-card>

    <el-card class="login-card" shadow="never">
      <el-form label-position="top" size="large" @submit.prevent="login">
        <span class="eyebrow">WELCOME BACK</span>
        <h2>登录设计工作台</h2>
        <p>使用平台账号进入需求与评审空间。</p>
        <el-form-item label="账号">
          <el-input v-model="loginForm.username" autocomplete="username" :prefix-icon="User" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="loginForm.password"
            type="password"
            show-password
            autocomplete="current-password"
            :prefix-icon="Lock"
          />
          <div class="login-password-actions">
            <el-button class="login-change-password" link type="primary" @click.prevent="openChangePassword">修改密码</el-button>
          </div>
        </el-form-item>
        <el-button type="primary" native-type="submit" :loading="loginBusy" size="large">进入工作台</el-button>
      </el-form>
    </el-card>

    <el-dialog
      v-model="changePasswordVisible"
      title="修改密码"
      width="420px"
      align-center
      destroy-on-close
    >
      <el-form label-position="top" size="large" @submit.prevent="submitChangePassword">
        <el-form-item label="账号">
          <el-input v-model="changePasswordForm.username" autocomplete="username" :prefix-icon="User" />
        </el-form-item>
        <el-form-item label="当前密码">
          <el-input
            v-model="changePasswordForm.currentPassword"
            type="password"
            show-password
            autocomplete="current-password"
            :prefix-icon="Lock"
          />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input
            v-model="changePasswordForm.newPassword"
            type="password"
            show-password
            autocomplete="new-password"
            :prefix-icon="Lock"
            placeholder="至少 6 位"
          />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input
            v-model="changePasswordForm.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
            :prefix-icon="Lock"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="changePasswordVisible = false">取消</el-button>
        <el-button type="primary" :loading="changePasswordBusy" @click="submitChangePassword">确认修改</el-button>
      </template>
    </el-dialog>
  </div>

  <el-container v-else class="app-shell">
    <el-aside class="desktop-aside" width="236px">
      <div class="brand-line sidebar-brand"><span class="brand-mark"><Aim /></span><div><strong>TRACECRAFT</strong><small>DESIGN INTELLIGENCE</small></div></div>
      <el-menu :default-active="view === 'requirement' ? 'requirements' : view" @select="(id: string) => navigate(id as View)">
        <el-menu-item v-for="item in navItems" :key="item.id" :index="item.id"><el-icon><component :is="item.icon" /></el-icon><span>{{ item.label }}</span></el-menu-item>
      </el-menu>
      <el-alert class="aside-status" title="闭环运行中" description="版本与反馈均可追溯" type="success" :closable="false" show-icon />
    </el-aside>

    <el-drawer v-model="mobileNav" direction="ltr" size="280px" :with-header="false" class="mobile-drawer">
      <div class="brand-line sidebar-brand"><span class="brand-mark"><Aim /></span><div><strong>TRACECRAFT</strong><small>DESIGN INTELLIGENCE</small></div></div>
      <el-menu :default-active="view === 'requirement' ? 'requirements' : view" @select="(id: string) => navigate(id as View)">
        <el-menu-item v-for="item in navItems" :key="item.id" :index="item.id"><el-icon><component :is="item.icon" /></el-icon><span>{{ item.label }}</span></el-menu-item>
      </el-menu>
    </el-drawer>

    <el-container>
      <el-header class="topbar">
        <el-space>
          <el-button class="mobile-menu" :icon="MenuIcon" circle aria-label="展开导航" @click="mobileNav = true" />
          <el-breadcrumb separator="/"><el-breadcrumb-item>TRACECRAFT</el-breadcrumb-item><el-breadcrumb-item>{{ pageLabel }}</el-breadcrumb-item></el-breadcrumb>
        </el-space>
        <el-space>
          <el-tag :type="data.settings.apiKeyConfigured ? 'success' : 'info'" round>{{ data.settings.apiKeyConfigured ? '模型已连接' : '演示模式' }}</el-tag>
          <el-avatar :icon="UserFilled" :size="30" /><span class="user-name">{{ data.user.displayName }}</span>
          <el-button :icon="SwitchButton" circle title="退出登录" @click="logout" />
        </el-space>
      </el-header>
      <el-main class="page-stage">
        <DashboardView v-if="view === 'dashboard'" :data="data" @navigate="navigate" @open-requirement="openRequirement" />
        <RequirementsView v-else-if="view === 'requirements'" :data="data" @refresh="refresh" @open="openRequirement" />
        <RequirementWorkspace v-else-if="view === 'requirement' && selectedRequirementId" :requirement-id="selectedRequirementId" @back="navigate('requirements')" @refresh="refresh" />
        <ReviewView v-else-if="view === 'review'" :data="data" :initial-target="reviewTarget" @refresh="refresh" />
        <FeedbackView v-else-if="view === 'feedback' && isAdmin" :data="data" @refresh="refresh" />
        <AnalyticsView v-else-if="view === 'analytics'" :data="data" />
        <SettingsView v-else-if="view === 'settings'" :data="data" @refresh="refresh" />
      </el-main>
    </el-container>
  </el-container>
</template>
