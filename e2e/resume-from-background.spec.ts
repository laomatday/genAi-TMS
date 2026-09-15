import { expect, test, type Page } from '@playwright/test';
import { openEmployeeApp } from './support/backend';

async function swipe(page: Page, direction: 'left' | 'right') {
  await page.evaluate(async (dir) => {
    const surface = document.querySelector('.employee-pager');
    if (!surface) throw new Error('pager surface not found');
    const box = surface.getBoundingClientRect();
    const y = box.top + box.height * 0.45;
    const from = dir === 'left' ? box.left + box.width * 0.8 : box.left + box.width * 0.2;
    const to = dir === 'left' ? box.left + box.width * 0.2 : box.left + box.width * 0.8;
    const fire = (type: string, x: number) => {
      const touch = new Touch({ identifier: 1, target: surface, clientX: x, clientY: y });
      surface.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [touch],
        targetTouches: type === 'touchend' ? [] : [touch],
        changedTouches: [touch],
      }));
    };
    fire('touchstart', from);
    for (let step = 1; step <= 6; step += 1) {
      fire('touchmove', from + ((to - from) * step) / 6);
      await new Promise((r) => setTimeout(r, 12));
    }
    fire('touchend', to);
  }, direction);
  await page.waitForTimeout(400);
}

/** What the OS does when the app goes to the background and comes back. */
async function backgroundAndReturn(page: Page, hiddenMs = 1200) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
  });
  await page.waitForTimeout(hiddenMs);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForTimeout(600);
}

test('the app still responds to swipe after returning from the background', async ({ page }) => {
  await openEmployeeApp(page);
  await page.getByRole('button', { name: 'Chấm công', exact: true }).last().click();
  await expect(page).toHaveURL(/tab=history/);
  await expect(page.getByRole('button', { name: /Tuần này/ }).first()).toBeVisible();

  await backgroundAndReturn(page);

  await swipe(page, 'left');
  await expect(page).toHaveURL(/historyView=month/);
});

test('taps still work after returning from the background', async ({ page }) => {
  await openEmployeeApp(page);
  await backgroundAndReturn(page);

  await page.getByRole('button', { name: 'Đề xuất', exact: true }).last().click();
  await expect(page).toHaveURL(/tab=requests/);
  await expect(page.getByRole('heading', { name: 'Đề xuất' })).toBeVisible();
});
