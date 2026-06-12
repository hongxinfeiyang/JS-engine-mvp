/**
 * ExecutionContextStack.js —— 执行上下文栈
 *
 * 对应 ECMA-262 规范中的“执行上下文栈”（Execution Context Stack，简称 ECS）。
 * 规范中又称其为“调用栈”（Call Stack），以数组的形式存在于引擎内部。
 *
 * 运行原理（规范 §8.3）：
 *   1. 引擎启动时，将全局执行上下文压入栈底。
 *   2. 每进入一个函数（或 eval / 块级作用域），压入新的执行上下文。
 *   3. 执行完毕（return 或抛异常），从栈顶弹出当前上下文。
 *   4. 栈顶元素始终是“正在运行的执行上下文”（running execution context）。
 *
 * 为什么需要一个专门的类来管理栈？
 * ─────────────────────────────────────
 * - 封装 push/pop 操作，确保调用栈的状态一致性。
 * - 提供 current() 方便任意模块获取“当前正在运行的上下文”。
 * - 提供 snapshot() 用于调试器/可视化，输出整个调用栈快照。
 * - 未来可在此类中加入栈溢出的检测逻辑。
 */

// ─── ExecutionContextStack 类 ───────────────────────────────────────────

/**
 * 执行上下文栈 —— 规范“调用栈”的实现。
 *
 * 简单的数组封装，提供 push / pop / peek（通过 current）等操作。
 * 遵守栈（LIFO）语义：后进先出。
 *
 * 示例：
 *   const ecs = new ExecutionContextStack();
 *   ecs.push(globalCtx);    // 全局上下文入栈
 *   ecs.push(funcCtx);      // 函数调用 → 入栈
 *   ecs.current();          // → funcCtx（当前运行中）
 *   ecs.pop();              // 函数返回 → 出栈
 *   ecs.current();          // → globalCtx（回到全局）
 */
export class ExecutionContextStack {
    /**
     * 初始化空栈。
     *
     * 引擎启动后应立即将全局执行上下文 push 进来。
     */
    constructor() {
        /**
         * 内部存储数组。数组末尾即为栈顶（当前运行上下文）。
         * @type {ExecutionContext[]}
         */
        this.stack = [];
    }

    // ─── 栈操作 ─────────────────────────────────────────────────────────

    /**
     * 将执行上下文压入栈顶。
     *
     * 调用时机：
     * - 引擎启动（压入全局上下文）
     * - 函数调用（压入函数上下文）
     * - 进入 eval 代码
     * - 进入块级作用域（某些实现中）
     *
     * @param {ExecutionContext} ctx - 要压入的执行上下文
     */
    push(ctx) {
        this.stack.push(ctx);
    }

    /**
     * 弹出栈顶的执行上下文。
     *
     * 调用时机：
     * - 函数返回
     * - 块作用域退出
     * - eval 执行完毕
     *
     * @returns {ExecutionContext|undefined} 弹出的执行上下文；
     *   若栈为空则返回 undefined（正常情况下不应发生）
     */
    pop() {
        return this.stack.pop();
    }

    // ─── 栈顶访问 ───────────────────────────────────────────────────────

    /**
     * 获取当前正在运行的执行上下文（栈顶元素）。
     *
     * 这是引擎运行期间最频繁调用的方法之一——每次变量查找、this
     * 确定、作用域访问都需要拿到 current 上下文。
     *
     * @returns {ExecutionContext|undefined} 当前执行的上下文
     */
    current() {
        return this.stack[this.stack.length - 1];
    }

    /**
     * 返回栈的当前深度（即嵌套的上下文数量）。
     *
     * 用途：
     * - 调试信息（显示“调用栈深度”）
     * - 栈溢出检测（可设定阈值，超过则报 RangeError）
     *
     * @returns {number} 栈中上下文的数量
     */
    depth() {
        return this.stack.length;
    }

    // ─── 快照与可视化 ───────────────────────────────────────────────────

    /**
     * 生成整个调用栈的可序列化快照。
     *
     * 从栈底到栈顶（索引 0 → length-1）依次调用各上下文的 snapshot()。
     * 用于：
     * - 调试器 UI 显示完整的调用层级
     * - 异常抛出时生成 stack trace 数据
     *
     * @returns {Object[]} 整个调用栈的快照数组
     */
    snapshot() {
        return this.stack.map(ctx => ctx.snapshot());
    }
}
