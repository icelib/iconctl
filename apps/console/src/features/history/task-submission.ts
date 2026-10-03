import type { Job } from '@iconctl/console-contracts'
import { shallowRef } from 'vue'

export function createTaskSubmission(options: {
  record: (job: Job) => void
  reveal: (job: Job, automatic?: boolean) => Promise<unknown>
}) {
  let generation = 0
  let disposed = false
  let pending = false
  const state = shallowRef<{ error: string, notice: string, late: Job[] }>({ error: '', notice: '', late: [] })
  function invalidate() {
    generation++
    state.value = { ...state.value, error: '', notice: '' }
  }
  async function submit(action: () => Promise<Job>, notice: string) {
    if (pending || disposed) {
      return
    }
    pending = true
    const request = generation
    state.value = { ...state.value, error: '', notice: '' }
    try {
      const job = await action()
      if (disposed) {
        return
      }
      options.record(job)
      if (request === generation) {
        const reveal = options.reveal(job, true)
        // The reveal itself changes navigation synchronously. Only subsequent
        // user navigation should suppress its completion notice.
        const revealedGeneration = generation
        const revealed = await reveal
        if (!disposed && revealed === false) {
          state.value = { ...state.value, late: [...state.value.late.filter(item => item.id !== job.id), job] }
        }
        else if (!disposed && generation === revealedGeneration) {
          state.value = { ...state.value, notice }
        }
      }
      else {
        state.value = { ...state.value, late: [...state.value.late.filter(item => item.id !== job.id), job] }
      }
    }
    catch (cause) {
      if (!disposed && request === generation) {
        state.value = { ...state.value, error: cause instanceof Error ? cause.message : '任务提交失败，请重试' }
      }
    }
    finally {
      pending = false
    }
  }
  async function locate(job: Job) {
    if (!disposed && await options.reveal(job) && !disposed) {
      state.value = { ...state.value, late: state.value.late.filter(item => item.id !== job.id) }
    }
  }
  function dispose() {
    disposed = true
    generation++
  }
  return { state, submit, invalidate, locate, dispose }
}
