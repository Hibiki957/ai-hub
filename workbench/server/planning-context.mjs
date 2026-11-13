import { fail } from './store.mjs';

export const PLANNING_QUALITY_MAX_BYTES = 8192;
const policy = 'quality-first-within-authorized-budget';
const statuses = new Set([
  'blocked',
  'needs_confirmation',
  'manual_choice_unavailable',
  'manual_locked',
  'recommendation',
  'insufficient_evidence'
]);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
function identifier(value, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\x00-\x1f\x7f]/.test(value))
    throw fail('规划摘要的组合或人工约束身份无效；已停止而非截断约束。', 409, 'planning_context_identity_invalid');
  return value;
}
const labels = {
  stopped: '人工暂停或任务已结束',
  manualAssignment: '不符合人工指定组合',
  capability: '缺少要求能力',
  permission: '缺少已授予权限',
  identity: '连接或版本证据不完整',
  availability: '缺少当前真实可用证据',
  budget: '额度、费用或本次授权需核对',
  other: '宿主其他排除条件'
};
function reasonCode(value) {
  if (typeof value !== 'string') return 'other';
  if (/暂停|已经结束|任务已结束|人工决定/.test(value)) return 'stopped';
  if (/锁定|指定组合|人工.*组合/.test(value)) return 'manualAssignment';
  if (/权限|permission/i.test(value)) return 'permission';
  if (/缺少.*能力|要求.*能力|capability/i.test(value)) return 'capability';
  if (/预算|额度|费用|报价|币种|金额|token|调用次数|输出上限/i.test(value)) return 'budget';
  if (/身份|版本/.test(value)) return 'identity';
  if (/可用|验证|目录|握手|型号|执行器/.test(value)) return 'availability';
  return 'other';
}
function manualConstraint(lock) {
  if (lock == null) return null;
  if (
    typeof lock !== 'object' ||
    Array.isArray(lock) ||
    Object.keys(lock).some(key => !['modelId', 'harnessId', 'providerId'].includes(key))
  )
    throw fail('人工组合约束结构不明确，不能压缩后继续规划。', 409, 'planning_context_manual_invalid');
  return {
    model: identifier(lock.modelId),
    harness: identifier(lock.harnessId),
    provider: identifier(lock.providerId),
    mustPreserve: true,
    fallbackAllowed: false
  };
}
const isMatch = (route, manual) =>
  !manual ||
  (route.modelId === manual.model && route.harnessId === manual.harness && (!manual.provider || route.providerId === manual.provider));
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Compact advisory evidence only. models is an explicit HOST allowlist already
 * restricted to configured daily/strong/manual models, not the provider catalog.
 * No internal candidate IDs, fingerprints, paths, project text or raw reasons
 * enter the prompt. Host execution checks and action approvals remain separate.
 */
