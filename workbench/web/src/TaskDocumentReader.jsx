import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, FileText, LoaderCircle, Minus, Plus, Search, Square, ZoomIn } from 'lucide-react';
import pdfWorkerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { uncertainToolUseError } from './TaskToolsPanel.jsx';
import './task-document-reader.css';

const HASH = /^[a-f0-9]{64}$/;
const MAX_BATCH = 50,
  MAX_HITS = 200;
const message = failure => failure?.data?.error?.message || failure?.message || '文档操作未完成，请核对后重试。';
const cancelled = failure => ['AbortError', 'RenderingCancelledException'].includes(failure?.name);
const stopped = task =>
  ['running', 'done', 'cancelled', 'archived'].includes(task.status) || task.manualOverrides?.cancelled || task.manualOverrides?.locked;

export function documentReaderBinding(task, reader) {
  if (
    !task?.id ||
    !task?.projectId ||
    !reader?.readerId ||
    !HASH.test(reader.document?.hash || '') ||
    !Number.isSafeInteger(reader.document?.pages) ||
    reader.document.pages < 1 ||
    reader.document.pages > 1000 ||
    !Number.isSafeInteger(reader.document?.bytes) ||
    reader.document.bytes < 1 ||
    reader.document.bytes > 16 * 1024 * 1024
  )
    throw new Error('文档缺少可核验的任务范围或文件版本，请重新打开附件。');
  const base = `/api/tasks/${encodeURIComponent(task.id)}/tools/documents/${encodeURIComponent(reader.readerId)}`;
  let url;
  try {
    url = new URL(reader.contentURL, 'https://hub.invalid');
  } catch {
    throw new Error('文档读取地址无效。');
  }
  if (
    typeof reader.contentURL !== 'string' ||
    !reader.contentURL.startsWith('/') ||
    reader.contentURL.startsWith('//') ||
    url.origin !== 'https://hub.invalid' ||
    !url.pathname.startsWith(base + '/') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('只允许在本任务中读取同源文档，不加载外部文档地址。');
  return {
    base,
    contentURL: url.pathname,
    scope: JSON.stringify([task.projectId, task.id, reader.readerId, reader.document.hash]),
    pages: reader.document.pages,
    sourceHash: reader.document.hash
  };
}

export function verifiedDocumentPage(value, { page, sourceHash, pages }) {
  if (
    value?.page !== page ||
    value.pages !== pages ||
    value.sourceHash !== sourceHash ||
    !HASH.test(value.textHash || '') ||
    typeof value.text !== 'string' ||
    value.text.length > 256 * 1024 ||
    typeof value.pageLabel !== 'string'
  )
    throw new Error('页码、来源版本或本页正文核验不一致，请重新打开附件。');
  return value;
}

// Offsets are UTF-16 positions in the exact server text, as used by textarea
// selectionStart/selectionEnd. A case-insensitive match must not be found in a
// separately lowercased string: some Unicode mappings change its length.
export function findDocumentMatches(text, query, limit = MAX_HITS) {
  if (
    typeof text !== 'string' ||
    typeof query !== 'string' ||
    !query.trim() ||
    query.length > 200 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_HITS
  )
    return { matches: [], more: false };
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches = [];
  for (const match of text.matchAll(expression)) {
    if (matches.length === limit) return { matches, more: true };
    const startOffset = match.index,
      endOffset = startOffset + match[0].length;
    matches.push({ startOffset, endOffset, excerpt: text.slice(Math.max(0, startOffset - 45), Math.min(text.length, endOffset + 65)) });
  }
  return { matches, more: false };
}

export function documentSearchBatch(start, pages) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(pages) || start < 1 || start > pages || pages > 1000) return [];
  return Array.from({ length: Math.min(MAX_BATCH, pages - start + 1) }, (_, index) => start + index);
}

export function documentCanvasSize(viewport, ratio = 1) {
  const width = viewport?.width,
    height = viewport?.height;
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 20000))
    throw new Error('该页尺寸超过预览范围，请在原应用查看。');
  const outputScale = Math.min(
    Math.max(Number.isFinite(ratio) ? ratio : 1, 1),
    2,
    8192 / width,
    8192 / height,
    Math.sqrt(9_000_000 / (width * height))
  );
  return {
    width: Math.max(1, Math.floor(width * outputScale)),
    height: Math.max(1, Math.floor(height * outputScale)),
    cssWidth: Math.ceil(width),
    cssHeight: Math.ceil(height),
    outputScale
  };
}

