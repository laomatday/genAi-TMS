import { expect, test, type Page } from '@playwright/test';
import { openEmployeeApp } from './support/backend';

/** Playwright has no swipe primitive, so the gesture is dispatched as the real
 *  touch sequence the pager listens for: several moves, far enough and fast
 *  enough to clear the distance and velocity thresholds. */
async function swipe(page: Page, direction: 'left' | 'right') {
  await page.evaluate(async (dir) => {
    const surface = document.querySelector('.employee-pager');
    if (!surface) throw new Error('pager surface not found');
    const box = surface.getBoundingClientRect();
    const y = box.top + box.height * 0.45;
    const from = dir === 'left' ? box.left + box.width * 0.8 : box.left + box.width * 0.2;
    const to = dir === 'left' ? box.left + box.width * 0.2 : box.left + box.width * 0.8;

    const touchAt = (x: number) => new Touch({ identifier: 1, target: surface, clientX: x, clientY: y });
    const fire = (type: string, x: number) => {
      const touch = touchAt(x);
      surface.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [touch],
        targetTouches: type === 'touchend' ? [] : [touch],
        changedTouches: [touch],
      }));
    };

    fire('touchstart', from);
    const steps = 6;
    for (let step = 1; step <= steps; step += 1) {
      fire('touchmove', from + ((to - from) * step) / steps);
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    fire('touchend', to);
  }, direction);
  // Let the settle animation finish before the next assertion.
  await page.waitForTimeout(400);
}

test('swiping walks a page\'s own views before it changes tab', async ({ page }) => {
  await openEmployeeApp(page);

  await page.getByRole('button', { name: 'Đề xuất', exact: true }).last().click();
  await expect(page).toHaveURL(/tab=requests/);

  // First swipe: Nghỉ phép -> Giải trình, still on the same tab.
  await swipe(page, 'left');
  await expect(page).toHaveURL(/requestView=explanations/);
  await expect(page).toHaveURL(/tab=requests/);

  // Second swipe: the views are exhausted, so the tab pager takes over.
  await swipe(page, 'left');
  await expect(page).toHaveURL(/tab=calendar/);
});

test('swiping walks the history week and month views', async ({ page }) => {
  await openEmployeeApp(page);

  await page.getByRole('button', { name: 'Chấm công', exact: true }).last().click();
  await expect(page).toHaveURL(/tab=history/);

  await swipe(page, 'left');
  await expect(page).toHaveURL(/historyView=month/);
  await expect(page).toHaveURL(/tab=history/);

  await swipe(page, 'right');
  await expect(page).not.toHaveURL(/historyView=month/);
  await expect(page).toHaveURL(/tab=history/);
});

test('swiping walks the directory branch chips', async ({ page }) => {
  await openEmployeeApp(page);

  await page.getByRole('button', { name: 'Danh bạ', exact: true }).last().click();
  await expect(page).toHaveURL(/tab=contacts/);
  await expect(page.getByRole('button', { name: /Tất cả/ })).toHaveAttribute('aria-pressed', 'true');

  // The mock directory sits in one branch, so there are two chips.
  await swipe(page, 'left');
  await expect(page.getByRole('button', { name: /Đà Nẵng 1/ }).first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/tab=contacts/);
});
