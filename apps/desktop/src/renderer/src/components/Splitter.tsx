import { useEffect, useRef, useState } from 'react';

interface SplitterProps {
  /** Called with the horizontal pointer delta (px) while dragging. */
  onDrag: (deltaX: number) => void;
  /** Optional double-click handler (e.g. collapse/restore). */
  onDoubleClick?: () => void;
}

/** A thin draggable vertical divider for resizing adjacent panels. */
export function Splitter({ onDrag, onDoubleClick }: SplitterProps): React.JSX.Element {
  const dragging = useRef(false);
  const lastX = useRef(0);
  const onDragRef = useRef(onDrag);
  const [active, setActive] = useState(false);

  onDragRef.current = onDrag;

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (!dragging.current) return;
      onDragRef.current(e.clientX - lastX.current);
      lastX.current = e.clientX;
    };
    const up = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      setActive(false);
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  return (
    <div
      className={`splitter${active ? ' splitter--active' : ''}`}
      onDoubleClick={onDoubleClick}
      onPointerDown={(e) => {
        dragging.current = true;
        lastX.current = e.clientX;
        setActive(true);
        document.body.style.cursor = 'col-resize';
      }}
    />
  );
}
