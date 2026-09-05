import { useEffect, useState } from 'react';
import type { AppError, DeliveryActionResult, DetectedCommand, DiffView, RootDelivery, RootDeliveryState, VerifyCommand, WorkbenchSnapshot } from '../../shared/contracts';
import { deliveryText } from './Sidebar';

export type PanelTab = 'changes' | 'acceptance';
type Call = <T>(action: Promise<{ ok: true; value: T } | { ok: false; error: AppError }>) => Promise<T | undefined>;
type Props = { tab: PanelTab; onTab: (tab: PanelTab) => void; view: WorkbenchSnapshot; active: boolean; call: Call; onClose: () => void };

const rootStateText: Record<RootDeliveryState, string> = { ...deliveryText, committed: '已提交', none: '无变更' };
const resultText = { passed: '通过', failed: '未通过', timeout: '超时', cancelled: '已取消', unavailable: '未能执行' } as const;

export function SidePanel({ tab, onTab, view, active, call, onClose }: Props) {
  return (
    <aside className="changes-panel" aria-label={tab === 'changes' ? '变更' : '验收'}>
      <div className="panel-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'changes'} onClick={() => onTab('changes')}>变更与交付</button>
        <button role="tab" aria-selected={tab === 'acceptance'} onClick={() => onTab('acceptance')}>验收</button>
        <button className="icon-button" aria-label="关闭面板" onClick={onClose}>×</button>
      </div>
      {tab === 'changes' ? <ChangesPanel view={view} active={active} call={call} /> : <AcceptancePanel view={view} active={active} call={call} />}
    </aside>
  );
}

