import { useRef, useState, type CSSProperties, type PointerEvent, type SyntheticEvent } from 'react';
import { TMS_LIMITS } from '@/shared/constants';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { useModalSwipeBack } from '@/shared/hooks/useModalSwipeBack';

interface Props {
  imageSrc: string;
  onCancel: () => void;
  onCropComplete: (image: Blob) => Promise<void>;
}

const getViewportSize = () => Number.parseFloat(
  getComputedStyle(document.documentElement).getPropertyValue('--image-crop-viewport'),
);

export default function ImageCropper({ imageSrc, onCancel, onCropComplete }: Props) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);
  const dialogRef = useModalAccessibility(true, onCancel, { closeOnEscape: !isUploading });
  const swipeBackHandlers = useModalSwipeBack(onCancel, isUploading || isDragging);

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    const ratio = naturalWidth / naturalHeight;
    const viewportSize = getViewportSize();
    if (!Number.isFinite(viewportSize) || viewportSize <= 0) return;
    setDisplaySize(ratio < 1
      ? { width: viewportSize, height: viewportSize / ratio }
      : { width: viewportSize * ratio, height: viewportSize });
    setImageLoaded(true);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (isUploading) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    setDragStart({ x: event.clientX - pan.x, y: event.clientY - pan.y });
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDragging || isUploading) return;
    setPan({ x: event.clientX - dragStart.x, y: event.clientY - dragStart.y });
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDragging(false);
  };

  const createCroppedImage = async () => {
    if (!imageRef.current || !displaySize) return null;

    const canvas = document.createElement('canvas');
    canvas.width = TMS_LIMITS.AVATAR_OUTPUT_PIXELS;
    canvas.height = TMS_LIMITS.AVATAR_OUTPUT_PIXELS;
    const context = canvas.getContext('2d');
    if (!context) return null;

    const cropBackground = getComputedStyle(document.documentElement)
      .getPropertyValue('--image-crop-background')
      .trim() || 'white';
    const viewportSize = getViewportSize();
    if (!Number.isFinite(viewportSize) || viewportSize <= 0) return null;
    const scaleRatio = TMS_LIMITS.AVATAR_OUTPUT_PIXELS / viewportSize;

    context.fillStyle = cropBackground;
    context.fillRect(0, 0, TMS_LIMITS.AVATAR_OUTPUT_PIXELS, TMS_LIMITS.AVATAR_OUTPUT_PIXELS);
    context.translate(TMS_LIMITS.AVATAR_OUTPUT_PIXELS / 2, TMS_LIMITS.AVATAR_OUTPUT_PIXELS / 2);
    context.translate(pan.x * scaleRatio, pan.y * scaleRatio);
    context.scale(zoom * scaleRatio, zoom * scaleRatio);
    context.drawImage(
      imageRef.current,
      -displaySize.width / 2,
      -displaySize.height / 2,
      displaySize.width,
      displaySize.height,
    );

    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', TMS_LIMITS.AVATAR_JPEG_QUALITY);
    });
  };

  const handleConfirmCrop = async () => {
    setIsUploading(true);
    try {
      const image = await createCroppedImage();
      if (!image) return;
      await onCropComplete(image);
    } finally {
      setIsUploading(false);
    }
  };

  const imageStyle = displaySize ? {
    '--crop-image-width': `${displaySize.width}px`,
    '--crop-image-height': `${displaySize.height}px`,
    '--crop-pan-x': `${pan.x}px`,
    '--crop-pan-y': `${pan.y}px`,
    '--crop-zoom': zoom,
    '--crop-image-opacity': imageLoaded ? 1 : 0,
  } as CSSProperties : undefined;

  return (
    <div ref={dialogRef} tabIndex={-1} className="crop-screen app-modal-swipe-surface animate-fade-in" role="dialog" aria-modal="true" aria-labelledby="image-crop-title" aria-busy={isUploading} data-swipe-surface="modal" {...swipeBackHandlers}>
      <div className="crop-stage">
        <h2 id="image-crop-title" className="crop-title">Cắt ảnh đại diện</h2>
        <div className="image-crop-viewport relative z-20" data-swipe-ignore="true">
          <div
            className="absolute inset-0 z-30 cursor-move"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          />
          <div className="crop-frame">
            <img
              ref={imageRef}
              src={imageSrc}
              alt="Ảnh đang cắt"
              draggable={false}
              onLoad={handleImageLoad}
              className={`image-crop-preview max-w-none select-none ${isDragging ? 'image-crop-dragging' : ''}`}
              style={imageStyle}
            />
          </div>
        </div>

        {isUploading ? (
          <div className="crop-uploading">
            <span className="material-symbols-rounded ui-spin crop-uploading-icon" aria-hidden="true">progress_activity</span>
            <p className="crop-uploading-text">Đang tải ảnh lên…</p>
          </div>
        ) : null}
      </div>

      <div className="crop-panel">
        <label className="crop-zoom">
          <span className="material-symbols-rounded crop-zoom-small" aria-hidden="true">image</span>
          <span className="sr-only">Thu phóng ảnh</span>
          <input
            type="range"
            min="1"
            max="3"
            step="0.05"
            value={zoom}
            disabled={isUploading}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="crop-zoom-range"
          />
          <span className="material-symbols-rounded crop-zoom-large" aria-hidden="true">image</span>
        </label>
        <div className="crop-actions">
          <button type="button" onClick={onCancel} disabled={isUploading} className="ui-button ui-button-quiet">
            Hủy
          </button>
          <button type="button" onClick={() => void handleConfirmCrop()} disabled={!imageLoaded || isUploading} className="ui-cta">
            {isUploading ? <span className="material-symbols-rounded ui-spin" aria-hidden="true">progress_activity</span> : 'Lưu ảnh'}
          </button>
        </div>
      </div>
    </div>
  );
}
