import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

export interface AdminSelectOption {
  value: string;
  label: string;
  description?: string;
}

export function AdminSelect({
  value,
  options,
  onChange,
  label,
  placeholder = 'Chọn một mục',
  disabled = false,
  required = false,
}: {
  value: string;
  options: readonly AdminSelectOption[];
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, selectedIndex));
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  useEffect(() => {
    if (!open) return undefined;

    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', closeFromOutside);
    document.addEventListener('keydown', closeFromEscape);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside);
      document.removeEventListener('keydown', closeFromEscape);
    };
  }, [open]);

  const openMenu = () => {
    setActiveIndex(Math.max(0, selectedIndex));
    setOpen(true);
  };

  const selectOption = (option: AdminSelectOption) => {
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!options.length) return;
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!open) openMenu();
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setActiveIndex((current) => {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        return (current + direction + options.length) % options.length;
      });
    }
    if (open && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      const option = options[activeIndex] || options[0];
      if (option) selectOption(option);
    }
  };

  return (
    <div className={`admin-select ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="admin-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-activedescendant={open ? `${menuId}-${activeIndex}` : undefined}
        aria-required={required}
        disabled={disabled}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={selected ? '' : 'placeholder'}>{selected?.label || placeholder}</span>
        <span className="material-symbols-rounded" aria-hidden="true">expand_more</span>
      </button>
      {open ? (
        <div className="admin-select-menu" id={menuId} role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <button
              type="button"
              id={`${menuId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              className={`${option.value === value ? 'selected' : ''} ${index === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectOption(option)}
              key={option.value}
            >
              <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
              {option.value === value ? <span className="material-symbols-rounded" aria-hidden="true">check</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState({ icon, title, description }: { icon: string; title: string; description?: string }) {
  return (
    <div className="admin-empty" role="status">
      <span className="material-symbols-rounded" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  label = 'Tìm kiếm',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
}) {
  return (
    <label className="admin-search">
      <span className="material-symbols-rounded" aria-hidden="true">search</span>
      <span className="sr-only">{label}</span>
      <input type="search" autoComplete="off" spellCheck={false} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

export function SpreadsheetActions({
  disabled = false,
  onExport,
  onImport,
}: {
  disabled?: boolean;
  onExport: () => void | Promise<void>;
  onImport: (file: File) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void onImport(file);
  };

  return (
    <div className="admin-excel-actions">
      <button type="button" className="admin-secondary-button" disabled={disabled} onClick={() => void onExport()}>
        <span className="material-symbols-rounded" aria-hidden="true">download</span>Xuất Excel
      </button>
      <button type="button" className="admin-secondary-button" disabled={disabled} onClick={() => inputRef.current?.click()}>
        <span className="material-symbols-rounded" aria-hidden="true">upload_file</span>Nhập Excel
      </button>
      <input ref={inputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={selectFile} />
    </div>
  );
}

export function Pagination({
  page,
  pageCount,
  onChange,
  summary,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  summary: ReactNode;
}) {
  return (
    <footer className="admin-pagination" aria-label="Phân trang">
      <span>{summary}</span>
      <div>
        <button type="button" onClick={() => onChange(page - 1)} disabled={page <= 1} aria-label="Trang trước">
          <span className="material-symbols-rounded" aria-hidden="true">chevron_left</span>
        </button>
        <strong aria-live="polite">{page} / {Math.max(pageCount, 1)}</strong>
        <button type="button" onClick={() => onChange(page + 1)} disabled={page >= pageCount} aria-label="Trang sau">
          <span className="material-symbols-rounded" aria-hidden="true">chevron_right</span>
        </button>
      </div>
    </footer>
  );
}

export function PanelTitle({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <header className="admin-panel-title">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {action}
    </header>
  );
}
