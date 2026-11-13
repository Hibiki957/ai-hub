import React, { useRef, useState } from 'react';

export default function ExecutionOwnerConnection({ api, owner, onUpdated }) {
  const requestId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const connect = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = owner?.agentId
        ? await api('/api/connections')
        : await api('/api/connections/execution-owner', {
            method: 'POST',
            body: JSON.stringify({ requestId: requestId.current, confirmed: true })
          });
      await onUpdated();
      if (!data.executionOwner?.ready) throw new Error(data.executionOwner?.reason || '责任连接未通过当前核验，没有启动任务。');
      setNotice('责任连接已核验。本次没有调用模型，也没有恢复任务。');
    } catch (failure) {
      setError(failure?.data?.error?.message || failure?.message || '责任连接暂不可用，请核对后重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="connection-metering" aria-label="任务责任连接">
      <h3>任务责任连接</h3>
      <p>
        <strong>{owner?.ready ? '已核验 · Hub 专属责任记录' : owner?.agentId ? '已登记 · 需要核验' : '尚未登记'}</strong>
      </p>
      <p>Paperclip 用它记录任务负责人；模型和执行工具仍按工作方案分配。该记录保持暂停，没有执行命令，定时和按需唤醒均关闭。</p>
      <p>登记只新增这一份专属记录，不启动模型或任务。连接被其他人修改时停止使用，既有 Agent 仍由原工具管理。</p>
      {owner?.agentId && <small>责任记录 {owner.agentId}</small>}
      {owner?.reason && <p role="status">{owner.reason}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button type="button" disabled={busy} onClick={connect}>
        {busy ? '正在核验…' : owner?.agentId ? '重新核验责任连接' : '登记 Hub 专属责任连接（不调用模型）'}
      </button>
    </section>
  );
}
