import React, { useEffect, useMemo } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, useNodesState } from '@xyflow/react';
import {
  ArrowRight,
  ArrowLeftRight,
  Circle,
  Clock3,
  Play,
  CircleAlert,
  CheckCheck,
  Check,
  Square,
  FolderOpen,
  ChevronRight,
  MessageSquare,
  FileText,
  Workflow
} from 'lucide-react';
import '@xyflow/react/dist/style.css';
import { money, asText } from './shared.js';
import { crossHarnessEdges, dependenciesForStep, handoffCompleteness, phaseForTask, workflowActionForTask } from './workflow.mjs';
const STATUS = {
  queued: { label: '待安排', icon: Clock3 },
  running: { label: '进行中', icon: Play },
  blocked: { label: '需处理', icon: CircleAlert },
  review: { label: '待验收', icon: CheckCheck },
  done: { label: '已完成', icon: Check },
  failed: { label: '失败', icon: CircleAlert },
  cancelled: { label: '已关停', icon: Square },
  archived: { label: '已归档', icon: FolderOpen }
};
function Status({ value }) {
  const item = STATUS[value] || { label: value, icon: Circle };
  const Icon = item.icon;
  return (
    <span className={`status status-${value}`}>
      <Icon size={13} aria-hidden="true" />
      {item.label}
    </span>
  );
}

