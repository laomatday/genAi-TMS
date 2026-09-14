import { useCallback, useRef, type TouchEventHandler } from 'react';
import { triggerHaptic } from '@/core/utils/helpers';
import { TMS_LIMITS } from '@/shared/constants';

interface TouchPoint {
  x: number;
  y: number;
}

interface ModalSwipeHandlers {
  onTouchStart: TouchEventHandler<HTMLElement>;
  onTouchMove: TouchEventHandler<HTMLElement>;
  onTouchEnd: TouchEventHandler<HTMLElement>;
  onTouchCancel: TouchEventHandler<HTMLElement>;
}

/**
 * Keeps the right-to-left gesture inside the current application layer. The
 * modal owns the gesture, blocks the browser's edge-navigation gesture and
 * calls its in-app back action after a deliberate horizontal swipe.
 */
export function useModalSwipeBack(onBack: () => void, disabled = false): ModalSwipeHandlers {
  const startRef = useRef<TouchPoint | null>(null);
  const endRef = useRef<TouchPoint | null>(null);

  const reset = useCallback(() => {
    startRef.current = null;
    endRef.current = null;
  }, []);

  const onTouchStart = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    if (disabled) return;
    const touch = event.touches[0];
    if (!touch) return;
    startRef.current = { x: touch.clientX, y: touch.clientY };
    endRef.current = null;
  }, [disabled]);

  const onTouchMove = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    if (!startRef.current || disabled) return;
    const touch = event.touches[0];
    if (!touch) return;
    endRef.current = { x: touch.clientX, y: touch.clientY };

    const distanceX = startRef.current.x - touch.clientX;
    const distanceY = startRef.current.y - touch.clientY;
    if (distanceX > 0 && Math.abs(distanceX) > Math.abs(distanceY)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [disabled]);

  const onTouchEnd = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    const start = startRef.current;
    const end = endRef.current;
    reset();
    if (!start || !end || disabled) return;

    const distanceX = start.x - end.x;
    const distanceY = start.y - end.y;
    if (distanceX <= TMS_LIMITS.SWIPE_MODAL_CLOSE_PX || Math.abs(distanceX) <= Math.abs(distanceY)) return;

    event.preventDefault();
    event.stopPropagation();
    triggerHaptic('light');
    onBack();
  }, [disabled, onBack, reset]);

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: reset };
}
