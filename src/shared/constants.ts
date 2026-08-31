// 运行时常量单独放在这里：contracts.ts 只有类型，preload 的 CommonJS 编译也会处理它，不能带运行时导出。
export const DEFAULT_MAX_REPAIRS = 3;
export const FEEDBACK_PREFIX = '[自动验证反馈]';
export const RECOVERY_PREFIX = '[任务恢复说明]';
