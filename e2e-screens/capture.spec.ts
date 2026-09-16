import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { mockBackend, openEmployeeApp } from '../e2e/support/backend';

const OUT = 'screenshots';

/**
 * Viewport widths from playwright.screens.config.ts, used to route each suite to
 * its own project. A describe-level `test.skip` only receives fixtures, not the
 * project, and the three screens cannot be told apart by shape alone — the kiosk
 * is portrait like the phone and wide like the desktop — so the width is what
 * identifies them.
 */
const WIDTH = { mobile: 432, desktop: 1920, kiosk: 1080 } as const;

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

/**
 * Opens a modal by URL and captures it.
 *
 * Every overlay in the employee app is addressable as ?modal=<layer>, which is
 * what makes this reliable: the screen is reached the same way a deep link or a
 * browser Back would reach it, not by clicking a path through the UI that could
 * change shape.
 *
 * A modal that does not appear is collected and reported at the end of the test
 * rather than quietly producing a screenshot of whatever was behind it.
 */
async function shootModal(
  page: Page,
  project: string,
  name: string,
  url: string,
  missing: string[],
  selector = '[role="dialog"]',
) {
  await page.goto(url);
  const dialog = page.locator(selector).first();
  try {
    await expect(dialog).toBeVisible({ timeout: 10_000 });
  } catch {
    missing.push(`${name} (${url})`);
    return;
  }
  await shoot(page, project, name);
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
  test.skip(({ viewport }) => viewport?.width !== WIDTH.mobile, 'phone layout only');

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

    // The scanner. Opened through the home button rather than by URL so the
    // checks that guard it (attendance lock, connectivity) run for real.
    await page.getByRole('button', { name: /Chấm công/ }).first().click();
    const scanner = page.locator('[role="dialog"][aria-labelledby="qr-scanner-title"]');
    await expect(scanner).toBeVisible({ timeout: 15_000 });
    // Wait for the fake camera to deliver frames; a shot taken before the first
    // one shows an empty black stage rather than a viewfinder.
    await expect.poll(
      () => page.evaluate(() => {
        const video = document.querySelector('.scanner-stage video') as HTMLVideoElement | null;
        return video ? video.readyState >= 2 && video.videoWidth > 0 : false;
      }),
      { timeout: 15_000 },
    ).toBe(true);
    await shoot(page, project, '10-quet-qr');

    // Every remaining overlay, reached by its own URL.
    const missing: string[] = [];
    await page.goto('/?tab=profile');
    await expect(page.getByRole('heading', { name: /Hồ sơ|Nhân sự E2E/ }).first()).toBeVisible({ timeout: 15_000 });
    await shoot(page, project, '11-ho-so');

    await shootModal(page, project, '12-doi-mat-khau', '/?tab=profile&modal=profile-password', missing);
    await shootModal(page, project, '13-dang-xuat', '/?tab=profile&modal=profile-logout', missing);
    // Settings is opened through the header menu rather than its URL: deep
    // linking to ?modal=settings closes itself, because the sheet reports
    // "closed" on mount and setSettingsOpen(false) acts on exactly that layer.
    // The sub-layers survive it, which is why they are still linked directly.
    await page.goto('/?tab=home');
    const actionsMenu = page.getByRole('button', { name: 'Mở menu tác vụ' });
    await expect(actionsMenu).toBeVisible({ timeout: 15_000 });
    await actionsMenu.click();
    await page.getByRole('menuitem', { name: 'Cài đặt' }).click();
    const settings = page.getByRole('dialog', { name: 'Cài đặt' });
    try {
      await expect(settings).toBeVisible({ timeout: 10_000 });
      await shoot(page, project, '14-cai-dat');
    } catch {
      missing.push('14-cai-dat (header menu)');
    }
    await shootModal(page, project, '15-huong-dan', '/?tab=home&modal=settings-guide', missing);
    await shootModal(page, project, '16-ho-tro', '/?tab=home&modal=settings-support', missing);
    // A confirm is an alertdialog, not a dialog.
    await shootModal(page, project, '17-ket-thuc-ca', '/?tab=home&modal=checkout', missing, '[role="alertdialog"]');

    const explainDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    await shootModal(page, project, '18-giai-trinh', `/?tab=history&modal=explanation&date=${explainDate}`, missing);

    // Contact detail is the one overlay with no URL of its own; it opens from a
    // row in the directory.
    await page.goto('/?tab=contacts');
    const contact = page.getByText('Trần Minh Khoa').first();
    try {
      await expect(contact).toBeVisible({ timeout: 15_000 });
      await contact.click();
      await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 10_000 });
      await shoot(page, project, '19-chi-tiet-lien-he');
    } catch {
      missing.push('19-chi-tiet-lien-he (directory row)');
    }

    expect(missing, 'overlays that did not open').toEqual([]);
  });
});

test.describe('control center', () => {
  test.skip(({ viewport }) => viewport?.width !== WIDTH.desktop, 'desktop layout only');

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

    // The account editor, one shot per section. It carries more than thirty
    // controls, so the sections are the point of the screen.
    await page.getByRole('navigation', { name: 'Điều hướng quản trị' })
      .getByRole('button', { name: /^Tài khoản(,|$)/ }).first().click();
    // The rows are buttons carrying role="row", so they answer to neither the
    // button role nor a plain class match — the table's header shares the class.
    const firstAccount = page.locator('button.admin-account-row').first();
    await expect(firstAccount).toBeVisible({ timeout: 20_000 });
    await firstAccount.click();
    const editorSections: Array<[RegExp, string]> = [
      [/Hồ sơ/, '11-tai-khoan-ho-so'],
      [/Công việc/, '12-tai-khoan-cong-viec'],
      [/Truy cập/, '13-tai-khoan-truy-cap'],
      [/Quyền riêng/, '14-tai-khoan-quyen-rieng'],
    ];
    for (const [label, file] of editorSections) {
      const tab = page.locator('.admin-editor-tab').filter({ hasText: label }).first();
      await expect(tab).toBeVisible({ timeout: 10_000 });
      await tab.click();
      await shoot(page, project, file);
    }
  });
});


test.describe('kiosk station', () => {
  test.skip(({ viewport }) => viewport?.width !== WIDTH.kiosk, 'portrait kiosk screen only');

  test('qr station', async ({ page }, testInfo) => {
    const project = testInfo.project.name;
    await mockBackend(page);
    await page.goto('/');
    await page.getByLabel('Tài khoản').fill('admin@example.com');
    await page.locator('#login-password').fill('correct-password');
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.locator('#login-account')).toBeHidden({ timeout: 15_000 });

    await page.goto('/kiosk');
    // The station is only worth a picture once it is showing a live code.
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 20_000 });
    await shoot(page, project, '01-tram-qr');

    // A tight crop around the QR panel, used as the camera source for the
    // scanner shot so the code lands inside the scan window rather than off in
    // a corner of the frame.
    await mkdir('.cache', { recursive: true });
    const panel = await page.locator('.qr-panel').boundingBox();
    if (panel) {
      const pad = 70;
      await page.screenshot({
        path: '.cache/kiosk-qr.png',
        clip: { x: panel.x - pad, y: panel.y - pad, width: panel.width + pad * 2, height: panel.height + pad * 2 },
        scale: 'device',
      });
    }
  });
});
