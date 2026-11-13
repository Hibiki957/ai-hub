import React, { useState } from 'react';
import { FolderOpen, LockKeyhole } from 'lucide-react';
import { money, asText } from './shared.js';
import { STATUS, COLUMNS, Empty, Status } from './ui.jsx';

function TaskCard({ task, projectName, modelName, harnessName, onOpen }) {
  const completed = task.progress?.completed || 0;
  const total = task.progress?.total || 0;
  return (
    <article
      className="task-card"
      draggable
      onDragStart={event => {
        event.dataTransfer.setData('text/plain', task.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <button className="task-open" onClick={() => onOpen(task.id)}>
        <span className="card-project">
          {projectName(task.projectId)}
          {Object.keys(task.manualOverrides || {}).length > 0 && (
            <span title="你的手动安排优先">
              <LockKeyhole size={12} />
              手动
            </span>
          )}
        </span>
        <h3>{task.title || task.goal}</h3>
        <p className="task-briefing">{asText(task.briefing) || '目标已收到，等待编排者拆解安排。'}</p>
        <div className="card-combination">
          <span>{modelName(task.assignment?.modelId)}</span>
          <span className="combination-cross">×</span>
          <span>{harnessName(task.assignment?.harnessId)}</span>
        </div>
        <div className="card-bottom">
          <span className="task-progress">
            <span className="progress-track">
              <i style={{ width: `${total ? Math.min((completed / total) * 100, 100) : 0}%` }} />
            </span>
            <span>
              {completed}/{total || '—'}
            </span>
          </span>
          <span className="card-spend">{money(task.spent, task.currency)}</span>
        </div>
      </button>
    </article>
  );
}
export function BoardColumn({ status, tasks, onDrop, ...props }) {
  const [over, setOver] = useState(false);
  const Icon = STATUS[status].icon;
  return (
    <section
      className={`board-column ${over ? 'drag-over' : ''}`}
      id={`column-${status}`}
      aria-label={STATUS[status].label}
      onDragOver={event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOver(false);
      }}
      onDrop={event => {
        event.preventDefault();
        setOver(false);
        onDrop(event.dataTransfer.getData('text/plain'), status);
      }}
    >
      <header className="column-header">
        <div>
          <Icon size={15} />
          <h2>{STATUS[status].label}</h2>
          <span>{tasks.length}</span>
        </div>
        {status === 'review' && <small>查看产物后验收</small>}
      </header>
      <div className="column-content">
        {tasks.map(task => (
          <TaskCard key={task.id} task={task} {...props} />
        ))}
        {!tasks.length && (
          <div className="column-empty">
            {status === 'running'
              ? '任务开始后会出现在这里'
              : status === 'review'
                ? '有产物后等你验收'
                : status === 'done'
                  ? '通过验收的任务'
                  : status === 'blocked'
                    ? '当前无需介入'
                    : '暂时没有待安排的任务'}
          </div>
        )}
      </div>
    </section>
  );
}
export function Matrix({ tasks, projects, onDrop, ...props }) {
  const grouped = [...projects];
  if (tasks.some(task => !projects.some(project => project.id === task.projectId))) grouped.push({ id: '', name: '未分项目' });
  return (
    <div className="matrix-scroll">
      <div className="matrix">
        <div className="matrix-corner">项目 / 任务状态</div>
        {COLUMNS.map(status => (
          <div className="matrix-heading" key={status}>
            <Status value={status} />
            <span>{tasks.filter(task => task.status === status).length}</span>
          </div>
        ))}
        {grouped.map(project => (
          <React.Fragment key={project.id}>
            <div className="matrix-project">
              <FolderOpen size={16} />
              <strong>{project.name}</strong>
              <span>
                {
                  tasks.filter(task => task.projectId === project.id || (!project.id && !projects.some(item => item.id === task.projectId)))
                    .length
                }{' '}
                项
              </span>
            </div>
            {COLUMNS.map(status => (
              <div
                className="matrix-cell"
                key={status}
                onDragOver={event => event.preventDefault()}
                onDrop={event => {
                  event.preventDefault();
                  const id = event.dataTransfer.getData('text/plain');
                  const task = tasks.find(item => item.id === id);
                  if (task?.projectId === project.id) onDrop(id, status);
                }}
              >
                {tasks
                  .filter(
                    task =>
                      (task.projectId === project.id || (!project.id && !projects.some(item => item.id === task.projectId))) &&
                      task.status === status
                  )
                  .map(task => (
                    <TaskCard key={task.id} task={task} {...props} />
                  ))}
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
export function TaskList({ tasks, projectName, modelName, harnessName, onOpen }) {
  if (!tasks.length) return <Empty title="这个范围里没有任务">换个筛选条件，或创建一个新目标。</Empty>;
  return (
    <div className="task-table-wrap">
      <table className="task-table">
        <thead>
          <tr>
            <th>任务与最新动态</th>
            <th>项目</th>
            <th>状态</th>
            <th>负责组合</th>
            <th>进度</th>
            <th>已花费</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map(task => (
            <tr key={task.id}>
              <td>
                <button className="table-task" onClick={() => onOpen(task.id)}>
                  <strong>{task.title || task.goal}</strong>
                  <span>{asText(task.briefing) || '等待编排安排'}</span>
                </button>
              </td>
              <td>{projectName(task.projectId)}</td>
              <td>
                <Status value={task.status} />
              </td>
              <td>
                <div>{modelName(task.assignment?.modelId)}</div>
                <small>{harnessName(task.assignment?.harnessId)}</small>
              </td>
              <td className="numeric">
                {task.progress?.completed || 0}/{task.progress?.total || '—'}
              </td>
              <td className="numeric">{money(task.spent, task.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
