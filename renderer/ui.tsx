import { useEffect, useRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Plus, Loader2, X, MessageCircle } from 'lucide-react';

const openUrl = (url: string) => window.watson ? window.watson.invoke('external:open', { url }) : Promise.resolve(window.open(url, '_blank', 'noopener,noreferrer'));

export function Button({ children, className = '', icon: Icon, busy, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: typeof Plus; busy?: boolean }) {
  return <button className={`button ${className}`} {...props}>{busy ? <Loader2 size={16} className="spin" /> : Icon && <Icon size={16} />}{children}</button>;
}
export function IconButton({ icon: Icon, label, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: typeof Plus; label: string }) {
  return <button className={`icon-button ${className}`} title={label} aria-label={label} {...props}><Icon size={17} /></button>;
}
export function Empty({ icon: Icon = MessageCircle, title, text, children }: { icon?: typeof Plus; title: string; text: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-symbol"><Icon size={25} strokeWidth={1.5} /></div><h3>{title}</h3><p>{text}</p>{children}</div>;
}
export function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className={`toggle-row ${disabled ? 'muted' : ''}`}><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span className="toggle-track" aria-hidden="true" /></label>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select') || ref.current?.querySelector<HTMLElement>('button'); first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), a[href]') || []);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'wide' : ''}`}><header><h2>{title}</h2><IconButton icon={X} label="Close dialog" onClick={onClose} /></header>{children}</div></div>;
}
export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown components={{ a: ({ children, href }) => <a href={href} onClick={event => { event.preventDefault(); if (href && /^https?:\/\//i.test(href)) void openUrl(href); }}>{children}</a> }}>{text}</ReactMarkdown></div>;
}
