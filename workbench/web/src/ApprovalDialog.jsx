import React, { useState } from 'react';
import { Check, LoaderCircle, ShieldCheck } from 'lucide-react';
import { timestamp, asText } from './shared.js';
import { GATE, Field, Dialog, FormError } from './ui.jsx';

export function approvalPublication(approval) {
  const action = approval.action || {},
    bound = approval.actionBound !== false;
  const file = bound && ['document_publication', 'manual_document_publication'].includes(action.operation);
  const notion = bound && action.operation === 'notion_page_publication';
  const publication = action.publication || {},
    sourceHash = publication.sourceHash || action.sourceHash,
    resultHash = publication.resultHash || action.resultHash;
  const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const notionValid =
    !notion ||
    (typeof publication.pageId === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(publication.pageId) &&
      publication.taskId === approval.taskId &&
      action.taskId === approval.taskId &&
      typeof action.draftId === 'string' &&
      action.draftId === publication.draftId &&
      hex(publication.digest) &&
      action.publicationDigest === publication.digest &&
      hex(sourceHash) &&
      hex(resultHash) &&
      action.sourceHash === publication.sourceHash &&
      action.resultHash === publication.resultHash);
  return {
    file,
    notion,
    publication: file || notion,
    title: action.resourceTitle || publication.title || (notion ? 'Notion 页面' : '选定文件'),
    pageId: publication.pageId || null,
    sourceHash: sourceHash || null,
    resultHash: resultHash || null,
    valid: notionValid
  };
}

export const approvalDecisionCommand = (approval, allow, note) => ({
  type: 'approval.decide',
  id: approval.id,
  allow,
  note,
  digest: approval.digest,
  taskRevision: approval.taskRevision
});

export default function ApprovalDialog({ approval, task, count, command }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async allow => {
    if (busy || (allow && !approvalPublication(approval).valid)) return;
    setBusy(true);
    setError('');
    try {
      await command(approvalDecisionCommand(approval, allow, note));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="这里需要你拍板"
      subtitle={`${count > 1 ? `还有 ${count} 项待决策 · ` : ''}${approval.actionBound === false ? 'Paperclip 原生审批' : GATE[approval.kind] || '关键节点'}`}
      blocking
      className="approval-dialog"
    >
      <ApprovalDialogBody {...{ approval, task, note, error, busy }} onNote={setNote} onDecide={decide} />
    </Dialog>
  );
}

export function ApprovalDialogBody({ approval, task, note = '', error = '', busy = false, onNote, onDecide }) {
  const publication = approvalPublication(approval);
  return (
    <div className="dialog-body">
      <div className="approval-task">
        <ShieldCheck size={20} />
        <span>{task?.title || task?.goal || '任务决策'}</span>
      </div>
      <h3 className="approval-title">{approval.title}</h3>
      {publication.notion ? (
        <div className="approval-detail" aria-label="Notion 页面发布确认">
          <p>将你刚查看的修改发布到 Notion 页面「{publication.title}」。</p>
          <p>确认后仅对这一个页面发起一次写回，并读回正文核验。不调用模型，不自动继续任务。</p>
          <p>写回前会核对页面与连接；冲突或结果不明时停止，不自动重发。</p>
          <div className="approval-audit">
            <dl>
              <dt>页面 ID</dt>
              <dd>
                <code>{publication.pageId || '未提供'}</code>
              </dd>
              <dt>来源正文 SHA-256</dt>
              <dd>
                <code>{publication.sourceHash || '未提供'}</code>
              </dd>
              <dt>待发布正文 SHA-256</dt>
              <dd>
                <code>{publication.resultHash || '未提供'}</code>
              </dd>
            </dl>
          </div>
          {!publication.valid && (
            <p className="form-error" role="alert">
              页面或正文版本绑定不完整，当前不能批准写回。请保留原页，刷新并重新核对发布申请。
            </p>
          )}
          <details>
            <summary>查看本次发布的核验记录</summary>
            <pre>{asText(approval.detail)}</pre>
          </details>
        </div>
      ) : publication.file ? (
        <div className="approval-detail">
          <p>将你刚查看的修改发布到「{publication.title}」。原件若已变化，Hub 会停止发布并保留冲突。</p>
          <p>确认后只发布这一份文件，不重跑任务、不调用模型。</p>
          <details>
            <summary>查看本次发布的核验记录</summary>
            <pre>{asText(approval.detail)}</pre>
          </details>
        </div>
      ) : (
        <div className="approval-detail">{asText(approval.detail)}</div>
      )}
      <p className="approval-context">
        {approval.actionBound === false
          ? '此决定只更新 Paperclip 的原生审批状态，不是花费、发布或改文件等操作的动作授权。'
          : '这次决定只对应当前操作。目标或操作变化后，需要重新确认。'}
      </p>
      <Field label="补充意见（可选）">
        <textarea rows={2} value={note} onChange={event => onNote?.(event.target.value)} placeholder="需要遵守的限制，或拒绝的原因…" />
      </Field>
      <details className="approval-audit">
        <summary>查看审批绑定信息</summary>
        <dl>
          <dt>任务版本</dt>
          <dd>{approval.taskRevision || '未绑定'}</dd>
          <dt>有效至</dt>
          <dd>{timestamp(approval.expiresAt)}</dd>
          <dt>操作摘要</dt>
          <dd>
            <code>{approval.digest || '上游未提供动作绑定摘要'}</code>
          </dd>
        </dl>
      </details>
      <FormError value={error} />
      <div className="form-actions">
        <button disabled={busy} onClick={() => onDecide?.(false)}>
          {publication.notion ? '保留原页，暂不发布' : publication.file ? '保留原件，暂不发布' : '不通过，交回编排者'}
        </button>
        <button className="primary" disabled={busy || !publication.valid} onClick={() => onDecide?.(true)}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
          {publication.notion
            ? '确认并发布到 Notion'
            : publication.file
              ? '确认并发布'
              : approval.actionBound === false
                ? '确认审批决定'
                : '确认这次操作'}
        </button>
      </div>
    </div>
  );
}
