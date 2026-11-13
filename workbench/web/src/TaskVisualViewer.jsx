import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, LoaderCircle, Minus, Plus, Scan } from 'lucide-react';
import { createToolRequests, uncertainToolUseError } from './TaskToolsPanel.jsx';
import './task-visual-viewer.css';

export function imageViewSize(image, zoom) {
  return zoom == null
    ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
    : { width: Math.round((image.width * zoom) / 100), height: 'auto', maxWidth: 'none', maxHeight: 'none' };
}

const selectionBlocked = (task, preview, state) => {
  const stopped =
    ['running', 'done', 'cancelled', 'archived'].includes(task.status) || task.manualOverrides?.cancelled || task.manualOverrides?.locked;
  const contextChanged = (task.knowledgeContext?.digest ?? null) !== preview.contextDigest;
  return state.busy || state.inputBusy || state.used || stopped || (!state.uncertain && (state.imageState !== 'loaded' || contextChanged));
};

export function verifiedVisualUseReceipt(value, task, body) {
  const selected =
    Array.isArray(value?.context?.items) && value.context.items.find(item => item?.kind === 'resource' && item.id === value?.resource?.id);
  if (
    value?.context?.taskId !== task.id ||
    value.context.projectId !== task.projectId ||
    value.context.status !== 'prepared' ||
    !/^[a-f0-9]{64}$/.test(value.context.digest || '') ||
    !value.resource?.id ||
    value.resource.projectId !== task.projectId ||
    value.resource.source !== 'eagle' ||
    value.resource.expectedPreviewHash !== body.expectedPreviewHash ||
    !/^[a-f0-9]{64}$/.test(value.resource.expectedVisualFingerprint || '') ||
    !Array.isArray(value.context.resourceIds) ||
    !value.context.resourceIds.includes(value.resource.id) ||
    !selected ||
    !/^[a-f0-9]{64}$/.test(selected.hash || '') ||
    selected.provenance?.source !== 'eagle'
  ) {
    const failure = new Error('服务未返回完整的图片选用收据，请核对同一个请求。');
    failure.outcomeUnknown = true;
    throw failure;
  }
  return value;
}

export default function TaskVisualViewer({ task, api, preview, onChange, onClose, onBusyChange, inputBusy = false }) {
  const [zoom, setZoom] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [used, setUsed] = useState(false);
  const [uncertain, setUncertain] = useState(null),
    [imageState, setImageState] = useState('loading');
  const requests = useRef(createToolRequests()),
    live = useRef(false),
    mutation = useRef(false),
    actions = useRef({ onChange, onBusyChange });
  actions.current = { onChange, onBusyChange };
  const scope = `${task.projectId}:${task.id}:${preview.candidateId}`;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      actions.current.onBusyChange?.(false);
    };
  }, []);
  useEffect(() => {
    actions.current.onBusyChange?.(Boolean(busy || uncertain));
  }, [busy, uncertain]);
  const state = { zoom, busy, inputBusy, error, notice, used, uncertain, imageState };
  const useImage = async () => {
    if (mutation.current || selectionBlocked(task, preview, state)) return;
    const body = uncertain?.body || {
      candidateId: preview.candidateId,
      expectedPreviewHash: preview.previewHash,
      expectedVisualDigest: preview.visualDigest,
      expectedContextDigest: preview.contextDigest,
      confirmed: true
    };
    const requestId = uncertain?.requestId || requests.current.get(scope, body);
    mutation.current = true;
    actions.current.onBusyChange?.(true);
    setBusy(true);
    setError('');
    try {
      verifiedVisualUseReceipt(
        await api(`/api/tasks/${encodeURIComponent(task.id)}/tools/use`, { method: 'POST', body: JSON.stringify({ ...body, requestId }) }),
        task,
        body
      );
      requests.current.clear(scope, body);
      actions.current.onChange?.();
      if (live.current) {
        setUncertain(false);
        setUsed(true);
        setNotice('已加入本任务输入，并保留原有引用。图片未发送模型，没有启动任务。');
      }
    } catch (failure) {
      if (live.current) {
        const unknown = uncertainToolUseError(failure);
        if (unknown) setUncertain({ body, requestId });
        setError(
          unknown ? '连接或服务响应中断，输入可能已保存。请核对同一个请求；核对完成前保留当前工作区，不会新建第二次操作。' : failure.message
        );
      }
    } finally {
      mutation.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <TaskVisualViewerView
      {...{ task, preview, state, setZoom, useImage, onClose }}
      onImageLoad={event =>
        setImageState(event.currentTarget.naturalWidth > 0 && event.currentTarget.naturalHeight > 0 ? 'loaded' : 'failed')
      }
      onImageError={() => setImageState('failed')}
    />
  );
}

