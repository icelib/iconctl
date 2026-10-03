import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

export const navigationDialog = (page: Page) => page.getByRole('dialog', { name: '离开项目编辑', exact: true })

export async function discardDraft(page: Page) {
  const dialog = navigationDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '放弃修改并继续', exact: true }).click()
  await expect(dialog).toBeHidden()
}
