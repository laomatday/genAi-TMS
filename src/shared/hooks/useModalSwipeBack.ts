import { useCallback, useRef } from 'react';
import { triggerHaptic } from '@/core/utils/helpers';
import { TMS_LIMITS } from '@/shared/constants';
import { useHorizontalSwipe, type HorizontalSwipeHandlers } from './useHorizontalSwipe';

/**
 * Keeps the right-to-left gesture inside the current application layer. The
 * modal owns the gesture, blocks the browser's edge-navigation gesture and
 * calls its in-app back action after a deliberate horizontal swipe.
 */
export function useModalSwipeBack(
  onBack: () => void,
  disabled = false,
): HorizontalSwipeHandlers {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  const handleSwipe = useCallback((direction: 'left' | 'right') => {
    if (direction !== 'left') return false;
    triggerHaptic('light');
    onBackRef.current();
    return true;
  }, []);

  const canSwipe = useCallback((direction: 'left' | 'right') => direction === 'left', []);

  return useHorizontalSwipe({
    onSwipe: handleSwipe,
    disabled,
    minDistancePx: TMS_LIMITS.SWIPE_MODAL_CLOSE_PX,
    viewportRatio: TMS_LIMITS.SWIPE_MODAL_VIEWPORT_RATIO,
    canSwipe,
    completeBeforeSwipe: true,
  });
}
