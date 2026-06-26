import { useCallback, useRef, useState } from 'react';

/** A single picked image, as a base64 data URL plus its file metadata. */
export interface DroppedImage {
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface UseImageDropResult {
  image: DroppedImage | null;
  isDragging: boolean;
  error: string | null;
  setImage: (image: DroppedImage | null) => void;
  clear: () => void;
  openFilePicker: () => void;
  /** Spread onto the hidden <input type="file"> element. */
  inputProps: {
    ref: React.RefObject<HTMLInputElement | null>;
    type: 'file';
    accept: string;
    style: React.CSSProperties;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  };
  /** Spread onto the drop target element. */
  dropProps: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onPaste: (e: React.ClipboardEvent) => void;
  };
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Single-image drag/drop/paste/file-picker hook. Mirrors the attachment logic in
 * AgentPanel so the Asset Generator can accept an image for image-to-3D without
 * duplicating the handlers inline.
 */
export function useImageDrop(maxBytes: number = DEFAULT_MAX_BYTES): UseImageDropResult {
  const [image, setImage] = useState<DroppedImage | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return;
      const file = Array.from(files).find((f) => f.type.startsWith('image/'));
      if (!file) {
        setError('Only image files can be used for image-to-3D.');
        return;
      }
      if (file.size > maxBytes) {
        setError(`'${file.name}' exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`);
        return;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        setError(null);
        setImage({ name: file.name || 'image', mimeType: file.type, sizeBytes: file.size, dataUrl });
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    },
    [maxBytes],
  );

  const openFilePicker = useCallback(() => inputRef.current?.click(), []);
  const clear = useCallback(() => {
    setImage(null);
    setError(null);
  }, []);

  return {
    image,
    isDragging,
    error,
    setImage,
    clear,
    openFilePicker,
    inputProps: {
      ref: inputRef,
      type: 'file',
      accept: 'image/*',
      style: { display: 'none' },
      onChange: (e) => {
        void addFiles(e.target.files);
        if (e.target) e.target.value = '';
      },
    },
    dropProps: {
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setIsDragging(true);
      },
      onDragLeave: (e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        setIsDragging(false);
      },
      onDrop: (e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setIsDragging(false);
        void addFiles(e.dataTransfer.files);
      },
      onPaste: (e) => {
        if (e.clipboardData.files.length > 0) void addFiles(e.clipboardData.files);
      },
    },
  };
}
