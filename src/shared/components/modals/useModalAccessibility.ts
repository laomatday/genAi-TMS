import { useEffect, useRef, type RefObject } from 'react';

interface ModalAccessibilityOptions {
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
}

interface InertSnapshot {
  element: HTMLElement;
  wasInert: boolean;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

const modalStack: symbol[] = [];
let scrollLockCount = 0;
let previousBodyOverflow = '';
let previousBodyPaddingRight = '';

const lockBodyScroll = () => {
  if (scrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    previousBodyPaddingRight = document.body.style.paddingRight;

    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    if (scrollbarWidth > 0) {
      const currentPadding = Number.parseFloat(getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${currentPadding + scrollbarWidth}px`;
    }
    document.body.style.overflow = 'hidden';
  }
  scrollLockCount += 1;
};

const unlockBodyScroll = () => {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount !== 0) return;
  document.body.style.overflow = previousBodyOverflow;
  document.body.style.paddingRight = previousBodyPaddingRight;
};

const makeBackgroundInert = (modal: HTMLElement) => {
  const snapshots: InertSnapshot[] = [];
  let branch: HTMLElement = modal;
  let parent = branch.parentElement;

  while (parent) {
    Array.from(parent.children).forEach((child) => {
      if (!(child instanceof HTMLElement) || child === branch || child.dataset.modalExempt !== undefined) return;
      snapshots.push({ element: child, wasInert: child.inert });
      child.inert = true;
    });

    if (parent === document.body) break;
    branch = parent;
    parent = parent.parentElement;
  }

  return snapshots;
};

const restoreBackground = (snapshots: InertSnapshot[]) => {
  snapshots.forEach(({ element, wasInert }) => {
    element.inert = wasInert;
  });
};

const getFocusableElements = (modal: HTMLElement) => (
  Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => (
    element.tabIndex >= 0
    && element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0
  ))
);

/**
 * Gives an in-place modal the same keyboard and background behavior as a
 * native modal dialog, including safe handling for nested dialogs.
 */
export function useModalAccessibility<T extends HTMLElement = HTMLDivElement>(
  isOpen: boolean,
  onClose: () => void,
  options: ModalAccessibilityOptions = {},
) {
  const modalRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const optionsRef = useRef(options);
  onCloseRef.current = onClose;
  optionsRef.current = options;

  useEffect(() => {
    if (!isOpen || !modalRef.current) return;

    const modal = modalRef.current;
    const stackToken = Symbol('modal');
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const inertSnapshots = makeBackgroundInert(modal);

    modalStack.push(stackToken);
    lockBodyScroll();

    const focusFrame = window.requestAnimationFrame(() => {
      const preferredFocus = optionsRef.current.initialFocusRef?.current;
      const firstFocusable = getFocusableElements(modal)[0];
      (preferredFocus ?? firstFocusable ?? modal).focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== stackToken) return;

      if (event.key === 'Escape' && optionsRef.current.closeOnEscape !== false) {
        const escapeLayer = event.target instanceof Element
          ? event.target.closest('[data-modal-escape-layer="true"]')
          : null;
        if (escapeLayer) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusableElements = getFocusableElements(modal);
      if (focusableElements.length === 0) {
        event.preventDefault();
        modal.focus({ preventScroll: true });
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      const stackIndex = modalStack.lastIndexOf(stackToken);
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
      restoreBackground(inertSnapshots);
      unlockBodyScroll();

      window.requestAnimationFrame(() => {
        if (previouslyFocused?.isConnected && !previouslyFocused.inert) {
          previouslyFocused.focus({ preventScroll: true });
        }
      });
    };
  }, [isOpen]);

  return modalRef;
}
