import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { mockBackend, openEmployeeApp } from '../e2e/support/backend';

const OUT = 'screenshots';

/** Full page, or just the device-sized frame? Set SCREENS_FULL_PAGE=1 for the
 *  whole scrollable document, which is what documentation usually wants; the
 *  default is the viewport, which is what a device actually shows. */
const fullPage = process.env.SCREENS_FULL_PAGE === '1';

/**
 * Captures one element on a transparent background, with a margin so a floating
 * bar keeps the drop shadow that defines its edge — an element-only screenshot
 * clips exactly at the box and cuts the shadow off.
 *
 * Everything else is hidden with `visibility`, not `display`, so the element
 * stays exactly where the real layout puts it; `display: none` on its
 * surroundings would move it before the shutter.
 */
async function shootElement(page: Page, project: string, name: string, selector: string, margin = 28) {
  await mkdir(`${OUT}/${project}`, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no box to capture`);

  const styleId = await page.evaluate((target) => {
    const style = document.createElement('style');
    style.id = 'capture-isolate';
    style.textContent = `
      html, body { background: transparent !important; }
      body * { visibility: hidden !important; }
      ${target}, ${target} * { visibility: visible !important; }
    `;
    document.head.append(style);
    return style.id;
  }, selector);

  const view = page.viewportSize();
  await page.screenshot({
    path: `${OUT}/${project}/${name}.png`,
    clip: {
      x: Math.max(0, box.x - margin),
      y: Math.max(0, box.y - margin),
      width: Math.min((view?.width ?? box.width) - Math.max(0, box.x - margin), box.width + margin * 2),
      height: Math.min((view?.height ?? box.height) - Math.max(0, box.y - margin), box.height + margin * 2),
    },
    omitBackground: true,
    scale: 'device',
  });

  await page.evaluate((id) => document.getElementById(id)?.remove(), styleId);
}

async function shoot(page: Page, project: string, name: string) {
  await mkdir(`${OUT}/${project}`, { recursive: true });
  // Web fonts decide glyph widths, so a shot taken before they land is laid out
  // with fallback metrics and reflows a moment later.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${project}/${name}.png`, fullPage, scale: 'device' });
}

test.describe('employee app', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 768, 'phone layout only');

  test('every tab', async ({ page }, testInfo) => {
    const project = testInfo.project.name;

    // Sign-in is the one screen that exists before a session does.
    await mockBackend(page);
    await page.goto('/');
    await expect(page.locator('#login-account')).toBeVisible();
    await shoot(page, project, '01-dang-nhap');

    await openEmployeeApp(page);
    await shoot(page, project, '02-trang-chu');

    const tabs: Array<[string, string]> = [
      ['Chấm công', '03-cham-cong'],
      ['Đề xuất', '04-de-xuat'],
      ['Lịch', '05-lich'],
      ['Danh bạ', '06-danh-ba'],
    ];
    for (const [label, file] of tabs) {
      await page.getByRole('button', { name: label, exact: true }).last().click();
      await expect(page).toHaveURL(new RegExp(`tab=`));
      await shoot(page, project, file);
    }

    // Secondary screens reached from the header rather than the bottom bar.
    await page.getByRole('button', { name: /Thông báo/ }).first().click();
    await shoot(page, project, '07-thong-bao');

    await page.getByRole('button', { name: 'Đề xuất', exact: true }).last().click();
    await page.getByRole('button', { name: 'Tạo đề xuất mới' }).click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await shoot(page, project, '08-tao-de-xuat');

    // The bottom bar on its own, back on the home tab so the first item is lit.
    await page.goBack();
    await page.getByRole('button', { name: 'Trang chủ', exact: true }).last().click();
    await shootElement(page, project, '09-thanh-dieu-huong', 'nav[aria-label="Điều hướng chính"]');
  });
});

test.describe('control center', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 768, 'desktop layout only');

  test('portal and admin sections', async ({ page }, testInfo) => {
    const project = testInfo.project.name;

    await mockBackend(page);
    await page.goto('/');
    await expect(page.locator('#login-account')).toBeVisible();
    await shoot(page, project, '01-dang-nhap');

    await page.getByLabel('Tài khoản').fill('admin@example.com');
    await page.locator('#login-password').fill('correct-password');
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.locator('#login-account')).toBeHidden({ timeout: 15_000 });
    await shoot(page, project, '02-cong-lam-viec');

    await page.goto('/admin');
    await expect(page.getByRole('navigation', { name: 'Điều hướng quản trị' })).toBeVisible({ timeout: 20_000 });
    await shoot(page, project, '03-tong-quan');

    // Labels come from ADMIN_NAV. A section missing from the sidebar is gated
    // off for this role, so it is reported rather than silently skipped.
    const sections: Array<[string, string]> = [
      ['Tài khoản', '04-tai-khoan'],
      ['Phân ca', '05-phan-ca'],
      ['Chấm công', '06-cham-cong'],
      ['Tham số hệ thống', '07-tham-so-he-thong'],
      ['Kiosk', '08-kiosk'],
      ['Nhật ký', '09-nhat-ky'],
    ];
    const missing: string[] = [];
    for (const [label, file] of sections) {
      // A section with work waiting carries a count in its accessible name
      // ("Chấm công, 1 mục cần xử lý"), so match the label as a prefix.
      const tab = page.getByRole('navigation', { name: 'Điều hướng quản trị' })
        .getByRole('button', { name: new RegExp(`^${label}(,|$)`) });
      if (!(await tab.count())) { missing.push(label); continue; }
      await tab.first().click();
      await shoot(page, project, file);
    }
    expect(missing, 'admin sections absent from the sidebar').toEqual([]);

    await shootElement(page, project, '10-thanh-dieu-huong', 'nav[aria-label="Điều hướng quản trị"]');
  });
});