export function compactQualityAdvice(advice, { models = [], harnesses = [], limit = 8 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw fail('规划质量候选上限须为1到8。', 400, 'planning_context_limit_invalid');
  const allowedModels = new Map(
    (Array.isArray(models) ? models : []).filter(value => value?.enabled === true).map(value => [identifier(value.id, true), value])
  );
  const allowedHarnesses = new Set(
    (Array.isArray(harnesses) ? harnesses : [])
      .filter(value => value?.enabled === true && value.verified === true)
      .map(value => identifier(value.id, true))
  );
  const manual = manualConstraint(advice?.manualLock),
    minimumSamples =
      Number.isInteger(advice?.minimumSamples) && advice.minimumSamples >= 3 && advice.minimumSamples <= 100 ? advice.minimumSamples : 5;
  const result = {
    policy,
    status: advice && statuses.has(advice.status) ? advice.status : 'unavailable',
    onlyAdvisory: true,
    createsAuthorization: false,
    startsExecution: false,
    requiresHostActionApproval: true,
    manualConstraint: manual,
    minimumSamples,
    evidenceScope: '仅同类任务、同难度、同连接与版本的独立任务验收；不合并跨组合证据。',
    hardConstraints:
      '人工指定、暂停、能力、权限、真实连接可用性和任务剩余额度由宿主严格检查。本摘要不授予预算、权限或执行许可，不得重用耗尽批准。',
    money: 'unknown-unless-host-verified; unknown-is-not-zero',
    recommended: null,
    candidates: [],
    excludedCounts: {},
    exclusionSummary: []
  };
  const groups = [
    ['ranked', advice?.ranked],
    ['unranked', advice?.unranked],
    ['needs_confirmation', advice?.needsConfirmation],
    ['excluded', advice?.excluded]
  ];
  const eligible = [],
    reasonCounts = {},
    seenIds = new Set();
  let inPool = 0,
    sufficient = 0;
  const add = key => {
    result.excludedCounts[key] = (result.excludedCounts[key] || 0) + 1;
  };
  for (const [state, entries] of groups)
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.id === 'string') {
        if (seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
      }
      const route = entry.route || {},
        configured = allowedModels.get(route.modelId);
      if (!configured) {
        add('outsideConfiguredModels');
        continue;
      }
      if (configured.providerId && route.providerId !== configured.providerId) {
        add('outsideConfiguredProvider');
        continue;
      }
      if (!allowedHarnesses.has(route.harnessId)) {
        add('unverifiedOrDisabledHarness');
        continue;
      }
      if (!isMatch(route, manual)) {
        add('manualAssignment');
        continue;
      }
      inPool++;
      if (state === 'excluded' || state === 'needs_confirmation') {
        add(state === 'excluded' ? 'hostExcluded' : 'needsConfirmation');
        for (const code of new Set((Array.isArray(entry.reasons) ? entry.reasons : []).map(reasonCode)))
          reasonCounts[code] = (reasonCounts[code] || 0) + 1;
      }
      const stats = entry.statistics || {},
        sampleCount = count(stats.sampleCount),
        accepted = count(stats.firstPassAccepted),
        lower = stats.confidence?.lower;
      const mature =
        stats.sufficient === true &&
        sampleCount !== null &&
        sampleCount >= minimumSamples &&
        accepted !== null &&
        accepted <= sampleCount &&
        finite(lower) &&
        lower <= 1;
      if (!mature) {
        add('insufficientComparableSamples');
        continue;
      }
      sufficient++;
      const model = identifier(route.modelId, true),
        harness = identifier(route.harnessId, true),
        monetaryCostKnown =
          entry.budget?.monetaryCostKnown === true && finite(entry.budget.amount) && typeof entry.budget.currency === 'string';
      eligible.push({
        source: entry,
        value: {
          model,
          harness,
          state,
          sampleCount,
          firstPassAccepted: accepted,
          firstPassRate: accepted / sampleCount,
          wilsonLower: lower,
          reworksPerTask: finite(stats.reworksPerTask) ? stats.reworksPerTask : null,
          money: monetaryCostKnown ? 'verified-upper-bound' : 'unknown-not-zero',
          budget:
            entry.budget?.status === 'within_authorized_budget'
              ? 'within-specific-host-authorization'
              : 'requires-specific-host-confirmation'
        }
      });
    }
  result.exclusionSummary = Object.keys(reasonCounts)
    .sort()
    .map(code => ({ reason: labels[code], count: reasonCounts[code] }));
  result.evidence = { planningPoolCandidates: inPool, sufficientCandidates: sufficient };
  if (!sufficient) {
    result.summary = `当前规划池没有达到 ${minimumSamples} 个同类独立任务验收样本的组合；不作质量高低排序。目录、握手、开发验证与自评不能补成成功样本。`;
  } else {
    const pairs = new Map();
    for (const candidate of eligible) {
      const key = JSON.stringify([candidate.value.model, candidate.value.harness]);
      const entries = pairs.get(key) || [];
      entries.push(candidate);
      pairs.set(key, entries);
    }
    const comparable = eligible.filter(candidate => {
      const pair = pairs.get(JSON.stringify([candidate.value.model, candidate.value.harness]));
      // Connection/version identities are intentionally absent from this prompt.
      // Do not collapse two indistinguishable routes into one invented score.
      if (pair.length > 1) {
        add('ambiguousConnectionOrVersion');
        return false;
      }
      return true;
    });
    const recommended = comparable.find(
      candidate =>
        candidate.source.id === advice?.recommendedId &&
        ['ranked', 'unranked'].includes(candidate.value.state) &&
        candidate.source.budget?.status === 'within_authorized_budget'
    );
    const ordered = recommended ? [recommended, ...comparable.filter(candidate => candidate !== recommended)] : comparable;
    result.candidates = ordered.slice(0, limit).map(candidate => candidate.value);
    result.recommended = recommended
      ? { model: recommended.value.model, harness: recommended.value.harness, requiresHostActionApproval: true }
      : null;
    result.omittedCandidates = Math.max(0, comparable.length - result.candidates.length);
    result.summary = '质量依据只作规划建议；候选顺序保留宿主建议，样本不足不比较，执行与费用仍须宿主逐项核验及本次授权。';
  }
  // Shrink by whole records only. Hard constraints are never shortened or
  // dropped to make room for statistics; malformed oversize context fails closed.
  while (bytes(result) > PLANNING_QUALITY_MAX_BYTES && result.candidates.length) {
    const removed = result.candidates.pop();
    result.omittedCandidates = (result.omittedCandidates || 0) + 1;
    if (result.recommended?.model === removed.model && result.recommended?.harness === removed.harness) result.recommended = null;
  }
  if (bytes(result) > PLANNING_QUALITY_MAX_BYTES)
    throw fail('规划质量摘要超过安全字节上限，人工硬约束未被截断；请先核对约束。', 409, 'planning_context_too_large');
  if (advice?.recommendedId && !result.recommended && ['recommendation', 'manual_locked'].includes(result.status))
    result.status = 'recommendation_not_in_compact_scope';
  // The state change above adds a bounded string; retain a final exact assertion.
  if (bytes(result) > PLANNING_QUALITY_MAX_BYTES) throw fail('规划质量摘要超过安全字节上限。', 409, 'planning_context_too_large');
  return result;
}
