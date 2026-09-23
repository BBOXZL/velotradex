<template>
  <div class="page-container">
    <el-card class="config-card">
      <template #header>
        <div class="card-header">
          <div>
            <div class="title">Discord 实时接收</div>
            <div class="subtitle">实时接收白名单频道消息，并进入 AI 解析和自动交易链路</div>
          </div>
          <el-tag :type="statusTagType">{{ statusLabel }}</el-tag>
        </div>
      </template>

      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px" class="config-form">
        <el-form-item label="启用接收">
          <el-switch v-model="form.enabled" />
        </el-form-item>

        <el-form-item label="Token 类型" prop="tokenMode">
          <el-radio-group v-model="form.tokenMode">
            <el-radio-button label="bot">Bot Token</el-radio-button>
            <el-radio-button label="user">用户 Token</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="Token" prop="token">
          <el-input
            v-model="form.token"
            type="password"
            show-password
            autocomplete="off"
            :placeholder="tokenMasked ? `已保存：${tokenMasked}，留空则保留` : '请输入 Discord Token'"
          />
          <div class="help-text">Token 只在服务端保存，接口和日志不会返回完整值。</div>
        </el-form-item>

        <el-form-item label="频道白名单" prop="channelIds">
          <el-input
            v-model="channelIdsText"
            type="textarea"
            :rows="4"
            placeholder="每行一个频道 ID，也支持逗号分隔"
          />
          <div class="help-text">仅处理这些频道的新增和编辑消息，其他频道会被忽略。</div>
        </el-form-item>

        <el-form-item label="连接状态">
          <div class="status-grid">
            <span>状态：{{ statusLabel }}</span>
            <span>待处理：{{ status.pending ?? 0 }}</span>
            <span>频道：{{ status.channelCount ?? 0 }}</span>
            <span>最后消息：{{ formatTime(status.lastMessageAt) }}</span>
          </div>
          <el-alert v-if="status.error" type="error" :closable="false" :title="status.error" />
        </el-form-item>

        <el-form-item>
          <el-button :icon="Connection" :loading="testing" @click="testConnection">测试连接</el-button>
          <el-button type="primary" :icon="Check" :loading="saving" @click="save">保存并应用</el-button>
          <el-button :icon="Refresh" :loading="loading" @click="load">刷新状态</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Check, Connection, Refresh } from '@element-plus/icons-vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import request from '../utils/request'

const formRef = ref<FormInstance>()
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const tokenMasked = ref('')
const channelIdsText = ref('')
const timer = ref<number | null>(null)

const form = reactive({
  tokenMode: 'bot',
  token: '',
  channelIds: [] as string[],
  enabled: false,
})

const status = reactive<any>({
  state: 'stopped',
  pending: 0,
  channelCount: 0,
  lastMessageAt: null,
  error: null,
})

const rules: FormRules = {
  tokenMode: [{ required: true, message: '请选择 Token 类型', trigger: 'change' }],
  token: [{
    validator: (_rule, value, callback) => {
      if (!value && !tokenMasked.value) callback(new Error('请输入 Token'))
      else callback()
    },
    trigger: 'blur',
  }],
  channelIds: [{
    validator: (_rule, _value, callback) => {
      const ids = parseChannelIds()
      if (!ids.length || ids.some(id => !/^\d+$/.test(id))) callback(new Error('请输入有效的数字频道 ID'))
      else callback()
    },
    trigger: 'blur',
  }],
}

const statusLabel = computed(() => ({
  ready: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  failed: '连接失败',
  stopped: '已停用',
}[status.state as string] || status.state))

const statusTagType = computed(() => ({
  ready: 'success',
  connecting: 'warning',
  reconnecting: 'warning',
  failed: 'danger',
  stopped: 'info',
}[status.state as string] || 'info'))

const parseChannelIds = () => Array.from(new Set(
  channelIdsText.value.split(/[\n,]+/).map(id => id.trim()).filter(Boolean),
))

const formatTime = (value: string | number | null) => value ? new Date(value).toLocaleString() : '-'

const applyResponse = (data: any) => {
  form.tokenMode = data.tokenMode || 'bot'
  form.enabled = Boolean(data.enabled)
  form.channelIds = Array.isArray(data.channelIds) ? data.channelIds : []
  channelIdsText.value = form.channelIds.join('\n')
  form.token = ''
  tokenMasked.value = data.tokenMasked || ''
  Object.assign(status, data.status || {})
}

const load = async () => {
  loading.value = true
  try {
    const res = await request.get('/discord-config')
    applyResponse(res.data)
  } catch (error: any) {
    ElMessage.error(error.response?.data?.error || '获取 Discord 配置失败')
  } finally {
    loading.value = false
  }
}

const payload = () => ({
  tokenMode: form.tokenMode,
  token: form.token || 'keep-existing',
  channelIds: parseChannelIds(),
  enabled: form.enabled,
})

const testConnection = async () => {
  await formRef.value?.validateField(['tokenMode', 'token', 'channelIds'])
  testing.value = true
  try {
    const res = await request.post('/discord-config/test', payload())
    Object.assign(status, res.data.status || {})
    ElMessage.success('Discord 连接测试成功')
  } catch (error: any) {
    ElMessage.error(error.response?.data?.error || 'Discord 连接测试失败')
  } finally {
    testing.value = false
  }
}

const save = async () => {
  try {
    await formRef.value?.validate()
    saving.value = true
    const res = await request.put('/discord-config', payload())
    applyResponse(res.data)
    ElMessage.success('Discord 配置已保存并应用')
  } catch (error: any) {
    if (error?.response) ElMessage.error(error.response.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await load()
  timer.value = window.setInterval(async () => {
    try {
      const res = await request.get('/discord-config/status')
      Object.assign(status, res.data)
    } catch {
      // 状态轮询失败不覆盖当前配置表单
    }
  }, 5000)
})

onBeforeUnmount(() => {
  if (timer.value !== null) window.clearInterval(timer.value)
})
</script>

<style scoped>
.page-container {
  padding: 20px;
}
.config-card {
  max-width: 980px;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.title {
  font-size: 18px;
  font-weight: 600;
}
.subtitle,
.help-text {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-top: 6px;
}
.config-form {
  max-width: 760px;
}
.status-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  margin-bottom: 12px;
}
</style>
