import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow,
  ArrowRight,
  Globe,
  History,
  Check,
  CircleAlert,
  LoaderCircle,
  MessagesSquare,
  Plus,
  RefreshCw,
  Send,
  Square,
  SquareTerminal,
  Trash2,
  Users,
  Workflow,
  X
} from 'lucide-react';
import { api, timestamp } from './shared.js';
import './harness-rooms.css';

const MODES = {
  chat: { label: '对话', icon: MessagesSquare, hint: '直接和一个或多个 harness 对话。多个成员时依次回复，并能看到彼此的最新回复。' },
  relay: { label: '接力', icon: Workflow, hint: '按顺序执行：每一棒拿到原始任务和上一棒的交接，失败即停。' },
  discuss: { label: '讨论', icon: Users, hint: '所有成员同时回答同一问题；下一轮每人都能看到其他人上一轮的观点。' }
};

function useRoomsEvents(onChange) {
  useEffect(() => {
    const stream = new EventSource('/api/events');
    stream.addEventListener('change', onChange);
    return () => stream.close();
  }, [onChange]);
}

export function SessionPicker({ harness, cwd, onPick, onClose }) {
  const [state, setState] = useState({ loading: true });
  const [scoped, setScoped] = useState(Boolean(cwd));
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    api(`/api/harnesses/${encodeURIComponent(harness.id)}/sessions${scoped && cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`)
      .then(data => live && setState(data))
      .catch(err => live && setState({ error: err.message }));
    return () => {
      live = false;
    };
  }, [harness.id, cwd, scoped]);
  return (
    <div className="session-picker" role="dialog" aria-label={`${harness.name} 的已有会话`}>
      <header>
        <strong>{harness.name} 的已有会话</strong>
        <small>包括在它的 CLI、桌面版里开过的会话</small>
        <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      {cwd && (
        <label className="picker-scope">
          <input type="checkbox" checked={scoped} onChange={e => setScoped(e.target.checked)} />
          只看当前工作目录
        </label>
      )}
      {state.loading && (
        <p className="muted">
          <LoaderCircle size={14} className="spin" />
          正在读取…
        </p>
      )}
      {state.error && <p className="form-error">{state.error}</p>}
      {state.supported === false && <p className="muted">{harness.name} 不支持列出会话。</p>}
      {state.sessions && (
        <ul>
          {state.sessions.map(s => (
            <li key={s.sessionId}>
              <button type="button" onClick={() => onPick(s)}>
                <span>{s.title || '（无标题）'}</span>
                <small>
                  {s.updatedAt ? timestamp(s.updatedAt) : ''} · <code>{s.cwd || ''}</code>
                </small>
              </button>
            </li>
          ))}
          {!state.sessions.length && <li className="muted">没有找到会话。</li>}
        </ul>
      )}
    </div>
  );
}

