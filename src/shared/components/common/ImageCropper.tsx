import { useRef, useState, type CSSProperties, type PointerEvent, type SyntheticEvent } from 'react';
import { TMS_LIMITS } from '@/shared/constants';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';

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
    <div ref={dialogRef} tabIndex={-1} className="fixed inset-0 z-50 bg-neutral-black/95 dark:bg-dark-bg/95 backdrop-blur-md flex flex-col animate-fade-in touch-none" role="dialog" aria-modal="true" aria-labelledby="image-crop-title" aria-busy={isUploading}>
      <div className="flex-1 flex flex-col items-center justify-center relative w-full">
        <h2 id="image-crop-title" className="text-neutral-white font-black text-xl absolute top-20 pointer-events-none">Cắt ảnh đại diện</h2>
        <div className="image-crop-viewport relative z-20">
          <div
            className="absolute inset-0 z-30 cursor-move"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          />
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900">
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
          <div className="absolute inset-0 z-40 bg-neutral-black/70 flex flex-col items-center justify-center backdrop-blur-sm">
            <span className="material-symbols-rounded text-primary text-5xl animate-spin">progress_activity</span>
            <p className="text-neutral-white font-bold tracking-widest uppercase mt-4">Đang tải ảnh lên...</p>
          </div>
        ) : null}
      </div>

      <div className="bg-neutral-white dark:bg-dark-surface border-t border-slate-200 dark:border-dark-border pb-safe pt-6 px-6 z-40 w-full rounded-t-xl">
        <label className="flex items-center gap-4 justify-center mb-6 px-2">
          <span className="material-symbols-rounded text-slate-400 dark:text-dark-text-secondary text-xl">image</span>
          <span className="sr-only">Thu phóng ảnh</span>
          <input
            type="range"
            min="1"
            max="3"
            step="0.05"
            value={zoom}
            disabled={isUploading}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="w-full h-1.5 bg-slate-200 dark:bg-dark-border rounded-lg appearance-none cursor-pointer accent-primary disabled:opacity-50"
          />
          <span className="material-symbols-rounded text-neutral-black dark:text-dark-text-primary text-3xl">image</span>
        </label>
        <div className="flex gap-4 mb-4">
          <button type="button" onClick={onCancel} disabled={isUploading} className="flex-1 py-4 bg-slate-100 dark:bg-dark-border/50 hover:dark:bg-dark-border text-slate-600 dark:text-dark-text-primary rounded-xl font-extrabold text-base active:scale-95 transition-all disabled:opacity-50 uppercase tracking-widest">
            Hủy
          </button>
          <button type="button" onClick={() => void handleConfirmCrop()} disabled={!imageLoaded || isUploading} className="flex-1 py-4 bg-primary text-neutral-white rounded-xl font-extrabold text-base active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3 uppercase tracking-widest shadow-lg shadow-primary/30">
            {isUploading ? <span className="material-symbols-rounded animate-spin">progress_activity</span> : 'Lưu ảnh'}
          </button>
        </div>
      </div>
    </div>
  );
}
