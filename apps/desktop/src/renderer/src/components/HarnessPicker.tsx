import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, CircleDashed, Network, Search } from 'lucide-react';
import { HARNESSES, type HarnessAvailability, type HarnessId } from '@triangle/shared';
import { ClaudeIcon, DevinIcon, OpenAIIcon } from './icons/providers.js';

interface HarnessPickerProps {
  value: HarnessId;
  availability: HarnessAvailability[];
  onChange: (id: HarnessId) => void;
  disabled?: boolean;
}

interface HarnessMeta {
  icon: ComponentType<{ size?: number | string }>;
  /** Subtitle shown under the harness name, à la the Trifecta model row. */
  subtitle: string;
}

const META: Record<HarnessId, HarnessMeta> = {
  mock: { icon: CircleDashed, subtitle: 'Local · canned responses' },
  claude: { icon: ClaudeIcon, subtitle: 'Anthropic · Claude Agent SDK' },
  codex: { icon: OpenAIIcon, subtitle: 'OpenAI · Codex CLI' },
  devin: { icon: DevinIcon, subtitle: 'Cognition · Devin CLI (ACP)' },
  acp: { icon: Network, subtitle: 'Protocol · ACP / MCP (Stage 4)' },
};

const TriggerFallback = Network;

/**
 * Agent harness picker — a popover styled after Trifecta's model picker: a
 * trigger that shows the active harness + a searchable list of icon/name/subtitle
 * rows with availability, hover/selected states, and a check on the active one.
 */
export function HarnessPicker({
  value,
  availability,
  onChange,
  disabled,
}: HarnessPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [coords, setCoords] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);

  const POPUP_WIDTH = 320;

  // Position the (portaled, fixed) popup, flipping above/below the trigger
  // depending on available space, and clamped to the viewport so it is never
  // clipped by the dock panel's overflow.
  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const preferred = 360;
    const left = Math.min(Math.max(margin, r.left), window.innerWidth - POPUP_WIDTH - margin);
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    // Open downward unless there's clearly more room above (the harness bar
    // usually sits near the top of the agent panel → opens down).
    if (spaceBelow >= preferred || spaceBelow >= spaceAbove) {
      setCoords({ left, top: r.bottom + gap, maxHeight: Math.min(preferred, spaceBelow) });
    } else {
      setCoords({
        left,
        bottom: window.innerHeight - r.top + gap,
        maxHeight: Math.min(preferred, spaceAbove),
      });
    }
  }, []);

  const rows = useMemo(
    () =>
      HARNESSES.map((h) => {
        const live = availability.find((a) => a.id === h.id);
        return {
          id: h.id,
          label: h.label,
          available: live ? live.available : h.available,
          note: live?.reason ?? h.note,
          ...META[h.id],
        };
      }),
    [availability],
  );

  const selected = rows.find((r) => r.id === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.label.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q),
    );
  }, [rows, query]);

  // Measure synchronously before paint so the popup never flashes mispositioned.
  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (open) {
      setQuery('');
      // Focus the search after the open animation begins.
      const t = window.setTimeout(() => searchRef.current?.focus(), 20);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // Close on Escape; keep the popup anchored on resize/scroll.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  const choose = (id: HarnessId, available: boolean): void => {
    if (!available) return;
    onChange(id);
    setOpen(false);
  };

  const TriggerIcon = selected?.icon ?? TriggerFallback;

  return (
    <div className="picker" data-open={open}>
      <button
        ref={triggerRef}
        className="picker__trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title="Select agent harness"
      >
        <span className="picker__trigger-icon">
          <TriggerIcon size={15} />
        </span>
        <span className="picker__trigger-label">{selected?.label ?? 'Select harness'}</span>
        <ChevronDown className="picker__trigger-chevron" size={14} />
      </button>

      {open &&
        coords &&
        createPortal(
          <>
            <div className="picker__backdrop" onClick={() => setOpen(false)} />
            <div
              className="picker__popup"
              role="listbox"
              style={{
                position: 'fixed',
                left: coords.left,
                top: coords.top,
                bottom: coords.bottom,
                width: POPUP_WIDTH,
                maxHeight: coords.maxHeight,
                transformOrigin: coords.top != null ? 'top left' : 'bottom left',
              }}
            >
              <div className="picker__search">
              <Search size={15} />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search harnesses…"
              />
            </div>
            <div className="picker__list">
              {filtered.map((r) => {
                const Icon = r.icon;
                const isSelected = r.id === value;
                return (
                  <button
                    key={r.id}
                    role="option"
                    aria-selected={isSelected}
                    className={`picker__row${isSelected ? ' picker__row--selected' : ''}`}
                    disabled={!r.available}
                    onClick={() => choose(r.id, r.available)}
                  >
                    <span className="picker__row-icon">
                      <Icon size={14} />
                    </span>
                    <span className="picker__row-main">
                      <span className="picker__row-name">
                        <span>{r.label}</span>
                        {!r.available && <span className="badge badge--warning">soon</span>}
                      </span>
                      <span className="picker__row-sub">{r.note ?? r.subtitle}</span>
                    </span>
                    {isSelected && <Check className="picker__row-check" size={15} />}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className="picker__empty">No harnesses match.</div>
              )}
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
