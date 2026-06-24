/**
 * index.js — JS-engine 主入口 / 公共 API 层
 *
 * 本模块是 JS-engine 对外的唯一入口，封装了：
 *   1. 整个引擎的组装（HookSystem → Realm → Evaluator 的依赖注入链）
 *   2. 编译管道（Lexer → Parser → AST）
 *   3. 执行管道（AST → Evaluator → 结果）
 *   4. 可观测性接口（hook 订阅、调用栈/作用域链/内存快照查询）
 *
 * 设计决策：
 *
 *   a) 为什么是单体 JSEngine 类而不是独立函数？
 *      - 引擎需要维护共享状态（Realm、HookSystem、Evaluator），
 *        这些组件的生命周期是一致的（创建 → 使用 → 销毁）。
 *      - 类封装了依赖注入：用户只需传 options 配置，内部按固定拓扑组装各子系统。
 *      - 方法式的 API（engine.execute(code)）比函数式（execute(realm, code)）
 *        对使用者更友好，也更接近 V8 Isolate / SpiderMonkey JSContext 的使用模式。
 *
 *   b) 为什么 HookSystem 是第一公民？
 *      - hooks 贯穿整个引擎（Lexer、Parser、Evaluator、Memory 都通过 hooks 发事件），
 *        它是实现调试器、可视化、性能追踪的唯一渠道。
 *      - 在 constructor 中先创建 HookSystem，再用它构造 Realm，确保 Realm 内所有
 *        子系统共享同一个事件总线。
 *
 *   c) 为什么 strict 默认 false？
 *      - ES 规范从 ES5 起引入严格模式，但非严格模式代码仍广泛存在于遗留脚本中。
 *        默认 false（sloppy mode）确保与最大比例的现实代码兼容。
 *        用户可通过 options.strict = true 或代码中的 "use strict" 指令启用。
 *
 *   d) 为什么提供 evaluate(ast) 而非只提供 execute(code)？
 *      - 这是一个编译器架构的常见分层：有些场景需要先解析、缓存 AST、
 *        然后在不同时机多次执行同一个 AST（类似 React 的 JSX 预编译）。
 *      - 允许调用方直接传入 AST 也方便了 AST 级别的工具（如 linter、code mod）
 *        复用执行能力。
 */

import { HookSystem } from './hooks/HookSystem.js';
import { HookEvents } from './hooks/HookEvents.js';
import { Lexer } from './lexer/Lexer.js';
import { Parser } from './parser/Parser.js';
import { Realm } from './runtime/Realm.js';
import { Evaluator } from './evaluator/Evaluator.js';

// ─── JSEngine 类 ─────────────────────────────────────────────────────────────
// 核心引擎类，一个实例 = 一个沙箱化的 JS 运行环境。

export class JSEngine {
    /**
     * 创建一个 JS 引擎实例（沙箱）
     *
     * 每个 JSEngine 实例拥有独立的 Realm、内存堆、全局对象和执行上下文栈。
     * 不同实例之间完全隔离，适合实现：
     *   - 服务端的用户脚本沙箱（类似 Node.js vm 模块）
     *   - 可视化教程中的多步骤/多示例隔离
     *
     * @param {object} [options={}] - 引擎配置
     * @param {boolean} [options.strict=false] - 是否默认启用严格模式
     * @param {object} [options.hooks] - 事件回调映射 { eventName: callback }
     *        在引擎初始化阶段注册的 hooks，等价于调用 engine.on(event, callback)
     */
    constructor(options = {}) {
        // 步骤 1: 创建事件总线
        // 必须在 Realm 之前创建，因为 Realm 及其所有子系统都依赖此实例发事件
        this.hooks = new HookSystem();

        // 步骤 2: 创建执行环境（内存堆 + 调用栈 + 全局对象）
        this.realm = new Realm(this.hooks);

        // 步骤 3: 创建求值器（AST 遍历执行引擎）
        this.evaluator = new Evaluator(this.realm, this.hooks);

        // 默认在 sloppy 模式下运行，与 ES 规范及浏览器环境一致
        this.strict = options.strict || false;

        // 注册用户提供的 hooks
        // 这里没有做事件名校验（因为 HookEvents 有完整枚举），
        // 由 HookSystem.on 内部处理未知事件名的逻辑
        if (options.hooks) {
            for (const [event, callback] of Object.entries(options.hooks)) {
                this.hooks.on(event, callback);
            }
        }
    }

    // ─── 编译管道 ───────────────────────────────────────────────────────────

