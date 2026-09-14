import { useCallback, useRef } from 'react';
import { triggerHaptic } from '@/core/utils/helpers';
import { TMS_LIMITS } from '@/shared/constants';
import { useHorizontalSwipe, type HorizontalSwipeHandlers } from './useHorizontalSwipe';

/**
 * Native-style back gesture for full-screen application layers. It starts
 * only at the left edge and follows a rightward drag, so form controls and
 * ordinary horizontal content never compete with modal navigation.
 */
export function useModalSwipeBack(
  onBack: () => void,
  disabled = false,
): HorizontalSwipeHandlers {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  const handleSwipe = useCallback((direction: 'left' | 'right') => {
    if (direction !== 'right') return false;
    triggerHaptic('light');
    onBackRef.current();
    return true;
  }, []);

  const canSwipe = useCallback((direction: 'left' | 'right') => direction === 'right', []);
  const shouldStart = useCallback((_: EventTarget | null, __: HTMLElement, start: { x: number }) => (
    start.x <= TMS_LIMITS.SWIPE_EDGE_START_PX
  ), []);

  return useHorizontalSwipe({
    onSwipe: handleSwipe,
    disabled,
    minDistancePx: TMS_LIMITS.SWIPE_MODAL_CLOSE_PX,
    viewportRatio: TMS_LIMITS.SWIPE_MODAL_VIEWPORT_RATIO,
    canSwipe,
    shouldStart,
    completeBeforeSwipe: true,
  });
}
