import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import IconButton from '@/shared/components/common/IconButton';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { TMS_LIMITS } from '@/shared/constants';

interface Props {
  onClose: () => void;
  onScan: (data: string) => void;
  onError: (msg: string) => void;
}

type ScannerStatus = 'starting' | 'scanning' | 'error';
type CameraDevice = Awaited<ReturnType<typeof Html5Qrcode.getCameras>>[number];

const SCANNER_ELEMENT_ID = 'qr-reader';
const REAR_CAMERA_PATTERN = /back|rear|environment|world|camera sau/i;

const CAMERA_MESSAGES = {
  insecure: 'Camera chỉ hoạt động khi mở ứng dụng bằng HTTPS hoặc localhost.',
  policy: 'Trình duyệt hoặc khung nhúng đang chặn camera cho trang này.',
  unsupported: 'Trình duyệt này không hỗ trợ truy cập camera.',
  denied: 'Quyền camera đang bị chặn. Hãy cho phép Camera trong cài đặt trang rồi thử lại.',
  missing: 'Không tìm thấy camera trên thiết bị.',
  busy: 'Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.',
  generic: 'Không thể mở camera. Vui lòng kiểm tra quyền truy cập rồi thử lại.',
} as const;

const selectCamera = (cameras: CameraDevice[]) => (
  cameras.find((camera) => REAR_CAMERA_PATTERN.test(camera.label)) ?? cameras[0]
);

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

const ModalQRScanner = ({ onClose, onScan, onError }: Props) => {
  const [status, setStatus] = useState<ScannerStatus>('starting');
  const [cameraError, setCameraError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const scanHandledRef = useRef(false);
  const handlersRef = useRef({ onScan, onError });
  const dialogRef = useModalAccessibility(true, onClose);
  handlersRef.current = { onScan, onError };

  useEffect(() => {
    let disposed = false;
    let scanner: Html5Qrcode | null = null;

    scanHandledRef.current = false;
    setStatus('starting');
    setCameraError('');

    const disposeScanner = async (activeScanner: Html5Qrcode) => {
      try {
        if (activeScanner.isScanning) await activeScanner.stop();
      } catch (stopError) {
        console.warn('Camera cleanup warning:', stopError);
      } finally {
        try {
          activeScanner.clear();
        } catch (clearError) {
          console.warn('Scanner cleanup warning:', clearError);
        }
      }
    };

    const releaseCamera = async () => {
      const activeScanner = scanner;
      scanner = null;
      if (activeScanner) await disposeScanner(activeScanner);
    };

    const startScanner = async () => {
      try {
        assertCameraAvailable();

        const scanConfig = {
          fps: TMS_LIMITS.QR_SCAN_FPS,
          qrbox: (viewWidth: number, viewHeight: number) => {
            const size = Math.floor(Math.min(viewWidth, viewHeight) * TMS_LIMITS.QR_SCAN_AREA_RATIO);
            return { width: size, height: size };
          },
          aspectRatio: 1,
        };
        const handleScan = (decodedText: string) => {
          if (disposed || scanHandledRef.current) return;
          scanHandledRef.current = true;
          navigator.vibrate?.(100);
          void releaseCamera().then(() => {
            if (!disposed) handlersRef.current.onScan(decodedText);
          });
        };
        const startWith = async (camera: string | MediaTrackConstraints) => {
          const activeScanner = new Html5Qrcode(SCANNER_ELEMENT_ID, {
            verbose: false,
            formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
            useBarCodeDetectorIfSupported: true,
          });
          scanner = activeScanner;
          await activeScanner.start(camera, scanConfig, handleScan, () => undefined);

          if (disposed || scanner !== activeScanner) {
            await disposeScanner(activeScanner);
            return false;
          }
          return true;
        };

        try {
          const started = await startWith({ facingMode: 'environment' });
          if (!started) return;
        } catch (directStartError) {
          await releaseCamera();
          if (disposed) return;
          if (shouldSkipDeviceFallback(directStartError)) throw directStartError;

          const cameras = await Html5Qrcode.getCameras();
          if (disposed) return;
          if (cameras.length === 0) throw directStartError;

          const camera = selectCamera(cameras);
          if (!camera) throw directStartError;
          const started = await startWith(camera.id);
          if (!started) return;
        }

        setStatus('scanning');
      } catch (startError) {
        await releaseCamera();
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
      void releaseCamera();
    };
  }, [attempt]);

  const retry = () => setAttempt((current) => current + 1);

  return (
    <div ref={dialogRef} tabIndex={-1} className="scanner-modal" role="dialog" aria-modal="true" aria-labelledby="qr-scanner-title">
      <header className="scanner-toolbar">
        <div className="scanner-title">
          <span className="scanner-title-icon material-symbols-rounded" aria-hidden="true">qr_code_scanner</span>
          <strong id="qr-scanner-title">Quét mã Kiosk</strong>
        </div>
        <IconButton icon="close" label="Đóng trình quét" tone="inverse" onClick={onClose} />
      </header>

      <div className="scanner-stage">
        <div id={SCANNER_ELEMENT_ID} />

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
