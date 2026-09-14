import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { triggerHaptic } from '@/core/utils/helpers';
import { TMS_LIMITS } from '@/shared/constants';
import { useHorizontalSwipe, type HorizontalSwipeHandlers } from '@/shared/hooks/useHorizontalSwipe';
import { adjacentEmployeeTab, EMPLOYEE_NAV_TABS, type TabType } from '@/modules/tms/components/BottomNav';

interface ModalTabSwipeOptions {
  activeTab: TabType;
  disabled?: boolean;
  onClose: () => void;
  onNavigate: (tab: TabType) => void;
  surfaceRef: RefObject<HTMLElement | null>;
}

interface ModalTabSwipeResult {
  navigateFromModal: (tab: TabType) => void;
  swipeHandlers: HorizontalSwipeHandlers;
}

/**
 * Lets a full-screen modal participate in the same tab strip as its parent
 * page. A swipe crosses directly to the adjacent tab; at the end of the strip
 * it dismisses the modal instead of handing the gesture to the browser.
 */
export function useModalTabSwipe({
  activeTab,
  disabled = false,
  onClose,
  onNavigate,
  surfaceRef,
}: ModalTabSwipeOptions): ModalTabSwipeResult {
  const callbacksRef = useRef({ onClose, onNavigate });
  const navigationTimerRef = useRef<number | null>(null);
  callbacksRef.current = { onClose, onNavigate };

  const clearNavigationTimer = useCallback(() => {
    if (navigationTimerRef.current !== null) {
      window.clearTimeout(navigationTimerRef.current);
      navigationTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearNavigationTimer(), [clearNavigationTimer]);

  const canSwipe = useCallback(() => true, []);
  const handleSwipe = useCallback((direction: 'left' | 'right') => {
    triggerHaptic('light');
    const targetTab = adjacentEmployeeTab(activeTab, direction);
    callbacksRef.current.onClose();
    if (targetTab) callbacksRef.current.onNavigate(targetTab);
    return true;
  }, [activeTab]);

  const swipeHandlers = useHorizontalSwipe({
    onSwipe: handleSwipe,
    canSwipe,
    completeBeforeSwipe: true,
    disabled,
    minDistancePx: TMS_LIMITS.SWIPE_MODAL_CLOSE_PX,
    viewportRatio: TMS_LIMITS.SWIPE_MODAL_VIEWPORT_RATIO,
  });

  const navigateFromModal = useCallback((targetTab: TabType) => {
    triggerHaptic('light');
    const surface = surfaceRef.current;
    if (!surface || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      callbacksRef.current.onClose();
      callbacksRef.current.onNavigate(targetTab);
      return;
    }

    const currentIndex = EMPLOYEE_NAV_TABS.indexOf(activeTab);
    const targetIndex = EMPLOYEE_NAV_TABS.indexOf(targetTab);
    const direction = targetIndex >= currentIndex ? -1 : 1;
    clearNavigationTimer();
    surface.dataset.swipePhase = 'committing';
    surface.style.setProperty('--swipe-offset-x', `${surface.clientWidth * direction}px`);
    navigationTimerRef.current = window.setTimeout(() => {
      navigationTimerRef.current = null;
      callbacksRef.current.onClose();
      callbacksRef.current.onNavigate(targetTab);
      surface.style.removeProperty('--swipe-offset-x');
      delete surface.dataset.swipePhase;
    }, TMS_LIMITS.SWIPE_COMMIT_MS);
  }, [activeTab, clearNavigationTimer, surfaceRef]);

  return { navigateFromModal, swipeHandlers };
}
