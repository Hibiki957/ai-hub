import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import {
  Check,
  CheckCheck,
  Circle,
  CircleAlert,
  Clock3,
  FolderOpen,
  Inbox,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  Square,
  X
} from 'lucide-react';

export const STATUS = {
  queued: { label: '待安排', icon: Clock3 },
  running: { label: '进行中', icon: Play },
  blocked: { label: '需处理', icon: CircleAlert },
  review: { label: '待验收', icon: CheckCheck },
  done: { label: '已完成', icon: Check },
  cancelled: { label: '已关停', icon: Square },
  archived: { label: '已归档', icon: FolderOpen }
};
export const COLUMNS = ['queued', 'running', 'blocked', 'review', 'done'];
export const GATE = {
  spend: '费用确认',
  publish: '发布确认',
  send: '发送确认',
  delete: '删除确认',
  overwrite: '覆盖确认',
  direction: '方向决策',
  uncertain: '需要你判断'
};
export function IconButton({ icon: Icon, label, ...props }) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      <Icon size={17} aria-hidden="true" />
    </button>
  );
}
export function Empty({ icon: Icon = Inbox, title, children, action }) {
  return (
    <div className="empty-state">
      <Icon size={28} strokeWidth={1.4} aria-hidden="true" />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Status({ value }) {
  const item = STATUS[value] || { label: value, icon: Circle };
  const Icon = item.icon;
  return (
    <span className={`status status-${value}`}>
      <Icon size={13} aria-hidden="true" />
      {item.label}
    </span>
  );
}
export function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Dialog({ title, subtitle, children, onClose, drawer = false, blocking = false, className = '' }) {
  const ref = useRef(null);
  const heading = useId();
  const [minimized, setMinimized] = useState(false);
  const [opened, setOpened] = useState(false);
  const initial = useMemo(() => {
    const width = Math.min(drawer ? (className.includes('task') ? 700 : 640) : 570, window.innerWidth - 24);
    const height = Math.min(window.innerHeight - 72, blocking ? 580 : drawer ? 790 : 690);
    const fallback = {
      x: Math.max(12, (window.innerWidth - width) / 2),
      y: Math.max(18, (window.innerHeight - height) / 2),
      width,
      height
    };
    try {
      const saved = JSON.parse(localStorage.getItem(`aihub.window.geometry.${className || (drawer ? 'utility' : 'dialog')}`));
      if (saved && ['width', 'height', 'x', 'y'].every(key => Number.isFinite(saved[key]))) {
        const bounded = {
          width: Math.max(Math.min(360, window.innerWidth - 24), Math.min(saved.width, window.innerWidth - 24)),
          height: Math.max(250, Math.min(saved.height, window.innerHeight - 48))
        };
        return {
          ...bounded,
          x: Math.max(12, Math.min(saved.x, window.innerWidth - bounded.width - 12)),
          y: Math.max(12, Math.min(saved.y, window.innerHeight - bounded.height - 12))
        };
      }
    } catch {}
    return fallback;
  }, []);
  const [geometry, setGeometry] = useState(initial);
  useEffect(() => {
    const clamp = () =>
      setGeometry(value => {
        const width = Math.min(value.width, window.innerWidth - 24);
        const height = Math.min(value.height, window.innerHeight - 48);
        return {
          width,
          height,
          x: Math.max(12, Math.min(value.x, window.innerWidth - width - 12)),
          y: Math.max(12, Math.min(value.y, window.innerHeight - height - 12))
        };
      });
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);
  const keepGeometry = value => {
    setGeometry(value);
    try {
      localStorage.setItem(`aihub.window.geometry.${className || (drawer ? 'utility' : 'dialog')}`, JSON.stringify(value));
    } catch {}
  };
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog.open) {
      if (blocking) dialog.showModal();
      else dialog.show();
    }
    setOpened(true);
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`window-host ${blocking ? 'blocking-host' : ''} ${className}`}
      aria-labelledby={heading}
      onKeyDownCapture={event => {
        if (event.key === 'Escape' && blocking) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClose={() => {
        if (blocking && ref.current?.isConnected && !ref.current.open) ref.current.showModal();
      }}
      onCancel={event => {
        event.preventDefault();
        if (!blocking) onClose();
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && !blocking) {
          event.preventDefault();
          onClose();
        }
      }}
      onClick={event => {
        if (event.target === ref.current && !blocking) onClose();
      }}
    >
      {opened && (
        <Rnd
          className={`floating-window ${minimized ? 'window-minimized' : ''}`}
          position={{ x: geometry.x, y: geometry.y }}
          size={{ width: minimized ? Math.min(340, geometry.width) : geometry.width, height: minimized ? 58 : geometry.height }}
          onDragStop={(_, value) => keepGeometry({ ...geometry, x: value.x, y: value.y })}
          onResizeStop={(_, __, element, ___, position) =>
            keepGeometry({ ...position, width: element.offsetWidth, height: element.offsetHeight })
          }
          minWidth={Math.min(minimized ? 300 : 360, window.innerWidth - 24)}
          minHeight={minimized ? 56 : 250}
          bounds="window"
          dragHandleClassName="dialog-header"
          cancel="button,input,textarea,select"
          enableResizing={!minimized && window.innerWidth > 600}
          disableDragging={window.innerWidth <= 600}
        >
          <div className="dialog-surface">
            <header className="dialog-header">
              <div>
                <h2 id={heading}>{title}</h2>
                {subtitle && !minimized && <p>{subtitle}</p>}
              </div>
              <div className="window-controls">
                {!blocking && (
                  <IconButton
                    icon={minimized ? Plus : Minus}
                    label={minimized ? '展开窗口' : '收起窗口'}
                    onClick={() => setMinimized(!minimized)}
                  />
                )}
                {!blocking && <IconButton icon={X} label="关闭" onClick={onClose} />}
              </div>
            </header>
            <div className="window-content" hidden={minimized}>
              {children}
            </div>
          </div>
        </Rnd>
      )}
    </dialog>
  );
}
export function Submit({ busy, children = '保存', ...props }) {
  return (
    <button className="primary" type="submit" disabled={busy} {...props}>
      {busy ? <LoaderCircle className="spin" size={15} /> : null}
      {children}
    </button>
  );
}
export function FormError({ value }) {
  return value ? (
    <p className="form-error" role="alert">
      <CircleAlert size={15} />
      {value}
    </p>
  ) : null;
}
