/**
 * StepCapture — 执行过程步骤捕获器
 *
 * 包装 JSEngine，在全量执行过程中通过 hook 系统捕获每一步的运行时状态快照。
 * 每个步骤对应一个 hook 事件，携带当时的调用栈、作用域链、this、内存等完整上下文。
 *
 * 用途：为交互式可视化页面（interactive.html）提供可回放的执行轨迹数据。
 *
 * 设计决策：
 *   - 选择"全量执行 + 事后回放"而非"真实断点暂停"
 *     Why：JavaScript 是单线程同步执行，不支持抢占式断点。
 *     事后回放利用已有的 hook 系统，改造成本最低，且支持前进/后退双向导航。
 *   - 每个步骤做完整的环境快照（ecStack + scopeChain + memory）
 *     Why：保证前后步进时即便用户跳过多步，也能立即渲染当前步的完整状态。
 *
 * @module StepCapture
 */

import { JSEngine } from './index.js';
import { HookEvents } from './hooks/HookEvents.js';

// ─── 事件分组定义：控制哪些事件被捕获为"步骤" ───
// WHY: token/parse:node/eval:node:enter 等事件过于密集，作为步骤会淹没关键信息
// 我们只捕获"有意义"的运行时事件，token/parse 等在前端阶段跳过
// eval:node:exit 仅在特定节点类型（表达式语句/返回语句）时捕获，展示计算结果
const STEP_EVENTS = new Set([
    // 执行上下文
    HookEvents.CONTEXT_CREATION_START,
    HookEvents.CONTEXT_CREATION_END,
    HookEvents.CONTEXT_PUSH,
    HookEvents.CONTEXT_POP,
    // 变量
    HookEvents.VARIABLE_DECLARE,
    HookEvents.VARIABLE_ASSIGN,
    HookEvents.VARIABLE_READ,
    // 作用域
    HookEvents.SCOPE_LOOKUP,
    HookEvents.SCOPE_CHAIN_RESOLVE,
    // 闭包
    HookEvents.CLOSURE_CREATE,
    // this
    HookEvents.THIS_RESOLVE,
    // 函数
    HookEvents.FUNCTION_CALL,
    HookEvents.FUNCTION_RETURN,
    // 节点求值结果（仅捕获有意义的节点类型）
    HookEvents.EVAL_NODE_EXIT,
]);

// eval:node:exit 中值得捕获为步骤的节点类型
// ExpressionStatement: 如 `a + c;` 的计算结果
// ReturnStatement: 如 `return x + 1;` 的返回值
const SIGNIFICANT_EXIT_NODES = new Set([
    'ExpressionStatement',
    'ReturnStatement',
]);

/**
 * 为事件生成人类可读的中文描述
 * @param {string} event - 事件名
 * @param {object} data - 事件数据
 * @returns {string} 中文描述
 */
