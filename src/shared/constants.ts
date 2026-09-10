// 运行时常量单独放在这里：contracts.ts 只有类型，preload 的 CommonJS 编译也会处理它，不能带运行时导出。
export const DEFAULT_MAX_REPAIRS = 3;
export const IMPLEMENT_PLAN_TEXT = '请按照上面的计划开始实施。';
export const CONTINUE_TEXT = '请从当前的实际状态继续完成上一次被中断的任务。';
export const VERIFY_ONLY_TEXT = '手动验证';
export const FEEDBACK_PREFIX = '[自动验证反馈]';
export const RECOVERY_PREFIX = '[任务恢复说明]';
