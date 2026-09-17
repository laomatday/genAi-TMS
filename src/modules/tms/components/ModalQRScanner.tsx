import { useEffect, useRef, useState } from 'react';
// Emitted into the build as an asset and served from this origin. The polyfill
// below fetches it from jsDelivr otherwise; see resolveBarcodeDetectorCtor.
// The file is taken from the zxing-wasm installed alongside barcode-detector,
// which pins the same version it bundles, so the two cannot drift apart.
import zxingWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import IconButton from '@/shared/components/common/IconButton';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { TMS_LIMITS } from '@/shared/constants';
import { useModalSwipeBack } from '@/shared/hooks/useModalSwipeBack';

interface Props {
  onClose: () => void;
  onScan: (data: string) => void;
  onError: (msg: string) => void;
}

type ScannerStatus = 'starting' | 'scanning' | 'error';

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
}

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

const SCANNER_ELEMENT_ID = 'qr-reader';
const REAR_CAMERA_PATTERN = /back|rear|environment|world|camera sau/i;
const DETECT_INTERVAL_MS = Math.max(50, Math.round(1000 / TMS_LIMITS.QR_SCAN_FPS));
/** Roughly two seconds of nothing but errors, at the configured scan rate. */
const DETECT_FAILURE_LIMIT = Math.max(8, TMS_LIMITS.QR_SCAN_FPS * 2);

const CAMERA_MESSAGES = {
  insecure: 'Camera chỉ hoạt động khi mở ứng dụng bằng HTTPS hoặc localhost.',
  policy: 'Trình duyệt hoặc khung nhúng đang chặn camera cho trang này.',
  unsupported: 'Trình duyệt này không hỗ trợ truy cập camera.',
  denied: 'Quyền camera đang bị chặn. Hãy cho phép Camera trong cài đặt trang rồi thử lại.',
  missing: 'Không tìm thấy camera trên thiết bị.',
  busy: 'Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.',
  generic: 'Không mở được camera.',
  unsupportedMode: 'Camera không nhận cấu hình yêu cầu. Hãy thử lại hoặc dùng thiết bị khác.',
  decoder: 'Không tải được bộ giải mã QR. Hãy kiểm tra kết nối mạng rồi thử lại.',
  undecodable: 'Camera đang chạy nhưng không đọc được mã. Hãy thử lại hoặc nhập mã thủ công.',
  noFrames: 'Camera đã được cấp quyền nhưng không gửi được hình. Hãy đóng các ứng dụng đang dùng camera rồi thử lại.',
} as const;

/** Long enough for a cold camera on an older phone, short enough to not hang. */
const FIRST_FRAME_TIMEOUT_MS = 10_000;

/**
 * Resolves once the video is actually showing something, or throws.
 *
 * `readyState` is the only honest signal that a camera is live: a stream can be
 * handed over, and play() can even resolve, while no frame ever arrives.
 */
const waitForFrames = (video: HTMLVideoElement) => new Promise<void>((resolve, reject) => {
  if (video.readyState >= video.HAVE_CURRENT_DATA) {
    resolve();
    return;
  }
  const settle = (outcome: () => void) => {
    window.clearTimeout(timer);
    video.removeEventListener('loadeddata', onData);
    outcome();
  };
  const onData = () => settle(resolve);
  const timer = window.setTimeout(
    () => settle(() => reject(new Error(CAMERA_MESSAGES.noFrames))),
    FIRST_FRAME_TIMEOUT_MS,
  );
  video.addEventListener('loadeddata', onData, { once: true });
});

const shouldSkipDeviceFallback = (error: unknown) => {
  const detail = error instanceof Error
    ? `${error.name} ${error.message}`
    : String(error);

  return /notallowed|permission|denied|dismissed|security|secure|https|notreadable|trackstarterror|in use/i.test(detail);
};

