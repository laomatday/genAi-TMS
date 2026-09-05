import { useEffect, useRef, type KeyboardEvent, type RefCallback } from 'react';

interface ListboxNavigationOptions {
  isOpen: boolean;
  optionCount: number;
  selectedIndex: number;
  onOpen: () => void;
  onClose: () => void;
}

export function useListboxNavigation({
  isOpen,
  optionCount,
  selectedIndex,
  onOpen,
  onClose,
}: ListboxNavigationOptions) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusIndex = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen || pendingFocusIndex.current === null) return;
    const focusIndex = pendingFocusIndex.current;
    pendingFocusIndex.current = null;
    const frame = window.requestAnimationFrame(() => optionRefs.current[focusIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const queueOptionFocus = (index: number) => {
    if (optionCount === 0) return;
    const normalizedIndex = Math.max(0, Math.min(optionCount - 1, index));
    if (isOpen) optionRefs.current[normalizedIndex]?.focus();
    else {
      pendingFocusIndex.current = normalizedIndex;
      onOpen();
    }
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const fallbackIndex = event.key === 'ArrowDown' ? 0 : optionCount - 1;
      queueOptionFocus(selectedIndex >= 0 ? selectedIndex : fallbackIndex);
    } else if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      window.setTimeout(onClose, 0);
      return;
    }

    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (index + 1) % optionCount;
    else if (event.key === 'ArrowUp') nextIndex = (index - 1 + optionCount) % optionCount;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = optionCount - 1;

    if (nextIndex !== null) {
      event.preventDefault();
      optionRefs.current[nextIndex]?.focus();
    }
  };

  const registerOption = (index: number): RefCallback<HTMLButtonElement> => (element) => {
    optionRefs.current[index] = element;
  };

  return { triggerRef, registerOption, handleTriggerKeyDown, handleOptionKeyDown };
}
