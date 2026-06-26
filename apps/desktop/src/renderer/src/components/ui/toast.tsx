import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastOptions {
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms (0 keeps it until dismissed). Default 4000. */
  duration?: number;
}

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

type Listener = (toast: ToastItem) => void;

let nextId = 1;
const listeners = new Set<Listener>();

/**
 * Emit a transient toast notification. A lightweight event-based notifier so any
 * module (React or not) can raise user-facing confirmations without native
 * alert/confirm/prompt. Render <Toaster /> once near the app root.
 */
export function toast(message: string, options: ToastOptions = {}): void {
  const item: ToastItem = {
    id: nextId++,
    message,
    variant: options.variant ?? 'info',
    duration: options.duration ?? 4000,
  };
  for (const listener of listeners) listener(item);
}

export const useToast = (): typeof toast => toast;

const ICONS: Record<ToastVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertTriangle,
};

/** Mounts the toast viewport. Render once (e.g. in App). */
export function Toaster(): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener: Listener = (item) => {
      setItems((prev) => [...prev, item]);
      if (item.duration > 0) {
        window.setTimeout(() => {
          setItems((prev) => prev.filter((t) => t.id !== item.id));
        }, item.duration);
      }
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const dismiss = (id: number): void => setItems((prev) => prev.filter((t) => t.id !== id));

  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((item) => {
        const Icon = ICONS[item.variant];
        return (
          <div key={item.id} className={`toast toast--${item.variant}`}>
            <Icon size={14} className="toast__icon" />
            <span className="toast__message">{item.message}</span>
            <button className="toast__close" onClick={() => dismiss(item.id)} aria-label="Dismiss">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