export function createDocumentReaderRequests(makeId = () => crypto.randomUUID()) {
  const requests = new Map();
  const key = (scope, body) => JSON.stringify([scope, body]);
  return {
    get(scope, body) {
      const id = key(scope, body);
      if (!requests.has(id)) requests.set(id, makeId());
      return requests.get(id);
    },
    clear(scope, body) {
      requests.delete(key(scope, body));
    }
  };
}

export function verifiedDocumentUseReceipt(value, task, body) {
  const selected =
    Array.isArray(value?.context?.items) && value.context.items.find(item => item?.kind === 'resource' && item.id === value?.resource?.id);
  if (
    value?.context?.taskId !== task.id ||
    value.context.projectId !== task.projectId ||
    value.context.status !== 'prepared' ||
    !HASH.test(value.context.digest || '') ||
    !value.resource?.id ||
    value.resource.projectId !== task.projectId ||
    value.resource.source !== 'zotero' ||
    value.resource.expectedPreviewHash !== body.expectedPreviewHash ||
    !value.resource.zoteroExcerpt ||
    !Array.isArray(value.context.resourceIds) ||
    !value.context.resourceIds.includes(value.resource.id) ||
    !selected ||
    !HASH.test(selected.hash || '') ||
    selected.provenance?.source !== 'zotero' ||
    selected.provenance?.kind !== 'pdf-page-excerpt'
  ) {
    const failure = new Error('服务未返回完整的引用选用收据，请核对同一个请求。');
    failure.outcomeUnknown = true;
    throw failure;
  }
  return value;
}

const selectionEmpty = { start: 0, end: 0 };
const initialSearch = {
  query: '',
  nextPage: 1,
  checked: 0,
  first: 0,
  last: 0,
  hits: [],
  busy: false,
  limited: false,
  error: '',
  cancelled: false
};

export default function TaskDocumentReader(props) {
  let binding;
  try {
    binding = documentReaderBinding(props.task, props.reader);
  } catch (failure) {
    return (
      <section className="task-document-reader" aria-label="本任务 PDF 阅读区">
        <p role="alert">{message(failure)}</p>
        <button type="button" onClick={props.onClose}>
          <ArrowLeft size={15} />
          返回工作流
        </button>
      </section>
    );
  }
  return <DocumentReaderSession key={binding.scope} {...props} binding={binding} />;
}