    /**
     * 将 JS 源代码解析为 AST
     *
     * 编译管道的两个阶段：
     *   1. 词法分析 (Lexer)：源代码字符串 → Token 流
     *   2. 语法分析 (Parser)：Token 流 → AST（Program 节点）
     *
     * 每次调用都会创建新的 Lexer 和 Parser 实例。
     * 这样做而非复用实例的原因：
     *   - 避免内部状态污染（Parser 有位置指针、错误缓冲等）
     *   - 词法分析和语法分析本身是无状态的 "string in, AST out" 转换，
     *     创建新实例的成本在实际使用中可忽略不计
     *
     * @param {string} code - JS 源代码字符串
     * @returns {object} AST 根节点（Program 类型）
     */
    parse(code) {
        const lexer = new Lexer(code, this.hooks);
        const tokens = lexer.tokenize();

        const parser = new Parser(tokens, this.hooks);
        return parser.parse();
    }

    /**
     * 解析并执行 JS 代码（一条龙）
     *
     * 这是最常用的接口：传入源码，得到结果。
     * 等效于 engine.evaluate(engine.parse(code))。
     *
     * @param {string} code - JS 源代码字符串
     * @returns {*} 最后一条表达式语句的值（REPL 模式），或 undefined
     */
    execute(code) {
        const ast = this.parse(code);
        return this._evaluateAST(ast);
    }

    // ─── 执行管道 ───────────────────────────────────────────────────────────

    /**
     * 执行已解析的 AST
     *
     * 提供此方法是因为有些场景需要将"解析"和"执行"分离：
     *   - 预编译：解析一次，执行多次
     *   - 代码转换：先修改 AST，再执行修改后的版本
     *   - 单元测试：直接构造 AST 节点测试求值器，绕过解析器
     *
     * @param {object} ast - AST 根节点（必须是有效的 Program 节点）
     * @returns {*} 执行结果（最后一条语句的值）
     */
    evaluate(ast) {
        return this._evaluateAST(ast);
    }

    /**
     * AST 求值的内部实现
     *
     * 包裹了 hook 事件的发出：
     *   - EXECUTION_START：求值开始前触发，调试器可在此设置断点/开始计时
     *   - EXECUTION_END：求值结束后触发，携带 _safeValue 处理后的结果
     *
     * _safeValue 的作用是防止 hook 回调中意外访问已失效的堆引用
     * （例如，如果调用了 GC，原 result 中的 Ref 可能变为悬垂引用）。
     *
     * @param {object} ast - AST 根节点
     * @returns {*} 执行结果
     * @private
     */
    _evaluateAST(ast) {
        this.hooks.emit(HookEvents.EXECUTION_START, {});
        const result = this.evaluator.evaluate(ast);
        this.hooks.emit(HookEvents.EXECUTION_END, { result: this._safeValue(result) });
        return result;
    }

    // ─── Hook API（可观测性接口） ────────────────────────────────────────────

    /**
     * 订阅引擎事件
     *
     * Hook 事件类型参见 HookEvents 枚举：
     *   - EXECUTION_START / EXECUTION_END
     *   - MEMORY_ALLOCATE / MEMORY_FREE
     *   - VARIABLE_READ / VARIABLE_WRITE
     *   - FUNCTION_CALL / FUNCTION_RETURN
     *   等...
     *
     * @param {string} event - 事件名称（来自 HookEvents）
     * @param {Function} callback - 事件回调函数
     */
    on(event, callback) {
        this.hooks.on(event, callback);
    }

    /**
     * 取消订阅引擎事件
     *
     * @param {string} event - 事件名称
     * @param {Function} callback - 之前注册的回调函数引用
     */
    off(event, callback) {
        this.hooks.off(event, callback);
    }

    /**
     * 获取事件追踪记录
     *
     * 返回自引擎启动或上次 clearTrace() 以来所有 hook 事件的时序列表。
     * 用于可视化调试器的时间线面板和性能分析。
     *
     * @returns {object[]} 事件记录数组
     */
    getTrace() {
        return this.hooks.getTrace();
    }

    /**
     * 清空事件追踪记录
     *
     * 通常在以下时机调用：
     *   - 用户开始新的调试会话
     *   - 内存压力较大需要释放 trace 缓冲区
     */
    clearTrace() {
        this.hooks.clearTrace();
    }

    // ─── 运行时状态查询（供可视化 / 调试器消费） ────────────────────────────

    /**
     * 获取当前执行上下文的快照
     *
     * 当前 EC 包含：函数调用信息、this 值、当前作用域等。
     * 在调试器中，此信息用于渲染"当前帧"高亮。
     *
     * @returns {object|null} 当前 EC 的快照对象，调用栈为空时返回 null
     */
    getCurrentContext() {
        const ec = this.realm.ecStack.current();
        return ec ? ec.snapshot() : null;
    }

    /**
     * 获取完整的调用栈快照
     *
     * 栈底为全局 EC，栈顶为当前正在执行的函数 EC。
     * 模仿浏览器 DevTools 的 Call Stack 面板。
     *
     * @returns {object[]} EC 快照数组（栈底 → 栈顶）
     */
    getCallStack() {
        return this.realm.ecStack.snapshot();
    }

