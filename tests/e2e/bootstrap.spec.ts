import { expect, test } from '@playwright/test';

test('shows login and bootstrap choices', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await page.getByRole('button', { name: '初始化' }).click();
  await expect(page.getByRole('heading', { name: '创建首位管理员' })).toBeVisible();
});