function ChangesPanel({ view, active, call }: { view: WorkbenchSnapshot; active: boolean; call: Call }) {
  const [diff, setDiff] = useState<DiffView>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [committing, setCommitting] = useState<string>();
  const [message, setMessage] = useState('');
  const [confirmShared, setConfirmShared] = useState(false);

  async function refresh() {
    setRefreshing(true);
    const reply = await window.codeAgent.getChanges();
    setError(reply.ok ? '' : reply.error.message);
    if (reply.ok) void window.codeAgent.getDelivery();
    setRefreshing(false);
  }

  async function open(rootId: string, path: string) {
    const reply = await window.codeAgent.getDiff(rootId, path);
    if (reply.ok) {
      setDiff(reply.value);
      setError('');
    } else setError(reply.error.message);
  }

  async function act<T>(action: Promise<{ ok: true; value: T } | { ok: false; error: AppError }>): Promise<T | undefined> {
    setNote('');
    const reply = await action;
    if (!reply.ok) {
      setError(reply.error.message);
      return undefined;
    }
    setError('');
    return reply.value;
  }

  async function restore(rootId: string) {
    const result = await act(window.codeAgent.restoreRoot(rootId)) as DeliveryActionResult | null | undefined;
    if (result) setNote(result.skipped.length ? `已还原。以下文件在任务之后又被修改，已跳过：${result.skipped.join('、')}` : '已还原');
    setDiff(undefined);
  }

  async function commit(entry: RootDelivery) {
    const result = await act(window.codeAgent.commitRoot(entry.rootId, message, confirmShared));
    if (result) {
      setNote(`已提交 ${result.commitSha?.slice(0, 7)}`);
      setCommitting(undefined);
      setMessage('');
    }
  }

  const delivery = view.delivery;
  const partial = delivery?.state === 'unverified' && delivery.roots.some(root => root.state === 'verified');
  return (
    <div className="panel-body">
      <div className="changes-header">
        <span className="task-state">
          {delivery && delivery.state !== 'none' && <span className={`delivery-chip ${delivery.state}`}>{partial ? '部分已验证' : deliveryText[delivery.state]}</span>}
        </span>
        <button className="text-button" onClick={refresh} disabled={active || refreshing}>刷新</button>
      </div>
      {error && <p className="settings-message">{error}</p>}
      {note && <p className="panel-note">{note}</p>}
      {!view.changes?.roots.length && <p className="changes-empty">运行后显示 Agent 的文件变更</p>}
      {view.changes?.roots.map(entry => {
        const root = view.roots.find(item => item.id === entry.rootId);
        const info = delivery?.roots.find(item => item.rootId === entry.rootId);
        return (
          <section key={entry.rootId} className="changes-root">
            <h3>
              {root?.alias ?? entry.rootId}
              {entry.git && <small> {entry.git.branch ?? '无分支'} · {entry.git.baseCommit?.slice(0, 7) ?? '无提交'}</small>}
              {info && info.state !== 'none' && <span className={`delivery-chip ${info.state}`}>{rootStateText[info.state]}</span>}
            </h3>
            {!entry.git && <p className="changes-empty">{entry.reason}</p>}
            {entry.git && !entry.files.length && <p className="changes-empty">无变更</p>}
            {entry.git && entry.files.map(file => (
              <button key={file.path} className={`change-file ${diff?.rootId === entry.rootId && diff.path === file.path ? 'current' : ''}`} onClick={() => open(entry.rootId, file.path)}>
                <span className={`change-status ${file.status}`}>{file.status}</span>
                <span className="change-path">{file.path}</span>
                <span className="change-count">+{file.additions} −{file.deletions}</span>
              </button>
            ))}
            {info && info.state !== 'none' && (
              <div className="delivery-block">
                {info.verification.map(result => (
                  <div key={result.commandId} className="verify-line">
                    <span className={`dot ${result.status === 'passed' ? 'ok' : 'bad'}`} />
                    <span className="verify-label">{result.label}</span>
                    <span>{resultText[result.status]}{result.exitCode !== undefined && result.status !== 'passed' ? ` · 退出码 ${result.exitCode}` : ''}</span>
                    <span className="tool-meta">{(result.durationMs / 1000).toFixed(1)} s</span>
                  </div>
                ))}
                {info.noCommands && <p className="changes-empty">该目录有改动但没有验收命令，不能视为已验证。</p>}
                {info.state === 'unverified' && info.verification.length === 0 && !info.noCommands && <p className="changes-empty">代码在上次验证之后又有变化，需要重新验证。</p>}
                {info.dirtyAtBaseline && <p className="changes-empty">任务开始时该目录已有您未提交的修改。</p>}
                {info.git && entry.git && entry.files.length > 0 && (
                  <div className="delivery-actions">
                    <button className="secondary small" disabled={active || info.state === 'accepted' || info.state === 'committed'} onClick={() => act(window.codeAgent.acceptRoot(info.rootId))}>接受</button>
                    <button className="secondary small" disabled={active || info.state === 'committed'} onClick={() => restore(info.rootId)}>还原</button>
                    <button className="secondary small" disabled={active || info.state === 'committed'} onClick={() => setCommitting(committing === info.rootId ? undefined : info.rootId)}>提交…</button>
                  </div>
                )}
                {committing === info.rootId && (
                  <div className="commit-form">
                    <textarea aria-label="提交说明" value={message} onChange={event => setMessage(event.target.value)} placeholder="提交说明" rows={2} />
                    {info.sharedPaths.length > 0 && (
                      <label className="checkbox-label">
                        <input type="checkbox" checked={confirmShared} onChange={event => setConfirmShared(event.target.checked)} />
                        <span>提交将包含您在这些文件上已有的修改：{info.sharedPaths.join('、')}</span>
                      </label>
                    )}
                    <button className="primary small" disabled={active || !message.trim() || (info.sharedPaths.length > 0 && !confirmShared)} onClick={() => commit(info)}>提交所选改动</button>
                  </div>
                )}
                {info.commitSha && <p className="changes-empty">提交 {info.commitSha.slice(0, 7)}（未推送）</p>}
              </div>
            )}
          </section>
        );
      })}
      {diff && (
        <pre className="diff-view" aria-label="差异内容">
          {diff.patch || '（无文本差异）'}
          {diff.truncated && '\n…差异过长，已截断'}
        </pre>
      )}
    </div>
  );
}