    /**
     * 获取当前作用域链（包含闭包保持存活的词法环境）
     *
     * 从当前 EC 的词法环境开始，沿 outer 链向上回溯，
     * 直到到达全局环境（outer === null）。
     *
     * 额外扫描：遍历主链所有绑定，寻找闭包函数对象。
     * 若函数的 [[Environment]]（closure）不在主作用域链上，
     * 说明该环境虽已不在调用栈但被闭包引用而保持存活，
     * 将其追加到作用域链尾部（标记 type: 'closure'）。
     *
     * 作用域链是理解标识符解析的关键：当 JS 引擎遇到一个变量名，
     * 会沿此链逐级查找，直到找到绑定或抵达链尾（抛出 ReferenceError）。
     *
     * @returns {object[]} 词法环境快照数组（内层 → 外层）
     */
    getScopeChain() {
        const ec = this.realm.ecStack.current();
        if (!ec) return [];
        const chain = [];
        const seenEnvs = new Set(); // 已加入链的环境引用，防止重复

        // 主作用域链：从当前 EC 的词法环境开始沿 outer 遍历
        let env = ec.lexicalEnvironment;
        while (env) {
            seenEnvs.add(env);
            chain.push(env.snapshot());
            env = env.outer;
        }

        // 闭包环境：扫描主链所有环境的所有绑定，找到被闭包保持存活的环境
        const closureChains = [];
        env = ec.lexicalEnvironment;
        while (env) {
            const er = env.environmentRecord;
            // DeclarativeEnvironmentRecord：Map<name, Binding<{ value, initialized }>>
            let candidateVals = [];
            if (er.bindings instanceof Map) {
                for (const [, binding] of er.bindings) {
                    if (binding.initialized && binding.value != null) {
                        candidateVals.push(binding.value);
                    }
                }
            }
            // ObjectEnvironmentRecord（如全局环境）：bindingObject.properties (Map)
            if (er.bindingObject && er.bindingObject.properties instanceof Map) {
                for (const [, rawVal] of er.bindingObject.properties) {
                    if (rawVal != null) candidateVals.push(rawVal);
                }
            }

            for (const val of candidateVals) {
                // 检查是否为堆引用（Ref<FunctionObject>）
                if (typeof val !== 'object' || typeof val.address !== 'number') continue;
                const memEntry = this.realm.memory.getEntry(val.address);
                if (!memEntry || !memEntry.value || typeof memEntry.value !== 'object') continue;
                const closureEnv = memEntry.value.closure;
                if (!closureEnv || seenEnvs.has(closureEnv)) continue;
                // 找到闭包保持存活的词法环境，沿其 outer 链加入
                let cEnv = closureEnv;
                while (cEnv && !seenEnvs.has(cEnv)) {
                    seenEnvs.add(cEnv);
                    closureChains.push({
                        ...cEnv.snapshot(),
                        type: 'closure', // 闭包环境标记，前端用于区分展示
                    });
                    cEnv = cEnv.outer;
                }
            }
            env = env.outer;
        }

        if (closureChains.length > 0) {
            chain.push(...closureChains);
        }

        return chain;
    }

    /**
     * 获取当前堆内存的快照
     *
     * 返回所有已分配记录的列表，包括地址、类型、值。
     * 用于可视化调试器的 Memory 面板，帮助理解对象/闭包/数组的存储结构。
     *
     * @returns {object[]} 内存记录快照数组
     */
    getMemorySnapshot() {
        return this.realm.memory.snapshot();
    }

    /**
     * 将求值结果安全地转换为可序列化的值
     *
     * 这是 EXECUTION_END hook 携带结果前的最后一道保护措施。
     * 设计此方法的原因：
     *   - 引擎内部的值包含 Ref（堆地址引用），这些引用在 hook 回调中
     *     可能因为 GC、堆状态变更等原因变成悬垂引用
     *   - 将复杂值折叠为类型标签字符串（如 <OBJECT>、<FUNCTION>），
     *     避免 hook 消费者误以为拿到的是可操作的对象引用
     *   - 同时也避免了将整个对象图序列化可能导致的循环引用和性能问题
     *
     * @param {*} val - 原始求值结果
     * @returns {*} 安全的结果表示（原始值原样返回，引用值转为标签字符串）
     * @private
     */
    _safeValue(val) {
        if (val === null || val === undefined) return val;
        // Duck-typing 检测引擎内部 Ref
        if (typeof val === 'object' && val !== null && 'address' in val) {
            const entry = this.realm.memory.getEntry(val.address);
            if (!entry) return null;
            // 不暴露内部值，只返回类型标签
            return `<${entry.type}>`;
        }
        return val;
    }
}

// 重导出 HookEvents 枚举，方便调用方在同一个 import 中获取
// 用法: import { JSEngine, HookEvents } from 'js-engine';
export { HookEvents } from './hooks/HookEvents.js';
