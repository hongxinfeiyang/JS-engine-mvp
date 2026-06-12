/**
 * ExecutionContext.js —— 执行上下文
 *
 * 对应 ECMA-262 规范 §8.3“执行上下文”。
 * 执行上下文是 ES 引擎运行时的核心数据结构——它封装了代码执行
 * 所需的全部状态信息。
 *
 * 每个执行上下文包含：
 *   - 类型（Global / Function / Eval / Block）
 *   - 词法环境（let / const / class 声明的绑定所在）
 *   - 变量环境（var / function 声明的绑定所在）
 *   - this 绑定
 *   - 元数据（函数名、所在文件位置等）
 *
 * 关键设计点：词法环境 与 变量环境 的分离
 * ────────────────────────────────────────
 * 在 ES6+ 中，let/const 和 var 的行为有显著差异：
 *   - var 声明会被提升（hoisted）并初始化为 undefined；
 *   - let/const 被提升但处于“暂时性死区”（TDZ），访问会报错。
 * 为了让这两类声明在一个作用域内共存却有不同的初始化语义，
 * 规范为每个执行上下文维护了两个独立的环境引用：
 *   - LexicalEnvironment   → 管理 let / const / class / 函数参数
 *   - VariableEnvironment  → 管理 var / function 声明
 * 在大多数情况下二者指向同一个词法环境对象；
 * 仅在进入 with 语句或 catch 块时二者会“分叉”。
 */

import { EC_TYPE } from '../types.js';

// ─── ExecutionContext 类 ────────────────────────────────────────────────

/**
 * 执行上下文 —— 规范 §8.3 的实现。
 *
 * 为什么要把这么多信息打包进一个对象？
 * ES 引擎在函数调用、块进入、eval 执行时都需要“保存现场”。
 * 把 lexEnv、varEnv、thisBinding 等封装为单一对象，方便压栈/出栈
 * （参见 ExecutionContextStack），也保证各组件的数据一致性。
 */
export class ExecutionContext {
    /**
     * 创建一个执行上下文。
     *
     * @param {string} type - 上下文的类型（EC_TYPE 枚举值之一）：
     *   'Global' | 'Function' | 'Eval' | 'Block'
     * @param {LexicalEnvironment} lexicalEnvironment - 词法环境（let/const/class）
     * @param {LexicalEnvironment} variableEnvironment - 变量环境（var/function）
     *   注意：在常规情况下，此参数传入同一个 lexEnv 实例；
     *   仅在 with / catch 等特殊场景下，才需要传入不同实例。
     * @param {*} thisBinding - 当前上下文的 this 值
     * @param {Object} [meta={}] - 元数据，例如 { functionName, filename, line }
     *   用于调试 / 堆栈追踪，不参与规范的求值运算。
     */
    constructor(type, lexicalEnvironment, variableEnvironment, thisBinding, meta = {}) {
        /**
         * 上下文类型（'Global' | 'Function' | 'Eval' | 'Block'）。
         * @type {string}
         */
        this.type = type;

        /**
         * 词法环境：let / const / class 声明的绑定在此环境中管理。
         * @type {LexicalEnvironment}
         */
        this.lexicalEnvironment = lexicalEnvironment;

        /**
         * 变量环境：var / function 声明的绑定在此环境中管理。
         * 在大多数执行上下文中，它与 lexicalEnvironment 指向同一对象；
         * 仅在 with / catch 场景下分叉。
         * @type {LexicalEnvironment}
         */
        this.variableEnvironment = variableEnvironment;

        /**
         * 当前上下文的 this 值。
         * @type {*}
         */
        this.thisBinding = thisBinding;

        /**
         * 附加元数据，仅用于调试与可视化。
         * @type {Object}
         */
        this.meta = meta;
    }

    // ─── 快照与调试 ─────────────────────────────────────────────────────

    /**
     * 生成执行上下文的可序列化快照。
     *
     * 包含作用域链中每一层绑定的完整记录，方便在调试器 UI 中
     * 展示“当前可见的所有变量”以及它们来自哪个作用域层级。
     *
     * @returns {Object} 上下文的纯数据快照
     */
    snapshot() {
        return {
            type: this.type,
            ...this.meta,
            thisBinding: this._safeValue(this.thisBinding),
            lexicalEnv: this.lexicalEnvironment.snapshot(),
            variableEnv: this.variableEnvironment.snapshot(),
            scopeChain: this._getScopeChain(),
        };
    }

    /**
     * 遍历作用域链（从当前 lexicalEnvironment 开始，沿 outer 向上），
     * 收集每一层的绑定快照。
     *
     * 为什么在 snapshot 中包含作用域链？
     * 调试时用户需要看到“所有可访问的变量”，而不仅仅是当前层。
     * 作用域链的完整快照让调试器能展示从当前块到全局的所有作用域。
     *
     * @returns {Object[]} 从当前作用域到最外层作用域的绑定数组
     * @private
     */
    _getScopeChain() {
        const chain = [];
        let env = this.lexicalEnvironment;
        while (env) {
            chain.push(env.snapshot().bindings);
            env = env.outer;
        }
        return chain;
    }

    /**
     * 将 thisBinding 转换成安全的可序列化形式。
     *
     * 为什么要这样做？
     * thisBinding 可能是宿主 JS 对象（例如在浏览器环境中是 window），
     * 直接 JSON.stringify 会抛出循环引用错误或丢失信息。
     * 这里简单地将对象转为占位字符串，避免序列化崩溃。
     *
     * @param {*} val - thisBinding 的值
     * @returns {*} 安全的可序列化值
     * @private
     */
    _safeValue(val) {
        if (val === null || val === undefined) return val;
        if (typeof val === 'object') return '<object>';
        return val;
    }
}