function WorkflowNode({ data, selected }) {
  const { step, modelName, harnessName, inputTitles, inputSources, downstreamCount, handoff } = data;
  return (
    <div className={`workflow-node ${selected ? 'node-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-kicker">
        <span>{step.kind || '执行步骤'}</span>
        <Status value={step.status} />
      </div>
      <h3>{step.title || step.name || step.id}</h3>
      {(step.prompt || step.description) && <p>{step.prompt || step.description}</p>}
      <div className="node-inputs">
        <span>输入</span>
        <div>
          <p>{inputTitles.length ? inputTitles.join('、') : '无前置步骤依赖'}</p>
          {inputSources.length > 0 && (
            <small className={inputSources.some(item => item.crossTool) ? 'cross-tool-input' : ''}>
              {inputSources.some(item => item.crossTool) && <ArrowLeftRight size={11} />}来自{' '}
              {inputSources.map(item => item.label).join('、')}
            </small>
          )}
        </div>
      </div>
      <div className="node-assignment">
        <span>{modelName(step.assignment?.modelId)}</span>
        <span>×</span>
        <span>{harnessName(step.assignment?.harnessId)}</span>
      </div>
      {step.error && (
        <div className="node-error">
          <CircleAlert size={12} />
          {asText(step.error)}
        </div>
      )}
      <div className="node-bottom">
        <span>
          {step.artifacts?.length ? `${step.artifacts.length} 份产物` : '产物尚未回传'}
          {step.status === 'done' && (
            <small className={handoff.complete ? 'handoff-ready' : 'handoff-incomplete'}>
              交接 {handoff.present}/{handoff.total}
            </small>
          )}
        </span>
        <span>
          {downstreamCount ? `${downstreamCount} 项下游` : '查看记录'}
          <ChevronRight size={13} />
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { workflow: WorkflowNode };
export default function TaskCanvas({ task, state, onBack, onOpenDetail, onOpenResources, projectName, modelName, harnessName }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const phase = phaseForTask(task, state.settings, state.approvals);
  const action = workflowActionForTask(task, state.settings, state.approvals);
  const steps = task.steps || [];
  const counts = Object.fromEntries(
    ['running', 'blocked', 'queued', 'done'].map(status => [status, steps.filter(step => step.status === status).length])
  );
  const crossToolEdges = useMemo(() => crossHarnessEdges(task), [task.steps]);
  const crossToolByTarget = useMemo(() => new Map(crossToolEdges.map(edge => [edge.targetId, edge])), [crossToolEdges]);
  const edges = useMemo(() => {
    const ids = new Set((task.steps || []).map(step => step.id));
    return (task.steps || []).flatMap(step =>
      dependenciesForStep(step)
        .filter(id => ids.has(id))
        .flatMap(id => {
          const source = task.steps.find(item => item.id === id),
            crossTool =
              !!source?.assignment?.harnessId && !!step.assignment?.harnessId && source.assignment.harnessId !== step.assignment.harnessId;
          return [
            {
              id: `${id}-${step.id}`,
              source: id,
              target: step.id,
              type: 'smoothstep',
              animated: step.status === 'running',
              ...(crossTool
                ? {
                    label: '跨工具交接',
                    labelStyle: { fill: '#3f6753', fontSize: 9, fontWeight: 600 },
                    labelBgStyle: { fill: '#f4f8f5', fillOpacity: 0.96 },
                    labelBgPadding: [4, 2],
                    labelBgBorderRadius: 3
                  }
                : {}),
              style: { stroke: crossTool ? '#3f7d63' : '#6e9983', strokeWidth: crossTool ? 2 : 1.4 },
              markerEnd: { type: 'arrowclosed', color: crossTool ? '#3f7d63' : '#6e9983', width: 16, height: 16 }
            }
          ];
        })
    );
  }, [task.steps]);
  useEffect(() => {
    let positions = {};
    try {
      positions = JSON.parse(localStorage.getItem(`aihub.canvas.positions.${task.id}`) || '{}');
    } catch {
      /* Coordinates are optional. */
    }
    const steps = task.steps || [];
    const depth = {};
    const depthOf = (id, visiting = new Set()) => {
      if (depth[id] != null) return depth[id];
      if (visiting.has(id)) return 0;
      const step = steps.find(item => item.id === id);
      const next = new Set([...visiting, id]);
      const parents = dependenciesForStep(step).filter(parent => steps.some(item => item.id === parent));
      return (depth[id] = parents.length ? Math.min(16, Math.max(...parents.map(parent => depthOf(parent, next))) + 1) : 0);
    };
    const lanes = {};
    setNodes(current =>
      steps.map(step => {
        const column = depthOf(step.id);
        const lane = lanes[column] || 0;
        lanes[column] = lane + 1;
        const existing = current.find(node => node.id === step.id);
        return {
          id: step.id,
          type: 'workflow',
          position: existing?.position || positions[step.id] || { x: 80 + column * 330, y: 70 + lane * 245 },
          data: {
            step,
            modelName,
            harnessName,
            inputTitles: dependenciesForStep(step).map(id => steps.find(item => item.id === id)?.title || id),
            inputSources: dependenciesForStep(step)
              .map(id => {
                const source = steps.find(item => item.id === id);
                return source
                  ? {
                      label: `${harnessName(source.assignment?.harnessId)} · ${source.title || source.name || source.id}`,
                      crossTool:
                        !!source.assignment?.harnessId &&
                        !!step.assignment?.harnessId &&
                        source.assignment.harnessId !== step.assignment.harnessId
                    }
                  : null;
              })
              .filter(Boolean),
            crossToolInput: crossToolByTarget.has(step.id),
            handoff: handoffCompleteness(step),
            downstreamCount: steps.filter(item => dependenciesForStep(item).includes(step.id)).length
          },
          ariaLabel: `${step.title || step.id}，${STATUS[step.status]?.label || step.status}`
        };
      })
    );
  }, [task.id, task.revision, state.pool]);
  const savePositions = (_, node) => {
    const positions = Object.fromEntries(nodes.map(item => [item.id, item.id === node.id ? node.position : item.position]));
    try {
      localStorage.setItem(`aihub.canvas.positions.${task.id}`, JSON.stringify(positions));
    } catch {
      /* Browser storage can be disabled. */
    }
  };
  return (
    <section className="task-canvas-workspace">
      <div className="canvas-heading">
        <div className="canvas-breadcrumb">
          <button onClick={onBack}>
            <ChevronRight size={14} className="back-chevron" />
            工作大盘
          </button>
          <span>/</span>
          <span>{projectName(task.projectId)}</span>
        </div>
        <div className="canvas-title-row">
          <div>
            <h1>{task.title || task.goal}</h1>
            <div className="canvas-task-meta">
              <Status value={task.status} />
              <span>
                {task.progress?.completed || 0}/{task.progress?.total || '—'} 步
              </span>
              <span>已花费 {money(task.spent, task.currency)}</span>
            </div>
          </div>
          <div className="canvas-actions">
            <button onClick={onOpenResources}>
              <FolderOpen size={15} />
              任务输入
            </button>
            <button className="primary" onClick={() => onOpenDetail()}>
              <FileText size={15} />
              简报与产物
            </button>
          </div>
        </div>
      </div>
      <div className={`canvas-next-action action-${action.tone}`} aria-label="工作流下一步">
        <div className="next-action-copy">
          <span className="eyebrow">下一步</span>
          <h2>{action.title}</h2>
          <p>{action.hint}</p>
        </div>
        <button className="primary next-action-button" onClick={() => onOpenDetail(action.stepId || null, action.focus || null)}>
          {action.button}
          <ArrowRight size={15} />
        </button>
      </div>
      <div className="canvas-live-brief">
        <span>
          <MessageSquare size={14} />
          最新动态
        </span>
        <p>{asText(task.briefing) || '目标已收妥。当前尚未取得真实拆解与执行结果。'}</p>
      </div>
      <div className="canvas-flow-toolbar">
        <div>
          <strong>执行工作流</strong>
          <span>{steps.length ? `${counts.done || 0}/${steps.length} 步完成` : phase.label}</span>
          {crossToolEdges.length > 0 && (
            <span className="cross-tool-count">
              <ArrowLeftRight size={12} />
              {crossToolEdges.length} 次跨工具交接
            </span>
          )}
        </div>
        <div className="workflow-counts" aria-label="工作流状态统计">
          {counts.running > 0 && (
            <span className="count-running">
              <Play size={12} />
              {counts.running} 步进行中
            </span>
          )}
          {counts.blocked > 0 && (
            <span className="count-blocked">
              <CircleAlert size={12} />
              {counts.blocked} 步需处理
            </span>
          )}
          {counts.queued > 0 && (
            <span>
              <Clock3 size={12} />
              {counts.queued} 步待开始
            </span>
          )}
          {!steps.length && (
            <span>
              <Workflow size={12} />
              等待真实方案
            </span>
          )}
        </div>
      </div>
      <div className="flow-canvas">
        {nodes.length ? (
          <ReactFlow
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={savePositions}
            onNodeClick={(_, node) => onOpenDetail(node.id)}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={1.7}
            deleteKeyCode={null}
            nodesConnectable={false}
            edgesReconnectable={false}
            defaultEdgeOptions={{ focusable: true }}
            aria-label="任务工作流画布"
          >
            <Background gap={24} size={1} color="var(--canvas-dot)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor="#8aab99" maskColor="var(--canvas-mask)" />
            <div className="canvas-hint">拖动节点整理布局 · 滚轮缩放 · 点节点下钻记录</div>
          </ReactFlow>
        ) : (
          <div className="canvas-awaiting">
            <Workflow size={32} strokeWidth={1.25} />
            <h2>{phase.label}</h2>
            <p>真实方案出现后会在这里显示步骤、依赖和交接，不会有前置模拟节点。</p>
            <button onClick={() => onOpenDetail()}>
              <FileText size={15} />
              查看目标与工作方案
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