function DocumentReaderSession({ task, api, reader, onChange, onClose, onBusyChange, inputBusy = false, binding }) {
  const [page, setPage] = useState(1),
    [pageInput, setPageInput] = useState('1'),
    [zoom, setZoom] = useState(null);
  const [pdf, setPDF] = useState(null),
    [pdfLoading, setPDFLoading] = useState(true),
    [pdfError, setPDFError] = useState(''),
    [reloadPDF, setReloadPDF] = useState(0),
    [renderBusy, setRenderBusy] = useState(false),
    [renderError, setRenderError] = useState(''),
    [renderedPage, setRenderedPage] = useState(null);
  const [pageText, setPageText] = useState(null),
    [textBusy, setTextBusy] = useState(false),
    [textError, setTextError] = useState(''),
    [reloadText, setReloadText] = useState(0);
  const [selection, setSelection] = useState(selectionEmpty),
    [comment, setComment] = useState(''),
    [pendingHit, setPendingHit] = useState(null);
  const [candidate, setCandidate] = useState(null),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [used, setUsed] = useState(false),
    [uncertain, setUncertain] = useState(null);
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState(initialSearch),
    [width, setWidth] = useState(600);
  const canvas = useRef(null),
    stage = useRef(null),
    textArea = useRef(null),
    candidateArea = useRef(null),
    mounted = useRef(false),
    searchRun = useRef(null),
    mutation = useRef(null);
  const actions = useRef({ api, onChange, onClose, onBusyChange });
  actions.current = { api, onChange, onClose, onBusyChange };
  const requests = useRef(createDocumentReaderRequests());
  const contextChanged = candidate && (task.knowledgeContext?.digest ?? null) !== (candidate.contextDigest ?? null);
  const selectedText = pageText?.text.slice(selection.start, selection.end) || '';
  const readPage = async (number, signal) =>
    verifiedDocumentPage(await actions.current.api(`${binding.base}/page/${number}`, { signal }), {
      page: number,
      pages: binding.pages,
      sourceHash: binding.sourceHash
    });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      searchRun.current?.abort();
      mutation.current?.abort();
      actions.current.onBusyChange?.(false);
    };
  }, []);
  useEffect(() => {
    actions.current.onBusyChange?.(Boolean(busy || uncertain));
  }, [busy, uncertain]);
  useEffect(() => {
    if (!stage.current) return;
    const update = () => setWidth(Math.max(100, stage.current.clientWidth - 32));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let current = true,
      loading = null;
    setPDF(null);
    setPDFLoading(true);
    setPDFError('');
    (async () => {
      const module = await import('pdfjs-dist/build/pdf.mjs');
      if (!current) return;
      module.GlobalWorkerOptions.workerSrc = pdfWorkerURL;
      loading = module.getDocument({
        url: binding.contentURL,
        withCredentials: true,
        enableXfa: false,
        useWasm: false,
        isEvalSupported: false,
        disableAutoFetch: true,
        disableRange: true,
        disableStream: true,
        cMapUrl: '/pdfjs-static/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/pdfjs-static/standard_fonts/',
        verbosity: 0
      });
      const document = await loading.promise;
      if (!current) return;
      if (document.numPages !== binding.pages) throw new Error('PDF 页数与已核验版本不一致，请重新打开附件。');
      setPDF(document);
    })()
      .catch(failure => {
        if (current && !cancelled(failure))
          setPDFError(
            failure.name === 'PasswordException' ? 'PDF 已加密，请在原应用解锁后重新打开。' : `PDF 画面加载失败：${message(failure)}`
          );
      })
      .finally(() => {
        if (current) setPDFLoading(false);
      });
    return () => {
      current = false;
      if (loading) loading.destroy().catch(() => {});
    };
  }, [binding.scope, reloadPDF]);
  useEffect(() => {
    let current = true,
      rendering = null,
      pdfPage = null;
    setRenderError('');
    if (!pdf) return;
    setRenderBusy(true);
    setRenderedPage(null);
    (async () => {
      pdfPage = await pdf.getPage(page);
      if (!current || !canvas.current) return;
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: zoom == null ? Math.min(2, width / baseViewport.width) : zoom / 100 });
      const size = documentCanvasSize(viewport, window.devicePixelRatio || 1),
        target = canvas.current;
      target.width = size.width;
      target.height = size.height;
      target.style.width = `${size.cssWidth}px`;
      target.style.height = `${size.cssHeight}px`;
      rendering = pdfPage.render({
        canvasContext: target.getContext('2d', { alpha: false }),
        viewport,
        transform: [size.outputScale, 0, 0, size.outputScale, 0, 0],
        background: '#ffffff',
        annotationMode: 0
      });
      await rendering.promise;
      if (current) setRenderedPage(page);
    })()
      .catch(failure => {
        if (current && !cancelled(failure)) setRenderError(message(failure));
      })
      .finally(() => {
        if (current) setRenderBusy(false);
      });
    return () => {
      current = false;
      rendering?.cancel(); /* The loading task owns page/worker cleanup. */
    };
  }, [pdf, page, zoom, width]);
  useEffect(() => {
    const controller = new AbortController();
    setPageText(null);
    setTextBusy(true);
    setTextError('');
    setSelection(selectionEmpty);
    readPage(page, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setPageText(value);
      })
      .catch(failure => {
        if (!controller.signal.aborted) setTextError(message(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setTextBusy(false);
      });
    return () => controller.abort();
  }, [page, reloadText, binding.scope]);
  useEffect(() => {
    if (!pageText || !pendingHit || pageText.page !== pendingHit.page || !textArea.current) return;
    if (pageText.textHash !== pendingHit.textHash) {
      setError('搜索结果所在页的文字版本已经变化，请重新搜索。');
      setPendingHit(null);
      return;
    }
    const input = textArea.current;
    input.focus();
    input.setSelectionRange(pendingHit.startOffset, pendingHit.endOffset);
    input.scrollTop = Math.max(0, pageText.text.slice(0, pendingHit.startOffset).split('\n').length * 22 - input.clientHeight / 2);
    setSelection({ start: pendingHit.startOffset, end: pendingHit.endOffset });
    setPendingHit(null);
  }, [pageText, pendingHit]);
  useEffect(() => {
    if (!candidate) return;
    const frame = requestAnimationFrame(() => candidateArea.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [candidate?.candidateId]);

  const changePage = (next, hit = null) => {
    if (!Number.isSafeInteger(next) || next < 1 || next > binding.pages) return;
    setPendingHit(hit);
    setPage(next);
    setPageInput(String(next));
    setSelection(selectionEmpty);
    setError('');
  };
  const jump = event => {
    event.preventDefault();
    const next = Number(pageInput);
    if (Number.isSafeInteger(next) && next >= 1 && next <= binding.pages) {
      setPendingHit(null);
      changePage(next);
    } else {
      setPageInput(String(page));
      setError(`请输入 1 至 ${binding.pages} 之间的 PDF 页码。`);
    }
  };
  const cancelSearch = () => {
    searchRun.current?.abort();
    setSearch(value => ({ ...value, busy: false, cancelled: true }));
  };
  const changeQuery = value => {
    searchRun.current?.abort();
    searchRun.current = null;
    setQuery(value);
    setSearch(initialSearch);
  };
  const scan = async continuation => {
    if (!query.trim() || query.length > 200 || search.busy) return;
    searchRun.current?.abort();
    const controller = new AbortController();
    searchRun.current = controller;
    const start = continuation && search.query === query ? search.nextPage : 1,
      batch = documentSearchBatch(start, binding.pages);
    if (!batch.length) return;
    const previousChecked = continuation && search.query === query ? search.checked : 0;
    let completed = 0,
      last = start - 1,
      hits = [],
      limited = false;
    setSearch({
      query,
      nextPage: start,
      checked: previousChecked,
      first: start,
      last,
      hits,
      busy: true,
      limited,
      error: '',
      cancelled: false
    });
    try {
      for (const number of batch) {
        if (controller.signal.aborted) break;
        const value = await readPage(number, controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        const found = findDocumentMatches(value.text, query, MAX_HITS);
        limited = limited || found.more || hits.length + found.matches.length > MAX_HITS;
        hits = [
          ...hits,
          ...found.matches.map(match => ({ ...match, page: number, pageLabel: value.pageLabel, textHash: value.textHash }))
        ].slice(0, MAX_HITS);
        completed++;
        last = number;
        setSearch({
          query,
          nextPage: number + 1,
          checked: previousChecked + completed,
          first: start,
          last,
          hits,
          busy: true,
          limited,
          error: '',
          cancelled: false
        });
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setSearch(value => ({ ...value, error: message(failure) }));
    } finally {
      if (mounted.current && searchRun.current === controller)
        setSearch(value => ({ ...value, busy: false, cancelled: controller.signal.aborted, nextPage: last + 1 }));
    }
  };
  const locateHit = hit => changePage(hit.page, hit);
  const prepare = async () => {
    if (busy || mutation.current || inputBusy || uncertain || !selectedText.trim() || stopped(task) || pageText?.page !== page) return;
    const controller = new AbortController();
    mutation.current = controller;
    actions.current.onBusyChange?.(true);
    setBusy('prepare');
    setError('');
    setNotice('');
    setCandidate(null);
    setUsed(false);
    const body = {
      page,
      startOffset: selection.start,
      endOffset: selection.end,
      expectedPageTextHash: pageText.textHash,
      expectedSourceHash: binding.sourceHash,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      confirmed: true
    };
    try {
      const value = await actions.current.api(`${binding.base}/excerpt`, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!mounted.current || controller.signal.aborted) return;
      if (!value.candidateId || !HASH.test(value.hash || '') || typeof value.text !== 'string' || !Object.hasOwn(value, 'contextDigest'))
        throw new Error('引用预览未返回完整的版本证据，请重新准备。');
      setCandidate({ ...value, page, pageLabel: pageText.pageLabel, selectedText, sourceHash: binding.sourceHash });
      setNotice('引用已准备，请核对下面的实际预览；尚未加入任务输入。');
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(message(failure));
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (mounted.current && !controller.signal.aborted) setBusy('');
    }
  };
  const useExcerpt = async () => {
    if (busy || mutation.current || inputBusy || used || stopped(task) || !candidate || (contextChanged && !uncertain)) return;
    // A lost response must retry the exact original body, even when an SSE
    // update has already changed the current context digest.
    const body = uncertain?.body || {
      candidateId: candidate.candidateId,
      expectedPreviewHash: candidate.hash,
      expectedContextDigest: candidate.contextDigest,
      confirmed: true
    };
    const requestId = uncertain?.requestId || requests.current.get(binding.scope, body);
    const controller = new AbortController();
    mutation.current = controller;
    actions.current.onBusyChange?.(true);
    setBusy('use');
    setError('');
    setNotice('');
    try {
      verifiedDocumentUseReceipt(
        await actions.current.api(`/api/tasks/${encodeURIComponent(task.id)}/tools/use`, {
          method: 'POST',
          body: JSON.stringify({ ...body, requestId }),
          signal: controller.signal
        }),
        task,
        body
      );
      requests.current.clear(binding.scope, body);
      if (!mounted.current || controller.signal.aborted) return;
      setUncertain(null);
      setUsed(true);
      setNotice('这段带页码的引用已加入本任务输入，原有材料保留。没有写回 Zotero、调用模型或启动任务。');
      actions.current.onChange?.();
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return;
      if (uncertainToolUseError(failure)) {
        setUncertain({ body, requestId });
        setError('连接或服务响应中断，引用可能已加入。请核对同一个请求；核对完成前保留当前工作区，不会另建第二次操作。');
      } else setError(message(failure));
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (mounted.current && !controller.signal.aborted) setBusy('');
    }
  };
  const state = {
    page,
    pageInput,
    zoom,
    pdfLoading,
    pdfError,
    renderBusy,
    renderError,
    renderedPage,
    textBusy,
    textError,
    pageText,
    selection,
    selectedText,
    comment,
    candidate,
    busy,
    inputBusy,
    error,
    notice,
    used,
    uncertain,
    query,
    search,
    contextChanged
  };
  const handlers = {
    onClose: () => actions.current.onClose?.(),
    changePage,
    setPageInput,
    jump,
    setZoom,
    setSelection,
    setComment,
    setQuery: changeQuery,
    scan,
    cancelSearch,
    locateHit,
    prepare,
    useExcerpt,
    reloadPDF: () => setReloadPDF(value => value + 1),
    reloadText: () => setReloadText(value => value + 1)
  };
  return <TaskDocumentReaderView {...{ task, reader, binding, state, handlers, canvas, stage, textArea, candidateArea }} />;
}

export function TaskDocumentReaderView({ task, reader, binding, state, handlers, canvas, stage, textArea, candidateArea }) {
  const {
    page,
    pageInput,
    zoom,
    pdfLoading,
    pdfError,
    renderBusy,
    renderError,
    renderedPage,
    textBusy,
    textError,
    pageText,
    selection,
    selectedText,
    comment,
    candidate,
    busy,
    inputBusy,
    error,
    notice,
    used,
    uncertain,
    query,
    search,
    contextChanged
  } = state;
  const locked = Boolean(busy),
    ended = stopped(task),
    pageReady = pageText?.page === page;
  return (
    <section className="task-document-reader" aria-label="本任务 PDF 阅读区">
      <header className="task-document-heading">
        <div>
          <span className="eyebrow">Zotero · 本任务文献</span>
          <h2>{reader.title || reader.document.title || 'PDF 文档'}</h2>
          <p>
            {binding.pages} 页 · {(reader.document.bytes / 1024 / 1024).toFixed(2)} MiB · 在 Hub 内阅读和准备引用
          </p>
        </div>
        <button type="button" disabled={locked || Boolean(uncertain)} onClick={handlers.onClose}>
          <ArrowLeft size={15} />
          返回工作流
        </button>
      </header>
      <div className="task-document-toolbar">
        <div className="task-document-pager" role="group" aria-label="PDF 翻页">
          <button type="button" aria-label="上一页" disabled={page <= 1} onClick={() => handlers.changePage(page - 1)}>
            <ChevronLeft size={17} />
          </button>
          <form onSubmit={handlers.jump}>
            <label>
              PDF 第{' '}
              <input
                type="number"
                min="1"
                max={binding.pages}
                aria-label="跳转到 PDF 页码"
                value={pageInput}
                onChange={event => handlers.setPageInput(event.target.value)}
              />{' '}
              / {binding.pages} 页
            </label>
            <button type="submit">跳转</button>
          </form>
          <button type="button" aria-label="下一页" disabled={page >= binding.pages} onClick={() => handlers.changePage(page + 1)}>
            <ChevronRight size={17} />
          </button>
        </div>
        <div role="group" aria-label="PDF 缩放">
          <button type="button" aria-label="缩小 PDF" onClick={() => handlers.setZoom(Math.max(25, (zoom ?? 100) - 25))}>
            <Minus size={16} />
          </button>
          <span>{zoom == null ? '适应宽度' : `${zoom}%`}</span>
          <button type="button" aria-label="放大 PDF" onClick={() => handlers.setZoom(Math.min(300, (zoom ?? 100) + 25))}>
            <Plus size={16} />
          </button>
          <button type="button" onClick={() => handlers.setZoom(null)}>
            适应宽度
          </button>
        </div>
      </div>
      <section className="task-document-search" aria-label="搜索当前 PDF">
        <form
          onSubmit={event => {
            event.preventDefault();
            handlers.scan(false);
          }}
        >
          <label>
            <Search size={16} />
            <input
              aria-label="在此 PDF 中搜索文字"
              placeholder="搜索当前 PDF 的文字"
              maxLength="200"
              value={query}
              onChange={event => handlers.setQuery(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!query.trim() || search.busy}>
            从第 1 页查找
          </button>
          {search.busy && (
            <button type="button" onClick={handlers.cancelSearch}>
              <Square size={13} />
              停止搜索
            </button>
          )}
          {!search.busy && search.query === query && search.nextPage > 1 && search.nextPage <= binding.pages && (
            <button type="button" onClick={() => handlers.scan(true)}>
              继续查找第 {search.nextPage}–{Math.min(binding.pages, search.nextPage + MAX_BATCH - 1)} 页
            </button>
          )}
        </form>
        <p role="status">
          {search.busy
            ? `正在读取第 ${search.nextPage} 页；累计已查 ${search.checked} / ${binding.pages} 页。`
            : search.cancelled
              ? `搜索已停止，保留已读 ${search.checked} 页的结果；可从第 ${search.nextPage} 页继续。`
              : search.checked
                ? `累计已查 ${search.checked} / ${binding.pages} 页；本批第 ${search.first}–${search.last} 页，${search.hits.length} 处结果${search.limited ? '（本批只列前 200 处）' : ''}。`
                : '点击后逐页读取当前附件，每批最多 50 页，可停止或继续；不会扫描文献库。'}
        </p>
        {search.error && (
          <p role="alert" className="task-document-error">
            {search.error}
          </p>
        )}
        {search.hits.length > 0 && (
          <ol className="task-document-search-results" aria-label="本批搜索结果">
            {search.hits.map(hit => (
              <li key={`${hit.page}:${hit.startOffset}`}>
                <button type="button" onClick={() => handlers.locateHit(hit)}>
                  <span>
                    PDF 第 {hit.page} 页{hit.pageLabel !== String(hit.page) ? ` · 标记 ${hit.pageLabel}` : ''}
                  </span>
                  <span>{hit.excerpt}</span>
                  <ZoomIn size={14} />
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
      <div className="task-document-reading">
        <div className="task-document-page-column">
          <div className="task-document-stage" ref={stage} aria-busy={pdfLoading || renderBusy}>
            <canvas
              ref={canvas}
              aria-label={`PDF 第 ${page} 页画面`}
              role="img"
              hidden={renderedPage !== page || pdfLoading || renderBusy || Boolean(pdfError) || Boolean(renderError)}
            />
            {(pdfLoading || renderBusy) && (
              <p className="task-document-loading" role="status">
                <LoaderCircle size={18} className="spin" />
                {pdfLoading ? '正在加载本任务 PDF…' : `正在绘制第 ${page} 页…`}
              </p>
            )}
            {(pdfError || renderError) && (
              <div className="task-document-load-error" role="alert">
                <p>{pdfError || renderError}</p>
                <button type="button" onClick={handlers.reloadPDF}>
                  重新读取 PDF 画面
                </button>
              </div>
            )}
          </div>
          <p className="task-document-local-note">只绘制实际 PDF 页面；不运行文档脚本、表单或外部链接。文字选择与页码引用在右侧完成。</p>
        </div>
        <section className="task-document-text-column" aria-label="本页文字与引用">
          <header>
            <h3>
              <FileText size={17} />
              PDF 第 {page} 页 · 实际提取文字
            </h3>
            {pageReady && <small>原文页标记：{pageText.pageLabel}</small>}
          </header>
          <p>选中下面的原文，添加可选备注，再准备并核对引用。</p>
          {textBusy && (
            <p role="status">
              <LoaderCircle size={15} className="spin" />
              正在核对本页正文…
            </p>
          )}
          {textError && (
            <div role="alert" className="task-document-error">
              <p>{textError}</p>
              <button type="button" onClick={handlers.reloadText}>
                重读本页文字
              </button>
            </div>
          )}
          {pageReady && (
            <>
              <label className="task-document-label" htmlFor={`pdf-page-text-${reader.readerId}`}>
                选择本页原文
              </label>
              <textarea
                id={`pdf-page-text-${reader.readerId}`}
                ref={textArea}
                aria-label="选择本页实际提取文字"
                readOnly
                value={pageText.text}
                spellCheck={false}
                onSelect={event =>
                  handlers.setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })
                }
              />
              {!pageText.text.trim() && (
                <p className="task-document-empty">本页未提取到文字，可能是扫描图片。OCR 尚未接入；当前可看画面，不能引用猜测正文。</p>
              )}
              <div className="task-document-selection" role="status">
                {selectedText ? `已选择 ${selection.end - selection.start} 个文本位置 · 第 ${page} 页` : '尚未选中文字'}
              </div>
            </>
          )}
          <label className="task-document-comment">
            我的备注（可选，不修改 Zotero）
            <textarea
              aria-label="这段引用的备注"
              maxLength="2000"
              value={comment}
              disabled={locked || Boolean(uncertain)}
              onChange={event => handlers.setComment(event.target.value)}
              placeholder="例如：用于方案比较的依据"
              rows="2"
            />
          </label>
          <button
            type="button"
            className="primary task-document-prepare"
            disabled={locked || inputBusy || Boolean(uncertain) || ended || !pageReady || !selectedText.trim()}
            onClick={handlers.prepare}
          >
            {busy === 'prepare' ? <LoaderCircle size={15} className="spin" /> : <FileText size={15} />}准备这段带页码的引用
          </button>
          {ended && <p className="task-document-note">当前任务只读。可继续阅读，不会更改任务输入。</p>}
          {candidate && (
            <section className="task-document-excerpt" ref={candidateArea} aria-label="待加入任务的引用预览">
              <header>
                <h3>核对引用 · PDF 第 {candidate.page} 页</h3>
                <small>原文标记 {candidate.pageLabel}</small>
              </header>
              <pre>{candidate.text}</pre>
              {contextChanged && !used && (
                <p className="task-document-note">
                  任务输入已经变化。{uncertain ? '可继续核对上次选用请求。' : '请重新准备引用后再加入。'}
                </p>
              )}
              <button
                type="button"
                className="primary"
                disabled={locked || inputBusy || used || ended || (contextChanged && !uncertain)}
                onClick={handlers.useExcerpt}
              >
                {busy === 'use' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
                {used ? '已加入本任务输入' : uncertain ? '核对上次加入结果' : '确认加入本任务输入'}
              </button>
              <p>仅加入这段核验后的引用；保留已有输入，不启动模型。</p>
            </section>
          )}
          {error && (
            <p className="task-document-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="task-document-notice" role="status">
              {notice}
            </p>
          )}
        </section>
      </div>
      <details className="task-document-proof">
        <summary>文档来源与版本</summary>
        <p>
          Zotero 本机附件 · {binding.pages} 个 PDF 物理页 · {reader.document.bytes.toLocaleString('zh-CN')} 字节
        </p>
        <p>
          文件 SHA-256：<code>{binding.sourceHash}</code>
        </p>
        {pageReady && (
          <p>
            当前页文字 SHA-256：<code>{pageText.textHash}</code>
          </p>
        )}
        <p>阅读和引用不会写回 Zotero。引用附带实际物理页码、原文标记、文本位置与来源版本；没有自动 OCR 或模型补全。</p>
      </details>
    </section>
  );
}