function describeEvent(event, data) {
    switch (event) {
        case HookEvents.CONTEXT_CREATION_START:
            return data.type === 'function'
                ? `环境变量声明阶段开始 — 函数 ${data.name}`
                : `创建阶段开始 — 全局环境`;
        case HookEvents.CONTEXT_CREATION_END:
            return data.type === 'function'
                ? `执行上下文创建完成 — 函数 ${data.name}`
                : `创建阶段完成 — 全局环境（环境就绪，即将执行代码）`;
        case HookEvents.CONTEXT_PUSH:
            return `执行上下文入栈 — ${data.type} ${data.name || ''}`;
        case HookEvents.CONTEXT_POP:
            return `执行上下文出栈 — ${data.type} ${data.name || ''}`;
        case HookEvents.VARIABLE_DECLARE: {
            if (data.kind === 'var') {
                return `声明变量 — var ${data.name} = undefined（提升初始化）`;
            }
            if (data.kind === 'function') {
                return `声明函数 — function ${data.name}（提升并完整初始化）`;
            }
            return `声明变量 — ${data.kind} ${data.name}${data.initialized ? '（已初始化）' : '（TDZ 未初始化）'}`;
        }
        case HookEvents.VARIABLE_ASSIGN:
            return `变量赋值 — ${data.name} = ${JSON.stringify(data.newValue)}`;
        case HookEvents.VARIABLE_READ:
            return `读取变量 — ${data.name} → ${JSON.stringify(data.value)}`;
        case HookEvents.SCOPE_LOOKUP:
            return data.purpose === 'call'
                ? `"${data.name}" 执行上下文创建阶段开始 — this绑定阶段 — 作用域查找 — 开始查找`
                : `"${data.name}" 作用域查找 — 开始查找`;
        case HookEvents.SCOPE_CHAIN_RESOLVE:
            return `作用域查找结果 — "${data.name}" ${data.found ? '找到（深度=' + data.depth + '）' : '未找到'}`;
        case HookEvents.CLOSURE_CREATE:
            if (data.isRealClosure) {
                return `闭包创建 — ${data.funcName} 捕获变量 [${(data.capturedVars || []).join(', ')}]`;
            }
            if (data.isNested) {
                return `嵌套函数 — ${data.funcName}（无捕获变量）`;
            }
            return `函数创建 — ${data.funcName}（顶层函数）`;
        case HookEvents.THIS_RESOLVE:
            return `this指向 — 模式: ${data.pattern}, 值: ${JSON.stringify(data.value)}`;
        case HookEvents.FUNCTION_CALL:
            return `函数调用 — ${data.name}(${(data.args || []).map(a => JSON.stringify(a)).join(', ')})`;
        case HookEvents.FUNCTION_RETURN:
            return `函数返回 — ${data.name} → ${JSON.stringify(data.value)}`;
        case HookEvents.EVAL_NODE_EXIT:
            if (data.type === 'ExpressionStatement') {
                return `表达式计算结果 → ${JSON.stringify(data.result)}`;
            }
            if (data.type === 'ReturnStatement') {
                return `return 语句值 → ${JSON.stringify(data.result)}`;
            }
            return `节点求值完成 — ${data.type}`;
        default:
            return event;
    }
}

/**
 * 安全的序列化，处理循环引用和特殊值
 * @param {*} obj
 * @returns {*}
 */
function safeClone(obj) {
    try {
        return JSON.parse(JSON.stringify(obj));
    }
    catch {
        if (obj === undefined) return null;
        if (obj === null) return null;
        if (typeof obj === 'function') return '<function>';
        if (typeof obj === 'symbol') return String(obj);
        return String(obj);
    }
}

/**
 * 执行代码并返回步骤化的执行轨迹
 *
 * @param {string} code - 要执行的 JS 源代码
 * @returns {{ steps: Array, error: string|null, result: any }}
 *   steps: 每个步骤包含 { index, event, description, ecStack, scopeChain, memory, ...data }
 */
export function captureSteps(code) {
    const engine = new JSEngine();
    const steps = [];
    let hasError = null;
    let finalResult = undefined;

    // ─── 注册所有事件钩子：捕获状态快照 ───
    // 全量注册（包括非步骤事件），因为 getTrace() 也需要它们
    const allEvents = Object.values(HookEvents);
    for (const evt of allEvents) {
        engine.on(evt, (data) => {
            // 只对"有意义"的事件生成步骤，减少噪音
            if (!STEP_EVENTS.has(evt)) return;

            // eval:node:exit 仅捕获表达式语句和返回语句的计算结果
            if (evt === HookEvents.EVAL_NODE_EXIT && !SIGNIFICANT_EXIT_NODES.has(data.type)) return;

            // WHY: 每个步骤都做完整快照，保证前后步进时状态正确
            steps.push({
                index: steps.length,
                event: evt,
                description: describeEvent(evt, data),
                data: safeClone(data),
                // 运行时状态快照
                ecStack: safeClone(engine.getCallStack()),
                scopeChain: safeClone(engine.getScopeChain()),
                memory: safeClone(engine.getMemorySnapshot()),
            });
        });
    }

    // ─── 执行 ───
    try {
        finalResult = engine.execute(code);
    } catch (e) {
        hasError = {
            message: e.message,
            name: e.name,
            stack: e.stack,
        };
    }

    return {
        steps,
        stepCount: steps.length,
        error: hasError,
        result: finalResult,
    };
}
