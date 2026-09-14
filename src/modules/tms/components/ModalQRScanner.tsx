import { useEffect, useRef, useState } from 'react';
import IconButton from '@/shared/components/common/IconButton';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { TMS_LIMITS } from '@/shared/constants';
import { useModalTabSwipe } from '@/modules/tms/hooks/useModalTabSwipe';
import type { TabType } from './BottomNav';

interface Props {
  onClose: () => void;
  onScan: (data: string) => void;
  onError: (msg: string) => void;
  onNavigate: (tab: TabType) => void;
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

const CAMERA_MESSAGES = {
  insecure: 'Camera chỉ hoạt động khi mở ứng dụng bằng HTTPS hoặc localhost.',
  policy: 'Trình duyệt hoặc khung nhúng đang chặn camera cho trang này.',
  unsupported: 'Trình duyệt này không hỗ trợ truy cập camera.',
  denied: 'Quyền camera đang bị chặn. Hãy cho phép Camera trong cài đặt trang rồi thử lại.',
  missing: 'Không tìm thấy camera trên thiết bị.',
  busy: 'Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.',
  generic: 'Không thể mở camera. Vui lòng kiểm tra quyền truy cập rồi thử lại.',
} as const;

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

  if (Object.values(CAMERA_MESSAGES).includes(detail as typeof CAMERA_MESSAGES[keyof typeof CAMERA_MESSAGES])) return detail;
  if (/notallowed|permission|denied|dismissed/.test(normalized)) return CAMERA_MESSAGES.denied;
  if (/notfound|devicesnotfound|no camera|no cameras/.test(normalized)) return CAMERA_MESSAGES.missing;
  if (/notreadable|trackstarterror|could not start|in use/.test(normalized)) return CAMERA_MESSAGES.busy;
  if (/secure|https/.test(normalized)) return CAMERA_MESSAGES.insecure;
  return CAMERA_MESSAGES.generic;
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
export async function resolveBarcodeDetectorCtor(): Promise<BarcodeDetectorCtor> {
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    return (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
  }
  const { BarcodeDetector } = await import('barcode-detector/pure');
  return BarcodeDetector as unknown as BarcodeDetectorCtor;
}

const ModalQRScanner = ({ onClose, onScan, onError, onNavigate }: Props) => {
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
  const { swipeHandlers: swipeBackHandlers } = useModalTabSwipe({
    activeTab: 'home',
    onClose,
    onNavigate,
    surfaceRef: dialogRef,
    disabled: scanHandledRef.current,
  });
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
        const DetectorCtor = await resolveBarcodeDetectorCtor();
        if (disposed) return;
        const detector = new DetectorCtor({ formats: ['qr_code'] });

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
        await video.play();
        if (disposed) {
          stopStream();
          return;
        }

        const [track] = stream.getVideoTracks();
        trackRef.current = track ?? null;
        const capabilities = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
        setTorchSupported(Boolean(capabilities?.torch));

        setStatus('scanning');

        const tick = async () => {
          if (disposed || scanHandledRef.current) return;
          if (video.readyState >= video.HAVE_CURRENT_DATA) {
            try {
              const results = await detector.detect(video);
              const value = results[0]?.rawValue;
              if (value && !scanHandledRef.current) {
                scanHandledRef.current = true;
                navigator.vibrate?.(100);
                stopStream();
                if (!disposed) handlersRef.current.onScan(value);
                return;
              }
            } catch (detectError) {
              console.warn('QR detect warning:', detectError);
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
