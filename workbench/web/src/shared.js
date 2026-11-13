export const money = (value, currency = 'USD') =>
  value == null ? '待计量' : new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 4 }).format(value);
export const timestamp = value =>
  value
    ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    : '—';
export const asText = value => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2));
export const safeLink = value => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};
export const uid = () => crypto.randomUUID();
export const harnessEvidence = item =>
  !item.verified
    ? '未联通，不参与调度'
    : item.artifactManifestVerified
      ? '已有真实文件交付记录'
      : item.modelVerified
        ? '已有真实模型回复 · 交付未验收'
        : item.id === 'api-text'
          ? '文字接口可调用 · 模型回复未验收'
          : '传输已验证 · 模型与交付未验收';

export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(
      data.error?.message || data.message || (typeof data.error === 'string' ? data.error : `请求失败（${response.status}）`)
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
