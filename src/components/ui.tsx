import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Copy, X } from "lucide-react";
import { PLATFORMS } from "../lib/platforms";
import type { Platform } from "../lib/types";

export function ChannelTag({ platform }: { platform: Platform }) {
  const info = PLATFORMS[platform];
  return (
    <span className="tag" style={{ color: info.color, borderColor: info.color }} title={info.label} aria-label={info.label}>
      {info.code}
    </span>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="note note-error" role="alert">
      <AlertTriangle size={16} aria-hidden /> <span>{children}</span>
    </p>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" onCancel={onClose} onClose={onClose} aria-label={title}>
      <header className="modal-head">
        <h2>{title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть">
          <X size={20} aria-hidden />
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Qabul">
      <rect width="64" height="64" rx="14" fill="#17203A" />
      <circle cx="31" cy="30" r="15" fill="none" stroke="#FFFFFF" strokeWidth="7" />
      <path d="M36 37 L49 51" stroke="#FFE45C" strokeWidth="9" />
    </svg>
  );
}

export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="copy-field">
      <span className="copy-label">{label}</span>
      <div className="copy-row">
        <input readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} />
        <button type="button" className="button" onClick={copy} aria-label={`Скопировать: ${label}`}>
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
          {copied ? "Скопировано" : "Копировать"}
        </button>
      </div>
    </div>
  );
}
