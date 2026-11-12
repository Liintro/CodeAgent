import { useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronRight, Copy } from 'lucide-react';
import type { AppError } from '../../../../shared/contracts';
import type { Attention } from '../../../../shared/attention';
import { useUi } from '../../store/ui';
import { useNotifications } from '../../store/notifications';

type Action = { label: string; onClick: () => void };

// 错误给出下一步：能识别的错误附带一个直接的操作按钮。
function nextStep(error: AppError): Action | undefined {
  if (error.code === 'HOST_EXITED' || error.code === 'HOST_NOT_RUNNING' || error.code === 'HOST_TIMEOUT') {
    return { label: '重启运行进程', onClick: () => void window.codeAgent.restartHost() };
  }
  if (/模型|API Key|密钥|Base URL|Model ID/.test(error.message) || error.code.startsWith('KEY_') || error.code === 'SETTINGS_INVALID') {
    return { label: '打开模型设置', onClick: () => useUi.getState().openSettings('模型') };
  }
  if (error.code === 'MCP_CONFIG_INVALID') return { label: '打开 MCP 设置', onClick: () => useUi.getState().openSettings('MCP 与联网') };
  return undefined;
}

export function notifyError(error: AppError, id?: string): void {
  const action = nextStep(error);
  toast.error(error.message, {
    id: id ?? `error:${error.code}:${error.message}`,
    duration: Infinity,
    closeButton: true,
    description: error.detail ? <ErrorDetail detail={error.detail} /> : undefined,
    action: action ? { label: action.label, onClick: action.onClick } : undefined,
  });
}

export function notifyInfo(text: string): void {
  toast(text, { duration: 3000 });
}

export function notifyAttention(attention: Attention): void {
  if (attention.taskId && attention.level !== 'error' && !document.hasFocus()) useNotifications.getState().markUnread(attention.taskId);
  // 需要处理的事项由停靠区常驻显示；运行进程退出由停靠区的重启卡片显示。
  if (attention.level === 'action' || attention.kind === 'host_exited') return;
  if (attention.level === 'error') {
    notifyError({ code: attention.kind, message: attention.title, detail: attention.body || undefined }, `${attention.kind}:${attention.taskId ?? ''}`);
    return;
  }
  toast.success(attention.title, {
    id: `${attention.kind}:${attention.taskId ?? ''}`,
    description: attention.body,
    duration: 5000,
    action: { label: '查看变更', onClick: () => useUi.getState().openPanel('changes') },
  });
}

function ErrorDetail({ detail }: { detail: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1">
      <div className="flex items-center gap-2">
        <button type="button" className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(value => !value)}>
          <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />诊断详情
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void navigator.clipboard.writeText(detail).then(() => setCopied(true))}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}{copied ? '已复制' : '复制'}
        </button>
      </div>
      {open && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-[11px]">{detail}</pre>}
    </div>
  );
}
