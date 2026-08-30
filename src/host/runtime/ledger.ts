import { randomUUID } from 'node:crypto';
import type { RunEvent, RunEventType, RunPhase } from '../../shared/contracts.js';

export type RunRecord = {
  id: string;
  taskId: string;
  startedAt: number;
  endedAt?: number;
  phase: RunPhase;
  events: RunEvent[];
};

// 只记录事实（发生了什么）；对话内容由 Pi SessionManager 保存。
export class Ledger {
  private readonly runs = new Map<string, RunRecord>();

  startRun(taskId: string): RunRecord {
    const run: RunRecord = { id: randomUUID(), taskId, startedAt: Date.now(), phase: 'running', events: [] };
    this.runs.set(run.id, run);
    return run;
  }

  endRun(runId: string, phase: RunPhase): void {
    const run = this.require(runId);
    run.phase = phase;
    run.endedAt = Date.now();
  }

  appendEvent(runId: string, type: RunEventType, data: Record<string, unknown>): void {
    const run = this.require(runId);
    run.events.push({ runId, seq: run.events.length + 1, at: Date.now(), type, data });
  }

  events(runId: string): RunEvent[] {
    return structuredClone(this.require(runId).events);
  }

  private require(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new Error('执行记录不存在');
    return run;
  }
}
