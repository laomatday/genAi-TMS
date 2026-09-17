import type { Page } from '@playwright/test';

/**
 * A swipe, sent as real touch events.
 *
 * The pager listens on `onTouchStart` and decides from the samples it collects:
 * it locks the axis after a few pixels, follows the finger, and reads the
 * recent velocity to tell a fling from a drag. Playwright's touchscreen API
 * only taps, and a mouse drag produces no touch events at all, so the gesture
 * is dispatched over CDP.
 *
 * The intermediate moves are the point. A start followed straight by an end
 * gives the pager a single sample, no measurable velocity, and it settles back
 * instead of changing tab — which on film looks like a swipe that did nothing.
 */
async function swipe(
  page: Page,
  { from, to, steps = 18, holdMs = 12 }: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    steps?: number;
    holdMs?: number;
  },
) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (x: number, y: number) => [{
    x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1,
  }];

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(from.x, from.y) });
  for (let step = 1; step <= steps; step += 1) {
    // Ease out, so the finger decelerates the way a real one does rather than
    // arriving at constant speed and stopping dead.
    const progress = 1 - (1 - step / steps) ** 2;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: touch(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress),
    });
    await page.waitForTimeout(holdMs);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Left moves to the next tab, right to the previous — as on the device. */
export async function swipeTab(page: Page, direction: 'left' | 'right') {
  const size = page.viewportSize();
  if (!size) throw new Error('swipeTab needs a viewport');
  const y = Math.round(size.height * 0.55);
  const near = Math.round(size.width * 0.12);
  const far = Math.round(size.width * 0.88);
  await swipe(page, direction === 'left'
    ? { from: { x: far, y }, to: { x: near, y } }
    : { from: { x: near, y }, to: { x: far, y } });
}