function NewRoom({ harnesses, onCreated, onCancel }) {
  const acp = harnesses.filter(h => h.transport === 'acp');
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState(() => localStorage.getItem('aihub.rooms.cwd') || '');
  const [mode, setMode] = useState('chat');
  const [members, setMembers] = useState([]);
  const [attach, setAttach] = useState({}); // harnessId -> native session id
  const [picker, setPicker] = useState(null); // harnessId whose sessions are listed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = id => {
    setMembers(list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]));
    setAttach(map => {
      const next = { ...map };
      delete next[id];
      return next;
    });
  };
  const move = (id, delta) =>
    setMembers(list => {
      const index = list.indexOf(id),
        next = [...list],
        target = index + delta;
      if (target < 0 || target >= list.length) return list;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim() || members.map(id => harnesses.find(h => h.id === id)?.name).join(' + '),
          cwd: cwd.trim() || undefined,
          mode,
          members: members.map(harnessId => ({ harnessId, ...(attach[harnessId] ? { sessionId: attach[harnessId] } : {}) }))
        })
      });
      if (cwd.trim()) localStorage.setItem('aihub.rooms.cwd', cwd.trim());
      onCreated(data.room.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="room-new" onSubmit={submit}>
      <header>
        <h2>新建会话</h2>
        <button type="button" className="icon-button" aria-label="取消" onClick={onCancel}>
          <X size={17} />
        </button>
      </header>
      <fieldset className="room-modes">
        <legend>方式</legend>
        {Object.entries(MODES).map(([id, item]) => (
          <label key={id} className={mode === id ? 'selected' : ''}>
            <input type="radio" name="mode" checked={mode === id} onChange={() => setMode(id)} />
            <item.icon size={16} />
            <span>
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="room-members">
        <legend>{mode === 'relay' ? '成员（按接力顺序）' : '成员'}</legend>
        <div className="member-grid">
          {acp.map(h => {
            const order = members.indexOf(h.id);
            return (
              <button
                type="button"
                key={h.id}
                className={order >= 0 ? 'member selected' : 'member'}
                onClick={() => toggle(h.id)}
                aria-pressed={order >= 0}
              >
                {order >= 0 && <span className="member-order">{order + 1}</span>}
                {h.name}
              </button>
            );
          })}
        </div>
        {members.length > 0 && (
          <ul className="member-sessions">
            {members.map(id => {
              const h = harnesses.find(x => x.id === id);
              return (
                <li key={id}>
                  <span>{h?.name}</span>
                  {attach[id] ? (
                    <>
                      <code title={attach[id]}>续接 {attach[id].slice(0, 18)}</code>
                      <button
                        type="button"
                        onClick={() =>
                          setAttach(map => {
                            const next = { ...map };
                            delete next[id];
                            return next;
                          })
                        }
                      >
                        改为新会话
                      </button>
                    </>
                  ) : (
                    <>
                      <small>新会话</small>
                      <button type="button" onClick={() => setPicker(id)}>
                        <History size={13} />
                        续接已有会话
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {picker && (
          <SessionPicker
            harness={harnesses.find(h => h.id === picker)}
            cwd={cwd.trim()}
            onPick={session => {
              setAttach(map => ({ ...map, [picker]: session.sessionId }));
              if (!cwd.trim() && session.cwd) setCwd(session.cwd);
              if (!title.trim() && session.title) setTitle(session.title.slice(0, 120));
              setPicker(null);
            }}
            onClose={() => setPicker(null)}
          />
        )}
        {mode === 'relay' && members.length > 1 && (
          <ol className="relay-order">
            {members.map((id, index) => (
              <li key={id}>
                <span>{harnesses.find(h => h.id === id)?.name}</span>
                <button type="button" disabled={index === 0} onClick={() => move(id, -1)}>
                  上移
                </button>
                <button type="button" disabled={index === members.length - 1} onClick={() => move(id, 1)}>
                  下移
                </button>
              </li>
            ))}
          </ol>
        )}
      </fieldset>
      <label className="field">
        <span>工作目录</span>
        <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/path/to/project （留空为用户主目录）" />
        <small>harness 在这个目录里读写文件。</small>
      </label>
      <label className="field">
        <span>名称（可选）</span>
        <input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          <CircleAlert size={15} />
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button className="primary" type="submit" disabled={busy || !members.length}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}创建
        </button>
      </div>
    </form>
  );
}

function PermissionCard({ permission, name }) {
  const [busy, setBusy] = useState(false);
  const decide = async optionId => {
    setBusy(true);
    try {
      await api(`/api/permissions/${encodeURIComponent(permission.requestId)}`, { method: 'POST', body: JSON.stringify({ optionId }) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="room-permission" role="alert">
      <div>
        <strong>
          {name} 请求权限：{permission.title}
        </strong>
        <small>{permission.kind}</small>
      </div>
      {permission.detail && permission.detail !== '{}' && (
        <details>
          <summary>参数</summary>
          <pre>{permission.detail}</pre>
        </details>
      )}
      <div className="permission-actions">
        {permission.options.map(option => (
          <button
            key={option.optionId}
            disabled={busy}
            className={option.kind.startsWith('allow') ? 'primary' : ''}
            onClick={() => decide(option.optionId)}
          >
            {option.name || option.kind}
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ message, name }) {
  if (message.role === 'user')
    return (
      <div className="msg msg-user">
        <p>{message.text}</p>
      </div>
    );
  if (message.role === 'system')
    return (
      <div className="msg msg-system">
        <CircleAlert size={14} />
        {message.text}
      </div>
    );
  return (
    <div className={`msg msg-agent msg-${message.status}`}>
      <header>
        <strong>{name}</strong>
        <span>
          {message.status === 'running' && (
            <>
              <LoaderCircle size={13} className="spin" />
              回复中
            </>
          )}
          {message.status === 'done' && (
            <>
              <Check size={13} />
              {timestamp(message.updatedAt)}
            </>
          )}
          {message.status === 'cancelled' && '已停止'}
          {message.status === 'failed' && <span className="text-danger">失败</span>}
        </span>
      </header>
      {message.thought && (
        <details className="msg-thought">
          <summary>思考过程</summary>
          <pre>{message.thought}</pre>
        </details>
      )}
      {message.tools?.length > 0 && (
        <ul className="msg-tools">
          {message.tools.map(tool => (
            <li key={tool.id} className={`tool-${tool.status || 'pending'}`}>
              <span>{tool.title}</span>
              {tool.paths?.length > 0 && <code>{tool.paths.join(', ')}</code>}
            </li>
          ))}
        </ul>
      )}
      {message.text ? (
        <div className="msg-text">{message.text}</div>
      ) : message.status === 'running' ? null : (
        <div className="msg-text muted">（没有文字输出）</div>
      )}
      {message.error && <p className="form-error">{message.error}</p>}
    </div>
  );
}

async function openSurface(harnessId, surface, { cwd, sessionId } = {}) {
  return api(`/api/harnesses/${encodeURIComponent(harnessId)}/open`, { method: 'POST', body: JSON.stringify({ surface, cwd, sessionId }) });
}

export function SurfaceButtons({ harness, cwd, sessionId, onError, compact = false }) {
  const s = harness?.surfaces || {};
  const go = surface => openSurface(harness.id, surface, { cwd, sessionId }).catch(err => onError(err.message));
  return (
    <span className="surface-buttons">
      {s.cli && (
        <button type="button" onClick={() => go('cli')} title={sessionId && s.cliResume ? '在终端中续接这个会话' : '在终端中打开'}>
          <SquareTerminal size={13} />
          CLI{compact || (sessionId && s.cliResume) ? '' : '（新）'}
        </button>
      )}
      {s.desktop && (
        <button
          type="button"
          onClick={() => go('desktop')}
          title={sessionId && s.desktopSession ? '在桌面版中打开这个会话' : '打开桌面版（不能定位到这个会话）'}
        >
          <AppWindow size={13} />
          桌面版
        </button>
      )}
      {s.web && (
        <button
          type="button"
          onClick={() => go('web')}
          title={sessionId && s.webSession ? '在网页版中打开这个会话' : '打开网页版（不能定位到这个会话）'}
        >
          <Globe size={13} />
          网页版
        </button>
      )}
    </span>
  );
}

function RoomView({ roomId, harnesses, onDeleted }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [targets, setTargets] = useState([]);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef(null);
  const nameOf = useCallback(id => harnesses.find(h => h.id === id)?.name || id, [harnesses]);
  const load = useCallback(async () => {
    try {
      setData(await api(`/api/rooms/${encodeURIComponent(roomId)}`));
    } catch (err) {
      setError(err.message);
    }
  }, [roomId]);
  useEffect(() => {
    setData(null);
    setTargets([]);
    load();
  }, [load]);
  useRoomsEvents(load);
  const count = data?.messages.length || 0;
  const tail = data?.messages.at(-1)?.text?.length || 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [count, tail]);
  if (!data)
    return (
      <div className="room-empty">
        <LoaderCircle className="spin" size={20} />
      </div>
    );
  const { room, messages, running, permissions } = data;
  const members = room.members.map(m => m.harnessId);
  const send = async event => {
    event?.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setError('');
    try {
      await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, targets: targets.length ? targets : undefined })
      });
      setText('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };
  const stop = harnessId =>
    api(`/api/rooms/${encodeURIComponent(roomId)}/cancel`, { method: 'POST', body: JSON.stringify({ harnessId }) }).then(load);
  const remove = async () => {
    if (!confirm(`删除会话「${room.title}」及其全部记录？`)) return;
    await api(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
    onDeleted();
  };
  const Mode = MODES[room.mode] || MODES.chat;
  return (
    <section className="room">
      <header className="room-header">
        <div>
          <h2>{room.title}</h2>
          <p>
            <Mode.icon size={13} />
            {Mode.label} · {members.map(nameOf).join(room.mode === 'relay' ? ' → ' : '、')} · <code>{room.cwd}</code>
          </p>
        </div>
        <div className="room-header-actions">
          {running.length > 0 && (
            <button onClick={() => stop(null)}>
              <Square size={14} />
              全部停止
            </button>
          )}
          <button className="icon-button" aria-label="删除会话" title="删除会话" onClick={remove}>
            <Trash2 size={16} />
          </button>
        </div>
      </header>
      <div className="room-members-bar" aria-label="在其他入口打开">
        {room.members.map(m => {
          const h = harnesses.find(x => x.id === m.harnessId);
          return (
            <span key={m.harnessId} className="member-chip">
              <strong>{h?.name || m.harnessId}</strong>
              {m.sessionId ? <code title={m.sessionId}>{m.sessionId.slice(0, 12)}</code> : <small>未开始</small>}
              <SurfaceButtons harness={h} cwd={room.cwd} sessionId={m.sessionId} onError={setError} />
            </span>
          );
        })}
      </div>
      <div className="room-log">
        {!messages.length && <div className="room-hint">{Mode.hint}</div>}
        {messages.map(m => (
          <Message key={m.id} message={m} name={nameOf(m.harnessId)} />
        ))}
        <div ref={end} />
      </div>
      {permissions.map(p => (
        <PermissionCard key={p.requestId} permission={p} name={nameOf(p.harnessId)} />
      ))}
      <form className="room-composer" onSubmit={send}>
        {room.mode === 'chat' && members.length > 1 && (
          <div className="composer-targets" role="group" aria-label="发送给">
            <span>发给</span>
            <button type="button" className={!targets.length ? 'active' : ''} onClick={() => setTargets([])}>
              全部
            </button>
            {members.map(id => (
              <button
                type="button"
                key={id}
                className={targets.includes(id) ? 'active' : ''}
                onClick={() => setTargets(list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))}
              >
                {nameOf(id)}
                {running.includes(id) && <LoaderCircle size={12} className="spin" />}
              </button>
            ))}
          </div>
        )}
        <div className="composer-row">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e);
            }}
            placeholder={room.mode === 'relay' ? '描述要接力完成的任务…' : room.mode === 'discuss' ? '抛出要讨论的问题…' : '发消息…'}
            rows={3}
          />
          <button className="primary" type="submit" disabled={sending || !text.trim()}>
            {sending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}发送
          </button>
        </div>
        <small className="composer-hint">⌘↩ 发送{running.length ? ` · ${running.map(nameOf).join('、')} 正在回复` : ''}</small>
        {error && (
          <p className="form-error" role="alert">
            <CircleAlert size={15} />
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

export default function HarnessRooms({ onOpenBoard }) {
  const [harnesses, setHarnesses] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [pending, setPending] = useState([]);
  const [selected, setSelected] = useState(() => localStorage.getItem('aihub.rooms.selected'));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const loadRooms = useCallback(async () => {
    try {
      const data = await api('/api/rooms');
      setRooms(data.rooms);
      setPending(data.permissions);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  const loadHarnesses = useCallback(async refresh => {
    try {
      setHarnesses((await api(`/api/harnesses${refresh ? '?refresh=1' : ''}`)).harnesses);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    loadHarnesses(false);
    loadRooms();
  }, [loadHarnesses, loadRooms]);
  useRoomsEvents(loadRooms);
  useEffect(() => {
    if (selected) localStorage.setItem('aihub.rooms.selected', selected);
  }, [selected]);
  const current = rooms.find(r => r.id === selected);
  const terminalOnly = useMemo(() => harnesses.filter(h => h.transport === 'terminal'), [harnesses]);
  const [launchers, setLaunchers] = useState([]);
  useEffect(() => {
    api('/api/launchers')
      .then(d => setLaunchers(d.launchers))
      .catch(() => {});
  }, []);
  const launch = id =>
    api(`/api/launchers/${encodeURIComponent(id)}/open`, { method: 'POST', body: '{}' }).catch(err => setError(err.message));
  return (
    <div className="rooms-shell">
      <aside className="rooms-sidebar">
        <button className="primary rooms-new" onClick={() => setCreating(true)}>
          <Plus size={15} />
          新建会话
        </button>
        <nav aria-label="会话">
          {rooms.map(r => {
            const Mode = MODES[r.mode] || MODES.chat;
            const waiting = pending.filter(p => p.roomId === r.id).length;
            return (
              <button
                key={r.id}
                className={r.id === selected && !creating ? 'room-link active' : 'room-link'}
                onClick={() => {
                  setSelected(r.id);
                  setCreating(false);
                }}
              >
                <Mode.icon size={14} />
                <span>{r.title}</span>
                {waiting > 0 && <em title="等待权限确认">{waiting}</em>}
              </button>
            );
          })}
          {!rooms.length && <p className="rooms-none">还没有会话</p>}
        </nav>
        <section className="rooms-harnesses">
          <header>
            <h3>本机 harness</h3>
            <button className="icon-button" aria-label="重新扫描" title="重新扫描" onClick={() => loadHarnesses(true)}>
              <RefreshCw size={14} />
            </button>
          </header>
          <ul>
            {harnesses
              .filter(h => h.transport === 'acp')
              .map(h => (
                <li key={h.id} className="harness-row">
                  <i className="dot live" />
                  <span>{h.name}</span>
                  <SurfaceButtons
                    compact
                    harness={h}
                    cwd={current?.cwd || localStorage.getItem('aihub.rooms.cwd') || undefined}
                    onError={setError}
                  />
                </li>
              ))}
          </ul>
          {terminalOnly.length > 0 && (
            <>
              <h4>不能进会话（只能单独打开）</h4>
              <ul>
                {terminalOnly.map(h => (
                  <li key={h.id}>
                    <span className="harness-row">
                      <i className="dot" />
                      <span>{h.name}</span>
                      <SurfaceButtons
                        compact
                        harness={h}
                        cwd={current?.cwd || localStorage.getItem('aihub.rooms.cwd') || undefined}
                        onError={setError}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {launchers.length > 0 && (
            <>
              <h4>其他桌面版 / 网页版（仅打开）</h4>
              <div className="launcher-grid">
                {launchers.map(l => (
                  <button key={l.id} type="button" onClick={() => launch(l.id)} title={l.kind === 'web' ? l.url : l.app}>
                    {l.kind === 'web' ? <Globe size={12} /> : <AppWindow size={12} />}
                    {l.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
        <button className="text-button rooms-board" onClick={onOpenBoard}>
          任务看板
          <ArrowRight size={13} />
        </button>
      </aside>
      <main className="rooms-main">
        {error && (
          <div className="error-banner" role="alert">
            <CircleAlert size={16} />
            <span>{error}</span>
            <button className="icon-button" aria-label="关闭" onClick={() => setError('')}>
              <X size={15} />
            </button>
          </div>
        )}
        {creating || !current ? (
          creating || !rooms.length ? (
            <NewRoom
              harnesses={harnesses}
              onCancel={() => setCreating(false)}
              onCreated={async id => {
                await loadRooms();
                setSelected(id);
                setCreating(false);
              }}
            />
          ) : (
            <div className="room-empty">选择左侧会话，或新建一个。</div>
          )
        ) : (
          <RoomView
            key={current.id}
            roomId={current.id}
            harnesses={harnesses}
            onDeleted={async () => {
              setSelected(null);
              await loadRooms();
            }}
          />
        )}
      </main>
    </div>
  );
}