const getCameraErrorMessage = (error: unknown) => {
  const detail = error instanceof Error
    ? `${error.name} ${error.message}`
    : String(error);
  const normalized = detail.toLowerCase();

  // Already one of ours — including the generic one with its error name
  // appended — so it is passed through rather than re-classified.
  if (Object.values(CAMERA_MESSAGES).some((message) => detail.startsWith(message))) return detail;
  if (/notallowed|permission|denied|dismissed/.test(normalized)) return CAMERA_MESSAGES.denied;
  if (/notfound|devicesnotfound|no camera|no cameras/.test(normalized)) return CAMERA_MESSAGES.missing;
  if (/notreadable|trackstarterror|could not start|in use/.test(normalized)) return CAMERA_MESSAGES.busy;
  if (/overconstrained|constraint/.test(normalized)) return CAMERA_MESSAGES.unsupportedMode;
  if (/secure|https/.test(normalized)) return CAMERA_MESSAGES.insecure;

  // Nothing recognised it, so say what the browser said.
  //
  // The catch-all used to read "check camera permission", which is a confident
  // wrong answer: it was shown on an iPhone that had just granted permission,
  // and it sent everyone looking at Settings while the real fault was
  // elsewhere. An unrecognised error is worth naming — the person reporting it
  // is the only instrument anyone has on their phone.
  const name = error instanceof Error && error.name ? error.name : 'Unknown';
  return `${CAMERA_MESSAGES.generic} (${name})`;
};

const assertCameraAvailable = () => {
  if (!window.isSecureContext) throw new Error(CAMERA_MESSAGES.insecure);
  if (!navigator.mediaDevices?.getUserMedia) throw new Error(CAMERA_MESSAGES.unsupported);

  const permissionsPolicy = (document as Document & {
    permissionsPolicy?: { allowsFeature: (feature: string) => boolean };
  }).permissionsPolicy;
  if (permissionsPolicy && !permissionsPolicy.allowsFeature('camera')) {
    throw new Error(CAMERA_MESSAGES.policy);
  }
};

// Prefer the browser's native, hardware-accelerated BarcodeDetector (ships in the JS
// engine, zero bundle cost). Only browsers lacking it (older Safari, Firefox) pay the
// cost of a dynamically-imported, actively-maintained WASM polyfill.
//
// That split is also why this only ever failed on iPhones. Android Chrome has the
// native detector and never reaches the polyfill; iOS Safari does not, so every
// iOS scan goes through a WebAssembly build of ZXing — and zxing-wasm loads that
// module from jsDelivr by default. A phone on branch wifi that cannot reach a
// public CDN got a camera that ran and a scanner that never decoded anything.
//
// The module is now served from this origin, as an asset the build emits, so a
// scan depends on nothing outside the app. fireImmediately makes a failure to
// load surface here, as a startup error the person can read, instead of turning
// into a detect() that rejects on every frame behind a console warning.
export async function resolveBarcodeDetectorCtor(): Promise<BarcodeDetectorCtor> {
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    return (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
  }
  // prepareZXingModule comes from barcode-detector itself, not from zxing-wasm.
  // It bundles its own copy of that library, so configuring the one installed
  // beside it sets an override on a second, unused instance and the decoder goes
  // on fetching from the CDN — which is what the first attempt at this fix did,
  // and what the regression test caught.
  const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/pure');
  try {
    await prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) => (
          path.endsWith('.wasm') ? zxingWasmUrl : `${prefix}${path}`
        ),
      },
      fireImmediately: true,
    });
  } catch (moduleError) {
    console.warn('QR decoder load failed:', moduleError);
    throw new Error(CAMERA_MESSAGES.decoder);
  }
  return BarcodeDetector as unknown as BarcodeDetectorCtor;
}

