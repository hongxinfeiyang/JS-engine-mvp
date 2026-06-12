/**
 * HookSystem — 贯穿引擎全流程的事件分发与追踪系统
 *
 * 设计要点：
 * 1. 事件触发时同步写入 _traceLog（结构化追踪日志）并通知所有监听器
 * 2. 监听器异常被静默捕获 —— 一个监听器崩溃不应影响引擎运行
 * 3. emit 时对 data 使用 structuredClone 浅拷贝，防止监听器修改原始数据
 * 4. 支持 enable/disable 开关 —— 生产环境可禁用监听器保留 trace 日志
 */

export class HookSystem {
    constructor() {
        this._listeners = new Map(); // event → [callback, ...]
        this._traceLog = [];          // 完整追踪日志
        this._enabled = true;         // 监听器开关
    }

    /**
     * 注册事件监听器
     * @param {string} event - 事件名（使用 HookEvents 常量）
     * @param {Function} callback - 回调函数，接收 data 参数
     */
    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, []);
        }
        this._listeners.get(event).push(callback);
    }

    /**
     * 取消事件监听器
     * @param {string} event
     * @param {Function} callback - 必须与注册时传入的引用相同
     */
    off(event, callback) {
        const listeners = this._listeners.get(event);
        if (!listeners) return;
        const idx = listeners.indexOf(callback);
        if (idx !== -1) listeners.splice(idx, 1);
    }

    /**
     * 触发事件 — 核心方法
     *
     * Why: 先写 traceLog 再调监听器，保证即使监听器抛错，trace 中仍有记录
     * structuredClone 确保监听器拿到的 data 是独立副本
     *
     * @param {string} event - 事件名
     * @param {object} data  - 事件数据（会被浅拷贝）
     */
    emit(event, data = {}) {
        const entry = {
            timestamp: Date.now(),
            event,
            data: structuredClone(data),
        };
        this._traceLog.push(entry);

        if (!this._enabled) return;

        const listeners = this._listeners.get(event);
        if (!listeners) return;
        for (const cb of listeners) {
            // Why try/catch: 一个监听器的异常不应阻止其他监听器或引擎运行
            try { cb(data); } catch (e) { /* 静默吞掉监听器错误 */ }
        }
    }

    /** 返回完整追踪日志（从引擎启动到当前的所有事件） */
    getTrace() {
        return this._traceLog;
    }

    /** 清空追踪日志（多次 execute() 之间调用） */
    clearTrace() {
        this._traceLog.length = 0;
    }

    /** 禁用监听器回调（trace 日志仍会记录） */
    disable() { this._enabled = false; }

    /** 重新启用监听器回调 */
    enable() { this._enabled = true; }
}
