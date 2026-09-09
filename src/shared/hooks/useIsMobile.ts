import { useEffect, useState } from 'react';

// "Mobile" here means a phone, not a tablet: a coarse pointer with a short
// side under 600 CSS px. Tablets (short side ~768+) and desktop windows,
// however narrow, are treated as desktop. Falls back to desktop when the
// environment can't be probed.
function detectPhone(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const shortSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
  return coarse && shortSide > 0 && shortSide < 600;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(detectPhone);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const update = () => setIsMobile(detectPhone());
    const pointerQuery = window.matchMedia('(pointer: coarse)');
    pointerQuery.addEventListener('change', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    update();
    return () => {
      pointerQuery.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return isMobile;
}