const ModalQRScanner = ({ onClose, onScan, onError }: Props) => {
  const [status, setStatus] = useState<ScannerStatus>('starting');
  const [cameraError, setCameraError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const scanHandledRef = useRef(false);
  const handlersRef = useRef({ onScan, onError });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const dialogRef = useModalAccessibility(true, onClose);
  const swipeBackHandlers = useModalSwipeBack(onClose, scanHandledRef.current);
  handlersRef.current = { onScan, onError };

  useEffect(() => {
    let disposed = false;
    let stream: MediaStream | null = null;
    let detectTimer = 0;

    scanHandledRef.current = false;
    setStatus('starting');
    setCameraError('');
    setTorchOn(false);
    setTorchSupported(false);

    const stopStream = () => {
      const activeStream = stream;
      stream = null;
      trackRef.current = null;
      activeStream?.getTracks().forEach((track) => track.stop());
    };

    const startScanner = async () => {
      try {
        assertCameraAvailable();

        // The camera is opened before the decoder is fetched, and the order is
        // load-bearing on iOS. Safari only honours getUserMedia inside a short
        // window after the tap that led here; putting a megabyte of WebAssembly
        // in front of it spent that window, and Safari then refused the camera
        // without even showing its permission sheet — a working camera turned
        // into no camera and no prompt. The decoder has no such constraint, so
        // it loads once the preview is already running, which also puts a
        // picture on screen sooner than waiting for both.
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
        } catch (directError) {
          if (disposed) return;
          if (shouldSkipDeviceFallback(directError)) throw directError;

          const devices = await navigator.mediaDevices.enumerateDevices();
          if (disposed) return;
          const cameras = devices.filter((device) => device.kind === 'videoinput');
          if (cameras.length === 0) throw directError;
          const camera = cameras.find((device) => REAR_CAMERA_PATTERN.test(device.label)) ?? cameras[0];
          if (!camera) throw directError;
          stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: camera.deviceId } } });
        }
        if (disposed || !stream) {
          stopStream();
          return;
        }

        const video = videoRef.current;
        if (!video) {
          stopStream();
          return;
        }
        video.srcObject = stream;

        // A rejected play() is not a dead camera.
        //
        // The element already carries autoplay, muted and playsinline, so iOS
        // starts it on its own; the explicit call is belt and braces. But
        // Safari rejects that call whenever something interrupts it — the modal
        // is still animating in, React re-renders the element, the tab is
        // mid-transition — with "The operation was interrupted", which matches
        // none of the patterns below and so surfaced as the catch-all "check
        // camera permission" on a phone whose permission had just been granted.
        //
        // What decides whether there is a camera is whether frames arrive, so
        // that is what is waited for.
        await video.play().catch((playError) => {
          console.warn('Video play warning:', playError);
        });
        if (disposed) {
          stopStream();
          return;
        }
        await waitForFrames(video);
        if (disposed) {
          stopStream();
          return;
        }

        const [track] = stream.getVideoTracks();
        trackRef.current = track ?? null;
        const capabilities = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
        setTorchSupported(Boolean(capabilities?.torch));

        // Only now, with the preview live and the gesture window no longer at
        // stake. A failure here is a decoder failure, not a camera one.
        let detector: BarcodeDetectorLike;
        try {
          const DetectorCtor = await resolveBarcodeDetectorCtor();
          if (disposed) {
            stopStream();
            return;
          }
          detector = new DetectorCtor({ formats: ['qr_code'] });
        } catch (decoderError) {
          stopStream();
          if (disposed) return;
          console.warn('QR decoder start warning:', decoderError);
          setCameraError(CAMERA_MESSAGES.decoder);
          setStatus('error');
          handlersRef.current.onError(CAMERA_MESSAGES.decoder);
          return;
        }

        setStatus('scanning');

        // A decoder that throws on every frame is indistinguishable, on screen,
        // from one that simply has not seen a code yet: the camera runs and
        // nothing happens. That is exactly how the iOS failure presented, and it
        // survived because the only response to a rejected detect() was a
        // console warning nobody on a phone can see. Frames are allowed to fail
        // — a half-lit code fails too — but a run of nothing but failures is a
        // broken decoder, and it now says so.
        let consecutiveFailures = 0;

        const tick = async () => {
          if (disposed || scanHandledRef.current) return;
          if (video.readyState >= video.HAVE_CURRENT_DATA) {
            try {
              const results = await detector.detect(video);
              consecutiveFailures = 0;
              const value = results[0]?.rawValue;
              if (value && !scanHandledRef.current) {
                scanHandledRef.current = true;
                navigator.vibrate?.(100);
                stopStream();
                if (!disposed) handlersRef.current.onScan(value);
                return;
              }
            } catch (detectError) {
              consecutiveFailures += 1;
              console.warn('QR detect warning:', detectError);
              if (consecutiveFailures >= DETECT_FAILURE_LIMIT) {
                stopStream();
                if (disposed) return;
                setCameraError(CAMERA_MESSAGES.undecodable);
                setStatus('error');
                handlersRef.current.onError(CAMERA_MESSAGES.undecodable);
                return;
              }
            }
          }
          if (!disposed && !scanHandledRef.current) {
            detectTimer = window.setTimeout(() => void tick(), DETECT_INTERVAL_MS);
          }
        };
        void tick();
      } catch (startError) {
        stopStream();
        if (disposed) return;
        const message = getCameraErrorMessage(startError);
        console.warn('Scanner start warning:', startError);
        setCameraError(message);
        setStatus('error');
        handlersRef.current.onError(message);
      }
    };

    // Deferring one task prevents React StrictMode from opening two camera streams in development.
    const startTimer = window.setTimeout(() => void startScanner(), 0);

    return () => {
      disposed = true;
      scanHandledRef.current = true;
      window.clearTimeout(startTimer);
      window.clearTimeout(detectTimer);
      stopStream();
    };
  }, [attempt]);

  const retry = () => setAttempt((current) => current + 1);

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    try {
      const next = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch (torchError) {
      console.warn('Torch toggle warning:', torchError);
    }
  };

  return (
    <div ref={dialogRef} tabIndex={-1} className="scanner-modal" role="dialog" aria-modal="true" aria-labelledby="qr-scanner-title" data-swipe-surface="modal" {...swipeBackHandlers}>
      <header className="scanner-toolbar">
        <div className="scanner-title">
          <span className="scanner-title-icon material-symbols-rounded" aria-hidden="true">qr_code_scanner</span>
          <strong id="qr-scanner-title">Quét mã Kiosk</strong>
        </div>
        <div className="flex items-center gap-2">
          {status === 'scanning' && torchSupported ? (
            <IconButton
              icon={torchOn ? 'flash_on' : 'flash_off'}
              label={torchOn ? 'Tắt đèn flash' : 'Bật đèn flash'}
              tone="inverse"
              onClick={() => void toggleTorch()}
            />
          ) : null}
          <IconButton icon="close" label="Đóng trình quét" tone="inverse" onClick={onClose} />
        </div>
      </header>

      <div className="scanner-stage">
        <div id={SCANNER_ELEMENT_ID}>
          <video ref={videoRef} muted playsInline autoPlay />
        </div>

        {status === 'scanning' && (
          <div className="scanner-mask" aria-hidden="true">
            <div className="scanner-window">
              <div className="scanner-corner scanner-corner-top-left" />
              <div className="scanner-corner scanner-corner-top-right" />
              <div className="scanner-corner scanner-corner-bottom-left" />
              <div className="scanner-corner scanner-corner-bottom-right" />
              <div className="scanner-line" />
              <span className="scanner-caption">Đang quét mã Kiosk...</span>
            </div>
          </div>
        )}

        {status === 'starting' && (
          <div className="scanner-feedback" role="status">
            <span className="scanner-spinner" aria-hidden="true" />
            <p>Đang xin quyền camera...</p>
          </div>
        )}

        {status === 'error' && (
          <div className="scanner-feedback scanner-feedback-error" role="alert">
            <span className="material-symbols-rounded" aria-hidden="true">no_photography</span>
            <h2>Chưa thể mở camera</h2>
            <p>{cameraError}</p>
            <div className="scanner-error-actions">
              <button type="button" className="btn btn-primary btn-md" onClick={retry}>Thử lại</button>
              <button type="button" className="btn btn-secondary btn-md" onClick={onClose}>Đóng</button>
            </div>
          </div>
        )}
      </div>

      <footer className="scanner-footer">
        <h3>Hướng dẫn</h3>
        <p>Di chuyển camera để mã QR trên màn hình Kiosk nằm gọn trong khung hình vuông.</p>
        <div className="scanner-tips">
          <span><i className="material-symbols-rounded" aria-hidden="true">lightbulb</i>Đủ sáng</span>
          <span><i className="material-symbols-rounded" aria-hidden="true">back_hand</i>Giữ chắc tay</span>
        </div>
      </footer>
    </div>
  );
};

export default ModalQRScanner;
