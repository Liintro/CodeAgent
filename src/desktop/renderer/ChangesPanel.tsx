import { useState } from 'react';
import type { DiffView, WorkbenchSnapshot } from '../../shared/contracts';

export function ChangesPanel({ view, active }: { view: WorkbenchSnapshot; active: boolean }) {
  const [diff, setDiff] = useState<DiffView>();
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    const reply = await window.codeAgent.getChanges();
    setError(reply.ok ? '' : reply.error.message);
    setRefreshing(false);
  }

  async function open(rootId: string, path: string) {
    const reply = await window.codeAgent.getDiff(rootId, path);
    if (reply.ok) {
      setDiff(reply.value);
      setError('');
    } else setError(reply.error.message);
  }

  return (
    <aside className="changes-panel" aria-label="变更">
      <div className="changes-header">
        <strong>变更</strong>
        <button className="text-button" onClick={refresh} disabled={active || refreshing}>刷新</button>
      </div>
      {error && <p className="settings-message">{error}</p>}
      {!view.changes?.roots.length && <p className="changes-empty">运行后显示 Agent 的文件变更</p>}
      {view.changes?.roots.map(entry => {
        const root = view.roots.find(item => item.id === entry.rootId);
        return (
          <section key={entry.rootId} className="changes-root">
            <h3>{root?.alias ?? entry.rootId}{entry.git && <small> {entry.git.branch ?? '无分支'} · {entry.git.baseCommit?.slice(0, 7) ?? '无提交'}</small>}</h3>
            {!entry.git && <p className="changes-empty">{entry.reason}</p>}
            {entry.git && !entry.files.length && <p className="changes-empty">无变更</p>}
            {entry.git && entry.files.map(file => (
              <button key={file.path} className={`change-file ${diff?.rootId === entry.rootId && diff.path === file.path ? 'current' : ''}`} onClick={() => open(entry.rootId, file.path)}>
                <span className={`change-status ${file.status}`}>{file.status}</span>
                <span className="change-path">{file.path}</span>
                <span className="change-count">+{file.additions} −{file.deletions}</span>
              </button>
            ))}
          </section>
        );
      })}
      {diff && (
        <pre className="diff-view" aria-label="差异内容">
          {diff.patch || '（无文本差异）'}
          {diff.truncated && '\n…差异过长，已截断'}
        </pre>
      )}
    </aside>
  );
}
