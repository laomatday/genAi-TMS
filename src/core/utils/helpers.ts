export function getShortName(fullName: string) {
  if (!fullName) return '';
  const parts = String(fullName).trim().split(' ');
  return parts[parts.length - 1] ?? '';
}

type DateLike = Date | string | number | { toDate: () => Date } | null | undefined;
type HapticPattern = 'light' | 'medium' | 'heavy' | 'success' | 'error' | 'warning';

const EARTH_RADIUS_METERS = 6_371_000;
const DEGREES_TO_RADIANS = Math.PI / 180;
const HAPTIC_PATTERNS: Record<HapticPattern, number[]> = {
  light: [10],
  medium: [20],
  heavy: [40],
  success: [10, 30, 10],
  warning: [30, 50, 30],
  error: [50, 30, 50, 30, 50],
};

const hasToDate = (value: DateLike): value is { toDate: () => Date } =>
  typeof value === 'object' && value !== null && 'toDate' in value && typeof value.toDate === 'function';

export function formatDateString(dateInput: DateLike) {
  if (!dateInput) return '';
  let date: Date;
  if (hasToDate(dateInput)) date = dateInput.toDate();
  else if (dateInput instanceof Date) date = dateInput;
  else if (typeof dateInput === 'string' && dateInput.includes('-')) {
    const [year, month, day] = dateInput.slice(0, 10).split('-').map(Number);
    if (!year || !month || !day) return '';
    date = new Date(year, month - 1, day);
  } else date = new Date(dateInput as string | number);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

export function formatDateShort(dateInput: DateLike) {
  return formatDateString(dateInput);
}

export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const latitudeDelta = (lat2 - lat1) * DEGREES_TO_RADIANS;
  const longitudeDelta = (lon2 - lon1) * DEGREES_TO_RADIANS;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(lat1 * DEGREES_TO_RADIANS)
    * Math.cos(lat2 * DEGREES_TO_RADIANS)
    * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function timeToMinutes(timeStr: string) {
  if (!timeStr) return 0;
  const [hours, minutes] = String(timeStr).split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? (hours ?? 0) * 60 + (minutes ?? 0) : 0;
}

export function getCurrentTimeStr() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function getAvatarHtml(name: string, url: string) {
  if (url && url.length > 5 && !url.includes('ui-avatars.com')) return { type: 'img', src: url, alt: name };
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] || '';
  const last = parts[parts.length - 1] || '';
  const initials = parts.length === 1 ? first.slice(0, 2) : `${first[0] || ''}${last[0] || ''}`;
  return { type: 'initials', text: initials.toUpperCase() || '--' };
}

export function toISODateString(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function toLocalMonthString(date = new Date()) {
  return toISODateString(date).slice(0, 7);
}

export interface FeedbackPrefs {
  haptics: boolean;
  sound: boolean;
}

const FEEDBACK_PREFS_KEY = 'genai_feedback_prefs';
const FEEDBACK_PREFS_DEFAULT: FeedbackPrefs = { haptics: true, sound: true };
let feedbackPrefsCache: FeedbackPrefs | null = null;

export function getFeedbackPrefs(): FeedbackPrefs {
  if (feedbackPrefsCache) return feedbackPrefsCache;
  if (typeof window === 'undefined') return { ...FEEDBACK_PREFS_DEFAULT };
  try {
    const raw = window.localStorage.getItem(FEEDBACK_PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<FeedbackPrefs>) : {};
    feedbackPrefsCache = {
      haptics: parsed.haptics !== false,
      sound: parsed.sound !== false,
    };
  } catch {
    feedbackPrefsCache = { ...FEEDBACK_PREFS_DEFAULT };
  }
  return feedbackPrefsCache;
}

export function setFeedbackPrefs(next: Partial<FeedbackPrefs>): FeedbackPrefs {
  const merged = { ...getFeedbackPrefs(), ...next };
  feedbackPrefsCache = merged;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(FEEDBACK_PREFS_KEY, JSON.stringify(merged));
    } catch {
      // Preference persistence is best-effort; the in-memory value still applies for this session.
    }
  }
  return merged;
}

export function triggerHaptic(pattern: HapticPattern = 'light') {
  if (typeof navigator === 'undefined' || !navigator.vibrate) return;
  if (!getFeedbackPrefs().haptics) return;
  navigator.vibrate(HAPTIC_PATTERNS[pattern]);
}

export function playAudioChime(type: 'success' | 'warning' | 'error' = 'success') {
  if (typeof window === 'undefined') return;
  if (!getFeedbackPrefs().sound) return;
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.12); // G5
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
      osc.start(now);
      osc.stop(now + 0.4);
    } else if (type === 'warning') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    }
  } catch {
    // Graceful fallback if AudioContext is not allowed without prior user interaction
  }
}
