/**
 * LexicalEnvironment.js —— 词法环境
 *
 * 对应 ECMA-262 规范 §8.1“词法环境”：
 * 词法环境是一个“作用域”，负责将标识符名映射到具体的变量存储。
 * 它的核心是两个部分：
 *   1. environmentRecord —— 当前作用域内的绑定表（变量名 → 值）
 *   2. outer             —— 指向外层（父级）词法环境的引用，形成作用域链
 *
 * 本实现中，词法环境是一个“壳”，它把声明式环境记录（DeclarativeEnvironmentRecord）
 * 包装起来，并额外持有 outer 链接。这种分层设计的优点在于：
 *
 * - 环境记录（EnvironmentRecord）只关心“如何存/取变量”，不关心作用域层级。
 * - 词法环境（LexicalEnvironment）负责“作用域链”的建立与遍历。
 * - 两者职责分离，使得块级作用域（Block）和全局作用域可以复用同一套
 *   EnvironmentRecord 实现，只需要调整包装方式。
 */

import { DeclarativeEnvironmentRecord } from './EnvironmentRecord.js';

// ─── LexicalEnvironment 类 ──────────────────────────────────────────────

/**
 * 词法环境 —— 规范 §8.1 的实现。
 *
 * 每个执行上下文拥有一个词法环境和一个变量环境（两类各司其职，详见
 * ExecutionContext.js 中的说明）。
 *
 * 作用域链的形成：
 * - 函数执行时，创建一个新的词法环境，outer 指向调用者的词法环境。
 * - 块级作用域（let/const 在 {} 内）同样创建一个新的词法环境，
 *   outer 指向外层环境，但其生命周期通常短于函数。
 */
export class LexicalEnvironment {
    /**
     * 构造一个词法环境。
     *
     * @param {LexicalEnvironment|null} [outer=null] - 外层词法环境（作用域链的上一级）；
     *   全局环境的外层为 null，表示作用域链终点。
     * @param {EnvironmentRecord|null} [record=null] - 环境记录对象；
     *   不传时默认创建一个空的声明式环境记录。
     */
    constructor(outer = null, record = null) {
        /**
         * 当前作用域内的绑定表（变量名 → 值的映射）。
         * @type {EnvironmentRecord}
         */
        this.environmentRecord = record || new DeclarativeEnvironmentRecord();

        /**
         * 外层词法环境的引用，用于形成作用域链。
         * 变量查找时，先在当前 environmentRecord 中找，找不到则递归查找 outer。
         * @type {LexicalEnvironment|null}
         */
        this.outer = outer;
    }

    // ─── 快照 ───────────────────────────────────────────────────────────

    /**
     * 生成用于调试/可视化的可序列化快照。
     *
     * 为什么需要 snapshot？
     * - 运行时的环境记录可能包含宿主 JS 无法直接 JSON 化的结构（循环引用等）。
     * - snapshot 将复杂对象转换为纯数据，便于发送到调试器前端。
     * - 不修改原始数据，仅做“只读”投影。
     *
     * @returns {{ bindings: Object, hasOuter: boolean }} 当前环境的快照数据
     */
    snapshot() {
        return {
            bindings: this.environmentRecord.snapshot(),
            hasOuter: this.outer !== null,
        };
    }
}
