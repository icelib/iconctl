<script setup lang="ts">
import type { ReportFormat } from './comparison-report'

defineProps<{ disabled: boolean, state: { pending: boolean, error: string, message: string } }>()
const emit = defineEmits<{ download: [format: ReportFormat] }>()
</script>

<template>
  <section class="report-downloads" aria-label="离线比较报告">
    <h3>离线比较报告</h3>
    <p class="help">
      下载当前审核的完整增删改与全部诊断，不受搜索或筛选影响。JSON 可用于脚本读取，HTML 可离线查看或打印。
    </p>
    <div class="report-actions">
      <button type="button" :disabled="disabled || state.pending" @click="emit('download', 'json')">
        下载比较 JSON
      </button>
      <button type="button" :disabled="disabled || state.pending" @click="emit('download', 'html')">
        下载比较 HTML
      </button>
    </div>
    <p v-if="state.message" role="status" aria-label="比较报告状态" class="help">
      {{ state.message }}
    </p>
    <p v-if="state.error" role="alert" aria-label="比较报告失败" class="message error">
      {{ state.error }}。可再次点击下载重试。
    </p>
  </section>
</template>

<style scoped>
.report-downloads {
  margin-top: 24px;
}

.report-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
