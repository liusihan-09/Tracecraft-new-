<script setup lang="ts">
import { ref } from 'vue'
import { Connection, Key, Lock, Setting } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import type { BootstrapData } from '../types'
import PageTitle from '../components/PageTitle.vue'

const props = defineProps<{ data: BootstrapData }>()
const emit = defineEmits<{ refresh: [] }>()
const busy = ref('')
const form = ref({ apiKey: '', baseUrl: props.data.settings.baseUrl, model: props.data.settings.model })
async function save() { busy.value = 'save'; try { await api.saveSettings(form.value); form.value.apiKey = ''; emit('refresh'); ElMessage.success('模型设置已保存') } catch (error) { ElMessage.error((error as Error).message) } finally { busy.value = '' } }
async function test() { busy.value = 'test'; try { ElMessage.success((await api.testSettings()).message) } catch (error) { ElMessage.error((error as Error).message) } finally { busy.value = '' } }
</script>

<template>
  <PageTitle eyebrow="MODEL SETTINGS" title="模型与 API Key" description="API Key 仅保存在本地服务端数据目录，不会写入前端代码或 Git。" />
  <div class="settings-grid"><el-card shadow="never"><template #header><div class="card-header"><div><span class="eyebrow">COMPATIBLE MODEL API</span><h2>模型连接</h2></div><el-tag :type="data.settings.apiKeyConfigured ? 'success' : 'info'">{{ data.settings.apiKeyConfigured ? `已配置 ${data.settings.maskedApiKey}` : '未配置' }}</el-tag></div></template><el-form label-position="top" size="large"><el-form-item label="API Key"><el-input v-model="form.apiKey" type="password" show-password :prefix-icon="Key" :placeholder="data.settings.apiKeyConfigured ? '留空则保留当前 Key' : 'sk-...'" /></el-form-item><el-form-item label="服务地址"><el-input v-model="form.baseUrl" :prefix-icon="Connection" /><div class="form-help">填写到 /v1 或网关前缀即可。非 OpenAI 官方地址默认走 Chat Completions；若返回 404 会自动改试 Responses。</div></el-form-item><el-form-item label="模型"><el-input v-model="form.model" :prefix-icon="Setting" /><div class="form-help">默认使用平衡质量与速度的模型，也可以填写账号可用的模型名称。</div></el-form-item><el-space><el-button type="primary" :loading="busy === 'save'" @click="save">保存设置</el-button><el-button :loading="busy === 'test'" :disabled="!data.settings.apiKeyConfigured" @click="test">测试连接</el-button></el-space></el-form></el-card><el-space direction="vertical" fill size="large"><el-alert title="本地安全说明" description="当前版本面向本地 MVP，Key 保存在被 Git 忽略的服务端目录。正式部署时应切换到密钥管理服务，并启用 HTTPS、组织账号和权限控制。" type="success" :closable="false" show-icon /><el-card shadow="never"><template #header>当前生产版本</template><el-descriptions :column="1" border><el-descriptions-item label="需求解析">{{ data.settings.requirementSkillVersion }}</el-descriptions-item><el-descriptions-item label="设计评审">{{ data.settings.reviewSkillVersion }}</el-descriptions-item></el-descriptions></el-card></el-space></div>
</template>