export function TaskVisualViewerView({ task, preview, state, setZoom, useImage, onClose, onImageLoad, onImageError }) {
  const { zoom, busy, error, notice, used, uncertain, imageState } = state;
  const contextChanged = (task.knowledgeContext?.digest ?? null) !== preview.contextDigest;
  return (
    <section className="task-visual-viewer" aria-label="本任务图片工作区">
      <header>
        <div>
          <span className="eyebrow">Eagle · 本任务材料</span>
          <h2>{preview.title}</h2>
        </div>
        <button type="button" disabled={busy || Boolean(uncertain)} onClick={onClose}>
          <ArrowLeft size={15} />
          返回工作流
        </button>
      </header>
      <div className="task-visual-toolbar">
        <div role="group" aria-label="图片缩放">
          <button type="button" aria-label="缩小图片" onClick={() => setZoom(value => Math.max(25, (value ?? 100) - 25))}>
            <Minus size={16} />
          </button>
          <span>{zoom == null ? '适应窗口' : `${zoom}%`}</span>
          <button type="button" aria-label="放大图片" onClick={() => setZoom(value => Math.min(400, (value ?? 100) + 25))}>
            <Plus size={16} />
          </button>
          <button type="button" onClick={() => setZoom(null)}>
            <Scan size={15} />
            适应窗口
          </button>
          <button type="button" onClick={() => setZoom(100)}>
            原始尺寸
          </button>
        </div>
        <button type="button" className="primary" disabled={selectionBlocked(task, preview, state)} onClick={useImage}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
          {used ? '已加入任务输入' : uncertain ? '核对上次选用结果' : '选用这份图片材料'}
        </button>
      </div>
      {!used && contextChanged && !uncertain && <p role="status">任务输入已经变化，请返回工具重新预览后选择；当前图片仍可查看。</p>}
      {imageState === 'loading' && (
        <p className="task-visual-image-status" role="status">
          {uncertain ? '图片正在载入，可先核对上次选用结果。' : '正在载入图片；显示成功后才可选用。'}
        </p>
      )}
      {imageState === 'failed' && (
        <p className="task-visual-error" role="alert">
          {used
            ? '当前图片暂未显示；已保存的选用回执不受影响。'
            : uncertain
              ? '图片暂未显示。可先核对上次选用结果；再次选择图片前须重新预览。'
              : '这份图片未能显示。请返回工具重新预览，显示成功后再选用。'}
        </p>
      )}
      {error && (
        <p className="task-visual-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="task-visual-notice" role="status">
          {notice}
        </p>
      )}
      <div className="task-visual-stage" data-fit={zoom == null}>
        <img
          src={preview.image.url}
          alt={preview.title}
          style={imageViewSize(preview.image, zoom)}
          draggable={false}
          onLoad={onImageLoad}
          onError={onImageError}
        />
      </div>
      <div className="task-visual-caption">
        <span>
          {preview.image.kind === 'thumbnail' ? '实际缩略图' : '实际图片'} · {preview.image.width} × {preview.image.height} ·{' '}
          {Math.ceil(preview.image.bytes / 1024)} KiB
        </span>
        <p>{preview.limitation || '仅在本机显示这份 Eagle 图片；图片未发送模型。'}</p>
        {preview.metadata?.annotation && <p>{preview.metadata.annotation}</p>}
        {preview.metadata?.tags?.length > 0 && <p>标签：{preview.metadata.tags.join('、')}</p>}
        <details>
          <summary>来源与图片核验</summary>
          <p>
            Eagle 条目：{preview.metadata?.id} · {preview.readAt}
          </p>
          <code>SHA-256 {preview.image.hash}</code>
          <p>原文件与库由 Eagle 管理；选择时会重新核对图片版本。</p>
        </details>
      </div>
    </section>
  );
}