function AcceptancePanel({ view, active, call }: { view: WorkbenchSnapshot; active: boolean; call: Call }) {
  const [commands, setCommands] = useState<VerifyCommand[]>(view.acceptance.commands);
  const [maxRepairs, setMaxRepairs] = useState(view.acceptance.maxRepairs);
  const [suggestions, setSuggestions] = useState<DetectedCommand[]>([]);
  const taskKey = view.taskId;
  const plan = view.permission.userMode === 'plan';

  useEffect(() => {
    setCommands(view.acceptance.commands);
    setMaxRepairs(view.acceptance.maxRepairs);
    setSuggestions([]);
  }, [taskKey, JSON.stringify(view.acceptance)]);

  const update = (id: string, patch: Partial<VerifyCommand>) => {
    setCommands(list => list.map(item => item.id === id ? { ...item, ...patch } : item));
  };
  const add = (command: VerifyCommand) => {
    setCommands(list => list.some(item => item.id === command.id) ? list : [...list, command]);
  };
  async function detect() {
    const found = await call(window.codeAgent.detectAcceptance());
    setSuggestions(found ?? []);
  }
  const saved = JSON.stringify({ commands, maxRepairs }) === JSON.stringify(view.acceptance);
  const save = () => call(window.codeAgent.setAcceptance({ commands, maxRepairs }));

  return (
    <div className="panel-body">
      <p className="panel-hint">确认后的命令会在 Agent 修改文件之后自动运行；失败的真实输出会交给 Agent 修复。</p>
      {view.roots.map(root => {
        const own = commands.filter(command => command.rootId === root.id);
        return (
          <section key={root.id} className="accept-root">
            <h3>{root.alias}</h3>
            {!own.length && <p className="changes-empty">未设置验收命令</p>}
            {own.map(command => (
              <div key={command.id} className="command-row">
                <input aria-label="命令名称" className="command-label" value={command.label} onChange={event => update(command.id, { label: event.target.value })} />
                <input aria-label="验收命令" className="command-text" value={command.command} onChange={event => update(command.id, { command: event.target.value })} />
                <label className="timeout-field">超时 <input aria-label="超时秒数" type="number" min={1} max={3600} value={command.timeoutSeconds} onChange={event => update(command.id, { timeoutSeconds: Number(event.target.value) })} /> 秒</label>
                <button className="icon-button" aria-label="删除命令" onClick={() => setCommands(list => list.filter(item => item.id !== command.id))}>×</button>
              </div>
            ))}
            <button className="text-button" disabled={active} onClick={() => add({ id: crypto.randomUUID(), rootId: root.id, label: '验收命令', command: '', timeoutSeconds: 600 })}>＋ 添加命令</button>
          </section>
        );
      })}
      {suggestions.length > 0 && (
        <section className="accept-root">
          <h3>检测到的命令</h3>
          {suggestions.map(item => (
            <div key={item.id} className="suggestion">
              <span>{view.roots.find(root => root.id === item.rootId)?.alias} · <code>{item.command}</code></span>
              {item.missing && <small className="warn-text">未在 PATH 中找到 {item.missing}</small>}
              <button className="text-button" onClick={() => add({ id: item.id, rootId: item.rootId, label: item.label, command: item.command, timeoutSeconds: item.timeoutSeconds })}>添加</button>
            </div>
          ))}
        </section>
      )}
      <div className="accept-footer">
        <label className="repair-field">最多修复 <input aria-label="修复次数上限" type="number" min={0} max={10} value={maxRepairs} onChange={event => setMaxRepairs(Number(event.target.value))} /> 次</label>
        <button className="secondary small" onClick={detect} disabled={active || !view.roots.length}>检测</button>
        <button className="primary small" onClick={save} disabled={active || saved || commands.some(command => !command.command.trim())}>{saved ? '已保存' : '保存并确认'}</button>
      </div>
      <button className="secondary" onClick={() => call(window.codeAgent.verifyNow())} disabled={active || plan || !view.acceptance.commands.length}>立即验证</button>
      {plan && <p className="changes-empty">计划模式不执行验证命令。</p>}
    </div>
  );
}
