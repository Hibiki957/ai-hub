import React, { useEffect, useState } from 'react';

/** The path is never supplied by the page. The host resolves a completed,
 * task-bound artifact ID and rechecks the bytes against its delivery receipt. */
export default function ArtifactFile({ api, taskId, artifact }) {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifact.id)}`;
  useEffect(() => {
    setPreview(null);
    setError('');
  }, [base, artifact.hash, artifact.sha256]);
  const read = async () => {
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const data = await api(base + '/preview');
      if (data.verified !== true || data.actualHash !== (artifact.hash || artifact.sha256))
        throw new Error('产物正文与这份交付回执不一致。');
      setPreview(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="artifact-file-access">
      <div className="form-actions">
        <button disabled={busy} onClick={read}>
          {busy ? '正在核验文件…' : preview ? '重新核验原文件' : '预览原文件'}
        </button>
        <a href={base + '/download'} download>
          下载原文件
        </a>
      </div>
      {preview && (
        <details open>
          <summary>{preview.artifact.name || artifact.title} · 正文已与交付哈希核对</summary>
          <pre>{preview.text}</pre>
          <small>
            {preview.artifact.size} bytes · SHA-256 {preview.actualHash}
          </small>
        </details>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
