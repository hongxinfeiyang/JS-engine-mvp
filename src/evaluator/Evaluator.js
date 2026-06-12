/**
 * ===========================================================================
 * Evaluator — AST 解释器核心 (The Heart of the JS Engine)
 * ===========================================================================
 *
 * 【职责】
 * 递归遍历 AST 并执行每个节点，实现 ECMAScript 规范的运行时语义。它是整个引擎
 * 中唯一理解"如何执行代码"的模块 —— 其他模块（Parser、Memory、EC Stack）都
 * 是为它服务的。
 *
 * 【架构】
 * 本类采用"大 switch 分发"模式（evaluate 方法），按 node.type 路由到对应
 * 的 _eval* 私有方法。这种设计之所以选择 switch 而非访问者模式，原因是：
 *   - 节点类型有限（约 20 种），switch 可读性最优
 *   - 避免为每种节点创建 visit 方法的样板代码
 *   - 所有求值逻辑集中在一个文件，便于理解数据流
 *
 * 【关键设计决策索引】（对应规范中的关键语义）
 *   1. RETURN_SENTINEL   — 用 Symbol 哨兵而非异常传播 return（见文件顶部）
 *   2. Hoisting 两阶段   — 先扫描声明创建绑定，再执行初始化（见 _hoistDeclarations）
 *   3. LE vs VE 分离     — 函数 EC 中 LE=VE，块 EC 中 LE≠VE（见 _evalBlockStatement）
 *   4. var 在 for 中提升  — var 需穿透块作用域提升到外层函数（见 _evalForStatement）
 *   5. call/apply/bind   — 在调用点检测而非设为函数属性（见 _evalCallExpression）
 *   6. 箭头函数 this 捕获 — 定义时存 capturedThis，调用时忽略传入的 this（见 _evalArrowFunction）
 *   7. bind 返回新函数   — type='bound'，合并参数（见 _handleCallApplyBind）
 *   8. MemberExpression   — obj.prop = val 需独立代码路径（见 _evalAssignmentExpression）
 *   9. 作用域链查找方向   — 从当前 LE 向外遍历（见 _resolveIdentifier）
 *  10. _safeHookValue    — 避免循环引用导致 JSON.stringify 崩溃（见文件末尾）
 *
 * @class Evaluator
 */

import { NODE_TYPE, VARIABLE_KIND, VALUE_TYPE, THIS_PATTERN, EC_TYPE } from '../types.js';
import { HookEvents } from '../hooks/HookEvents.js';
import { LexicalEnvironment } from '../runtime/LexicalEnvironment.js';
import { DeclarativeEnvironmentRecord } from '../runtime/EnvironmentRecord.js';
import { ExecutionContext } from '../runtime/ExecutionContext.js';
import { isReference, makeRef, getRefAddress, isTruthy } from '../runtime/Value.js';

// ─── RETURN_SENTINEL：return 语句的传播机制 ──────────────────────────────────
//
// 【为什么用 Symbol 哨兵而不是 throw？】
//
// 在 ECMAScript 中，return 语句需要穿透多层函数体 / 块语句 / if-else，
// 但不能穿透函数边界。常见的实现方案有两种：
//
//   A) throw + try-catch：在函数入口 try，return 时 throw 一个特殊异常，
//      在 catch 中提取返回值。问题是：
//        - 会捕获并压制真正的异常（需要区分"return 异常"和"真异常"）
//        - 性能差：throw 需要展开调用栈、收集 stack trace
//        - 会把正常的控制流和异常控制流混在一起，调试困难
//
//   B) Symbol 哨兵：return 时返回一个 `{ [RETURN_SENTINEL]: true, value }` 对象，
//      每个语句执行者检查返回值上是否存在该 key。优势：
//        - 零开销：只是一个属性检查，不涉及异常机制
//        - 不会干扰真正的 throw/catch
//        - 函数边界自然隔离：新函数调用 `_applyFunction` 的循环不会传递哨兵出去
//
// 注意：哨兵仅在 _evalStatements 循环和各语句方法内部传播。_applyFunction
//       中解包哨兵为普通 value，所以它永远不会"泄漏"到调用者。
//
const RETURN_SENTINEL = Symbol('return');

export class Evaluator {
    /**
     * @param {Object} realm  - 全局 Realm，持有 memory、ecStack、globalObject 等
     * @param {Object} hooks - 事件钩子系统，用于调试/可视化/测试注入
     */
    constructor(realm, hooks) {
        this.realm = realm;
        this.memory = realm.memory;
        this.ecStack = realm.ecStack;
        this.hooks = hooks;
    }

    /**
     * =========================================================================
     * evaluate() — AST 节点分发器（唯一的公共入口）
     * =========================================================================
     *
     * 所有代码执行都从这里进入。它像一个"交通指挥员"，根据 node.type 将 AST
     * 节点路由到对应的 _eval* 私有方法。
     *
     * 【为什么用一个大 switch 而不是拆成多个 visit 方法？】
     * 见文件顶部的架构说明。核心理由：节点类型有限、可读性最优、便于追踪数据流。
     *
     * 【Hook 机制】
     * 每个节点在求值前后都会触发钩子事件（EVAL_NODE_ENTER / EVAL_NODE_EXIT），
     * 这让外部工具可以：
     *   - 可视化 AST 遍历过程
     *   - 在特定节点注入自定义行为
     *   - 记录性能 / 覆盖率数据
     *
     * @param {Object} node - AST 节点，必须有 type 属性
     * @returns {*} 节点的求值结果
     */
    evaluate(node) {
        if (!node) return undefined;

        this.hooks.emit(HookEvents.EVAL_NODE_ENTER, { type: node.type, id: node.id });

        let result;
        switch (node.type) {
            // ─── 程序入口 ───
            case NODE_TYPE.PROGRAM: result = this._evalProgram(node); break;

            // ─── 语句 ───
            case NODE_TYPE.BLOCK_STATEMENT: result = this._evalBlockStatement(node); break;
            case NODE_TYPE.VARIABLE_DECLARATION: result = this._evalVariableDeclaration(node); break;
            case NODE_TYPE.FUNCTION_DECLARATION: result = this._evalFunctionDeclaration(node); break;
            case NODE_TYPE.FUNCTION_EXPRESSION: result = this._evalFunctionExpression(node); break;
            case NODE_TYPE.EXPRESSION_STATEMENT: result = this.evaluate(node.expression); break;
            case NODE_TYPE.RETURN_STATEMENT: result = this._evalReturnStatement(node); break;
            case NODE_TYPE.IF_STATEMENT: result = this._evalIfStatement(node); break;
            case NODE_TYPE.FOR_STATEMENT: result = this._evalForStatement(node); break;
            case NODE_TYPE.WHILE_STATEMENT: result = this._evalWhileStatement(node); break;

            // ─── 表达式 ───
            case NODE_TYPE.LITERAL: result = node.value; break;
            case NODE_TYPE.IDENTIFIER: result = this._evalIdentifier(node); break;
            case NODE_TYPE.BINARY_EXPRESSION: result = this._evalBinaryExpression(node); break;
            case NODE_TYPE.LOGICAL_EXPRESSION: result = this._evalLogicalExpression(node); break;
            case NODE_TYPE.UNARY_EXPRESSION: result = this._evalUnaryExpression(node); break;
            case NODE_TYPE.ASSIGNMENT_EXPRESSION: result = this._evalAssignmentExpression(node); break;
            case NODE_TYPE.CALL_EXPRESSION: result = this._evalCallExpression(node); break;
            case NODE_TYPE.MEMBER_EXPRESSION: result = this._evalMemberExpression(node); break;
            case NODE_TYPE.THIS_EXPRESSION: result = this._evalThisExpression(); break;
            case NODE_TYPE.NEW_EXPRESSION: result = this._evalNewExpression(node); break;
            case NODE_TYPE.OBJECT_EXPRESSION: result = this._evalObjectExpression(node); break;
            case NODE_TYPE.ARRAY_EXPRESSION: result = this._evalArrayExpression(node); break;
            case NODE_TYPE.ARROW_FUNCTION_EXPRESSION: result = this._evalArrowFunction(node); break;
            case NODE_TYPE.UPDATE_EXPRESSION: result = this._evalUpdateExpression(node); break;
            case NODE_TYPE.CONDITIONAL_EXPRESSION: result = this._evalConditionalExpression(node); break;
            default:
                throw new Error(`Unknown node type: ${node.type}`);
        }

        this.hooks.emit(HookEvents.EVAL_NODE_EXIT, { type: node.type, id: node.id, result: this._safeHookValue(result) });
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 语句求值 (Statement Evaluators)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * 求值 Program 节点（AST 根节点）。
     *
     * 【执行流程 — 显式两阶段】
     *   Phase 1（创建阶段）— 扫描整个程序体，提升（hoist）var/function 声明到 VE
     *   Phase 2（执行阶段）— 逐条执行语句
     *
     * ECMAScript 规范中，每个执行上下文都有 Creation Phase 和 Execution Phase。
     * 这里通过 hook 显式标记两个阶段的边界，使外部调试工具可以：
     *   - 在创建阶段结束后、执行阶段开始前检查环境快照
     *   - 精确测量 hoisting 和执行各自耗时
     *
     * @param {Object} node - Program AST 节点
     * @returns {*} 程序执行结果
     */
    _evalProgram(node) {
        // ═══════════════════════════════════════════════════════
        // Phase 1: 创建阶段（Creation Phase）
        //   创建绑定但不执行代码 —— var 获得 undefined，let/const 进入 TDZ，
        //   function 完整初始化。此阶段不产生任何用户可见的副作用。
        // ═══════════════════════════════════════════════════════
        this.hooks.emit(HookEvents.CONTEXT_CREATION_START, {
            type: 'global',
            name: 'global',
        });
        this._hoistDeclarations(node.body, this.ecStack.current().variableEnvironment);
        this.hooks.emit(HookEvents.CONTEXT_CREATION_END, {
            type: 'global',
            name: 'global',
            envSnapshot: this.ecStack.current().variableEnvironment.snapshot(),
        });

        // ═══════════════════════════════════════════════════════
        // Phase 2: 执行阶段（Execution Phase）
        //   逐条执行语句，变量声明到达时完成 let/const 的初始化
        //   （var 在 Phase 1 已初始化为 undefined，Phase 2 只做赋值）
        // ═══════════════════════════════════════════════════════
        return this._evalStatements(node.body);
    }

    /**
     * 求值 BlockStatement 节点（{ ... }）。
     *
     * =========================================================================
     * 【设计决策：LE ≠ VE —— 块作用域的实现核心】
     * =========================================================================
     *
     * 在 ECMAScript 中，let / const 声明的变量只存在于块作用域内，而 var 声明
     * 的变量会"穿透"块，提升到最近的函数或全局作用域。为了用 EC（执行上下文）
     * 结构模拟这一行为，块 EC 的设计是：
     *
     *   blockEC.lexicalEnvironment  = 新的 LE（let/const 生于斯、死于斯）
     *   blockEC.variableEnvironment = 外层函数的 VE（var 穿透块，直接挂到外层）
     *
     * 对比：
     *   函数 EC：LE === VE（都是新创建的，因为函数是 var 的作用域边界）
     *   块   EC：LE !== VE（VE 继承外层，LE 是新生儿）
     *
     * 作用域链查找时，从 LE 开始，通过 outer 链向上。let/const 只在当前 LE，
     * var 在外层 VE（通过 outer 链可达），从而自然实现了 let/const 的块级作用域
     * 和 var 的函数级作用域。
     *
     * @param {Object} node - BlockStatement AST 节点
     * @returns {*} 块执行结果（可能包含 RETURN_SENTINEL）
     */
    _evalBlockStatement(node) {
        const currentEC = this.ecStack.current();

        // 创建新的词法环境，其 outer 指向当前 LE（维持作用域链的连续性）
        const blockEnv = new LexicalEnvironment(
            currentEC.lexicalEnvironment // outer 是当前 LE（维持作用域链）
        );

        // 关键：块 EC 的 VE 指向外层函数的 VE，而非新建的 blockEnv
        // 这确保了 var 声明从不会"进入"块作用域
        const blockEC = new ExecutionContext(
            EC_TYPE.BLOCK,
            blockEnv,                         // LE = 新块环境（let/const 的去处）
            currentEC.variableEnvironment,     // VE = 外层函数的 VE（var 的去处）
            currentEC.thisBinding,
            { name: 'block' }
        );

        // Phase 1: 提升声明
        // let/const → blockEnv（块作用域）
        // var → currentEC.variableEnvironment（穿透到外层函数/全局作用域）
        this._hoistDeclarations(node.body, blockEnv, currentEC.variableEnvironment);

        this.ecStack.push(blockEC);
        this.hooks.emit(HookEvents.CONTEXT_PUSH, blockEC.snapshot());

        const result = this._evalStatements(node.body);

        this.ecStack.pop();
        this.hooks.emit(HookEvents.CONTEXT_POP, { type: 'block' });

        return result;
    }

    /**
     * 求值变量声明（var / let / const）。
     *
     * 【执行时机】
     * 此方法在"执行阶段"被调用（AST 遍历到声明语句时）。hoisting 已在 Phase 1
     * 创建了绑定，这里只负责"初始化"——将 init 表达式的求值结果写入绑定。
     *
     * 【为什么要分两个阶段】
     *   - let/const: Phase 1 创建未初始化的绑定（TDZ），Phase 2 在到达声明行时初始化
     *   - var: Phase 1 创建并初始化为 undefined，Phase 2 在到达声明行时赋实际值
     *   这种设计让开发者可以"感知"到 hoisting：var 在声明前访问得到 undefined，
     *   let 在声明前访问触发 TDZ（hasUninitializedBinding 拦截）。
     *
     * @param {Object} node - VariableDeclaration AST 节点
     * @returns {undefined} 声明语句不产生值
     */
    _evalVariableDeclaration(node) {
        // 根据 var / let / const 选择目标环境（穿到函数域还是留在块域）
        // 注意：声明（创建绑定）已在 hoisting 阶段完成，不在此重复触发 VARIABLE_DECLARE
        const env = this._getEnvForKind(node.kind);
        for (const decl of node.declarations) {
            const name = decl.id.name;

            if (decl.init) {
                // 有初始值：求值并完成初始化（let/const 由此退出 TDZ，var 更新已初始化的值）
                const value = this.evaluate(decl.init);
                env.environmentRecord.initializeBinding(name, value);

                this.hooks.emit(HookEvents.VARIABLE_ASSIGN, {
                    name,
                    kind: node.kind,
                    newValue: this._safeHookValue(value),
                });
            } else if (node.kind !== VARIABLE_KIND.VAR) {
                // let / const 无初始值（如 `let y;`）：初始化为 undefined 以退出 TDZ
                // var 已在 hoisting 阶段初始化为 undefined，无需重复处理
                env.environmentRecord.initializeBinding(name, undefined);
            }
        }
        return undefined;
    }

    /**
     * 求值函数声明。
     *
     * 【与函数表达式的区别】
     * 函数声明作为"语句"出现（function foo(){} 在语句位置），有两个特性：
     *   1. 会被 hoisting 提升：Phase 1 创建绑定并初始化为函数对象
     *   2. 名称进入所在作用域（VE）
     *
     * 函数表达式作为"表达式"出现（var f = function(){}），左值通过 var 声明
     * 提升，但右值（函数对象）在赋值时才创建——这是两者最关键的区别。
     *
     * 此方法处理的是语句位置的函数声明。如果 hoisting 阶段已创建（通常是），
     * 这里跳过。如果在 if/block 中作为语句出现且尚未绑定，则在此处创建。
     *
     * @param {Object} node - FunctionDeclaration AST 节点
     * @returns {undefined} 函数声明不产生值
     */
    _evalFunctionDeclaration(node) {
        // 函数声明在 hoisting 阶段已处理，但如果出现在 if/block 内且尚未绑定则在此处理
        const env = this.ecStack.current().variableEnvironment;
        const name = node.id.name;

        // 双重检查：未绑定且不在 TDZ 中，才创建函数对象并初始化
        if (!env.environmentRecord.hasBinding(name) && !env.environmentRecord.hasUninitializedBinding(name)) {
            const funcObj = this._createFunctionObject(node, this.ecStack.current().lexicalEnvironment);
            env.environmentRecord.createMutableBinding(name, false);
            env.environmentRecord.initializeBinding(name, funcObj);
        }
        return undefined;
    }

    /**
     * 求值函数表达式（var f = function(){} 中的右值部分）。
     *
     * 【闭包原理】
     * 函数对象的 [[Environment]]（closure 字段）被设为当前 LE。
     * 这意味着函数对象"记住"了它被创建时的作用域链。当函数在别处被调用时，
     * 新创建的 LE 的 outer 指向这个保存的 closure，从而形成闭包。
     *
     * 注意：这里只创建函数对象，不把名称加入作用域（那是变量声明的职责）。
     *
     * @param {Object} node - FunctionExpression AST 节点
     * @returns {Object} Ref<FunctionObject>
     */
    _evalFunctionExpression(node) {
        return this._createFunctionObject(node, this.ecStack.current().lexicalEnvironment);
    }

    /**
     * 求值 return 语句。
     *
     * 【哨兵模式】
     * 返回一个 `{ [RETURN_SENTINEL]: true, value }` 对象。
     * 所有 _evalStatements 循环检查该标记来中断执行并向上传播。
     * _applyFunction 在函数结束时取出 value 并丢弃哨兵，
     * 所以哨兵绝不会"泄漏"到函数外部。
     *
     * @param {Object} node - ReturnStatement AST 节点
     * @returns {Object} RETURN_SENTINEL 包裹对象
     */
    _evalReturnStatement(node) {
        const value = node.argument ? this.evaluate(node.argument) : undefined;
        return { [RETURN_SENTINEL]: true, value };
    }

    /**
     * 求值 if 语句。短路求值：只执行走到的分支。
     *
     * @param {Object} node - IfStatement AST 节点
     * @returns {*} 执行分支的结果（可能包含 RETURN_SENTINEL）
     */
    _evalIfStatement(node) {
        const test = this.evaluate(node.test);
        if (isTruthy(test)) {
            return this.evaluate(node.consequent);
        } else if (node.alternate) {
            return this.evaluate(node.alternate);
        }
        return undefined;
    }

    /**
     * 求值 for 循环。
     *
     * =========================================================================
     * 【设计决策：var 在 for 循环 init 中的特殊处理】
     * =========================================================================
     *
     * for (var i = 0; ...) 和 for (let i = 0; ...) 的作用域行为不同：
     *
     *   for (let i = 0; ...; ...)  {}
     *   // i 存在于 for 循环块作用域内，循环外不可访问
     *
     *   for (var i = 0; ...; ...)  {}
     *   // i 被提升到外层函数 / 全局作用域，循环外仍可访问
     *
     * 实现方式：
     *   - let/const init → 提升到 for 循环自己的块 LE
     *   - var init       → 跳过 for 循环的 LE，直接提升到外层函数的 VE
     *                     通过 _getEnvForKind(VAR) 向上查找函数/全局 EC
     *
     * 这就是为什么 var 在 for 中不创建块级绑定 —— hoisting 收到 VAR 类型后，
     * 沿 EC 栈向上跳过了所有块 EC，直到找到函数或全局 EC 的 VE。
     *
     * @param {Object} node - ForStatement AST 节点
     * @returns {*} 循环体结果（可能包含 RETURN_SENTINEL）
     */
    _evalForStatement(node) {
        // 为 let/const 创建 for 循环块作用域
        const currentEC = this.ecStack.current();
        const loopEnv = new LexicalEnvironment(currentEC.lexicalEnvironment);
        const loopEC = new ExecutionContext(
            EC_TYPE.BLOCK,
            loopEnv,
            currentEC.variableEnvironment,
            currentEC.thisBinding,
            { name: 'for' }
        );

        this.ecStack.push(loopEC);
        this.hooks.emit(HookEvents.CONTEXT_PUSH, loopEC.snapshot());

        let result;

        // Init
        if (node.init) {
            if (node.init.type === NODE_TYPE.VARIABLE_DECLARATION) {
                const kind = node.init.kind;
                if (kind === VARIABLE_KIND.VAR) {
                    // 【关键】var 穿透块作用域，提升到外层函数 / 全局
                    const targetEnv = this._getEnvForKind(VARIABLE_KIND.VAR);
                    this._hoistOneDeclaration(node.init, targetEnv);
                } else {
                    // let / const 留在 for 循环自己的块作用域
                    this._hoistOneDeclaration(node.init, loopEnv);
                }
            }
            this.evaluate(node.init);
        }

        while (true) {
            // Test —— 条件为假则退出循环
            if (node.test) {
                const testVal = this.evaluate(node.test);
                if (!isTruthy(testVal)) break;
            }

            // Body —— 执行循环体
            result = this.evaluate(node.body);
            // 如果循环体中有 return，将哨兵向上传播
            if (result && result[RETURN_SENTINEL]) break;

            // Update —— 执行递增/递减表达式
            if (node.update) {
                this.evaluate(node.update);
            }
        }

        this.ecStack.pop();
        this.hooks.emit(HookEvents.CONTEXT_POP, { type: 'for' });

        return result && result[RETURN_SENTINEL] ? result : undefined;
    }

    /**
     * 求值 while 循环。与 for 循环的 body 执行逻辑完全一致。
     *
     * @param {Object} node - WhileStatement AST 节点
     * @returns {*} 循环体结果（可能包含 RETURN_SENTINEL）
     */
    _evalWhileStatement(node) {
        let result;
        while (true) {
            const testVal = this.evaluate(node.test);
            if (!isTruthy(testVal)) break;

            result = this.evaluate(node.body);
            // 循环体中的 return 通过哨兵传播
            if (result && result[RETURN_SENTINEL]) break;
        }
        return result && result[RETURN_SENTINEL] ? result : undefined;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 表达式求值 (Expression Evaluators)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * 求值标识符 —— 在作用域链中查找变量名。
     *
     * @param {Object} node - Identifier AST 节点
     * @returns {*} 变量的值
     */
    _evalIdentifier(node) {
        return this._resolveIdentifier(node.name);
    }

    /**
     * 求值二元表达式（+ - * / % 和各种比较运算符）。
     *
     * @param {Object} node - BinaryExpression AST 节点
     * @returns {*} 运算结果
     */
    _evalBinaryExpression(node) {
        const left = this.evaluate(node.left);
        const right = this.evaluate(node.right);

        switch (node.operator) {
            case '+': return this._add(left, right);
            case '-': return left - right;
            case '*': return left * right;
            case '/': return left / right;
            case '%': return left % right;
            case '==': return left == right;
            case '!=': return left != right;
            case '===': return left === right;
            case '!==': return left !== right;
            case '>': return left > right;
            case '>=': return left >= right;
            case '<': return left < right;
            case '<=': return left <= right;
            default: throw new Error(`Unknown operator: ${node.operator}`);
        }
    }

    /**
     * 求值逻辑表达式（&& 和 ||）。
     *
     * 【短路求值】
     *   - &&: 左值为假 → 直接返回左值，不计算右值
     *   - ||: 左值为真 → 直接返回左值，不计算右值
     * 与 JS 原生语义一致：返回最后一个被求值的操作数，而非布尔值。
     *
     * @param {Object} node - LogicalExpression AST 节点
     * @returns {*} 最后一个求值的操作数的值
     */
    _evalLogicalExpression(node) {
        const left = this.evaluate(node.left);
        if (node.operator === '&&') {
            return isTruthy(left) ? this.evaluate(node.right) : left;
        } else { // ||
            return isTruthy(left) ? left : this.evaluate(node.right);
        }
    }

    /**
     * 求值一元表达式（! - typeof）。
     *
     * @param {Object} node - UnaryExpression AST 节点
     * @returns {*} 运算结果
     */
    _evalUnaryExpression(node) {
        const arg = this.evaluate(node.argument);
        switch (node.operator) {
            case '!': return !isTruthy(arg);
            case '-': return -arg;
            case 'typeof': return this._typeof(arg);
            default: throw new Error(`Unknown unary operator: ${node.operator}`);
        }
    }

    /**
     * 求值赋值表达式（= += -= *=）。
     *
     * =========================================================================
     * 【设计决策：MemberExpression 左值需要独立的赋值路径】
     * =========================================================================
     *
     * JS 中有两类赋值目标：
     *
     *   A) 简单标识符：x = 1
     *      → 在作用域链中找 x 的环境记录，调用 setMutableBinding
     *
     *   B) 属性访问（MemberExpression）：obj.prop = 1  /  this.prop = 1
     *      → 先求值 obj（获取引用），再通过 memory 写入对象的 properties Map
     *      → 这不是"环境记录"层面的操作，而是对象属性操作
     *
     * 为什么不能合并为一条路径？
     *   因为标识符赋值操作的是 LexicalEnvironment 中的绑定，
     *   而属性赋值操作的是堆中 Object 的 properties Map。
     *   两者的底层存储机制完全不同（EnvRecord vs Memory Heap），
     *   必须分开处理。
     *
     * 复合赋值（+= 等）：先读取旧值，计算 newValue，再写入。
     *
     * @param {Object} node - AssignmentExpression AST 节点
     * @returns {*} 赋值后的新值
     */
    _evalAssignmentExpression(node) {
        let right = this.evaluate(node.right);

        // ─── 路径 A：MemberExpression 左值 —— obj.prop = value ───
        if (node.left.type === NODE_TYPE.MEMBER_EXPRESSION) {
            const obj = this.evaluate(node.left.object);
            if (!isReference(obj)) {
                throw new TypeError('Cannot set property of ' + String(obj));
            }
            const prop = node.left.computed ? this.evaluate(node.left.property) : node.left.property.name;
            const entry = this.memory.getEntry(getRefAddress(obj));

            if (entry.type === VALUE_TYPE.OBJECT) {
                const oldValue = entry.value.properties.get(prop);
                let newValue = right;
                switch (node.operator) {
                    case '=': break;
                    case '+=': newValue = oldValue + right; break;
                    case '-=': newValue = oldValue - right; break;
                    case '*=': newValue = oldValue * right; break;
                }
                // 直接操作对象的 properties Map——不走环境记录
                entry.value.properties.set(prop, newValue);
                this.hooks.emit(HookEvents.VARIABLE_ASSIGN, {
                    name: `${prop}`,
                    oldValue: this._safeHookValue(oldValue),
                    newValue: this._safeHookValue(newValue),
                });
                return newValue;
            }

            throw new TypeError('Cannot set property on non-object');
        }

        // ─── 路径 B：简单标识符左值 —— x = value ───
        const name = node.left.name;
        if (!name) {
            throw new ReferenceError('Invalid left-hand side in assignment');
        }

        // 在作用域链中查找标识符所属的环境记录
        const { environment } = this._resolveIdentifierWithEnv(name);
        const oldValue = environment.environmentRecord.getBindingValue(name);

        let newValue = right;
        switch (node.operator) {
            case '=': break;
            case '+=': newValue = oldValue + right; break;
            case '-=': newValue = oldValue - right; break;
            case '*=': newValue = oldValue * right; break;
            default: throw new Error(`Unknown assignment operator: ${node.operator}`);
        }

        // 通过环境记录更新绑定值
        environment.environmentRecord.setMutableBinding(name, newValue);

        this.hooks.emit(HookEvents.VARIABLE_ASSIGN, {
            name,
            oldValue: this._safeHookValue(oldValue),
            newValue: this._safeHookValue(newValue),
        });

        return newValue;
    }

    /**
     * 求值函数调用表达式（fn() / obj.method() / fn.call() 等）。
     *
     * =========================================================================
     * 【设计决策：为什么在调用点检测 call/apply/bind 而非设为函数属性？】
     * =========================================================================
     *
     * 在真正的 JS 引擎中，call/apply/bind 是 Function.prototype 上的方法，
     * 通过原型链查找调用。在这个教学引擎中，我们简化了这一机制：
     *
     *   方案 A（未采用）：给每个函数对象的 properties 里放 call/apply/bind
     *     - 问题：属性查找走 memory 路径，与普通调用路径割裂
     *     - 需要为每个函数对象复制这三个方法，浪费内存
     *
     *   方案 B（采用）：在 _evalCallExpression 中检测 MemberExpression 的
     *     属性名是否为 call/apply/bind
     *     - 优势：零额外内存、逻辑集中在调用点、语义清晰
     *     - 代价：硬编码了这三个方法名，但在这个教学规模下是可接受的
     *
     * 检测流程：
     *   1. 如果 callee 是 obj.call / obj.apply / obj.bind 形式
     *   2. 进入 _handleCallApplyBind，手动提取 targetFunc 和 thisArg
     *   3. 对于 call/apply，直接调用 targetFunc；对于 bind，创建 bound 函数
     *
     * @param {Object} node - CallExpression AST 节点
     * @returns {*} 函数调用的返回值
     */
    _evalCallExpression(node) {
        // 特殊检测：fn.call(thisArg, ...) / fn.apply(thisArg, [args]) / fn.bind(thisArg, ...)
        if (node.callee.type === NODE_TYPE.MEMBER_EXPRESSION) {
            const propName = node.callee.computed
                ? this.evaluate(node.callee.property)
                : node.callee.property.name;

            if (propName === 'call' || propName === 'apply' || propName === 'bind') {
                return this._handleCallApplyBind(node, propName);
            }
        }

        // 普通函数调用：先求值 callee，再求值参数（符合 ES 规范求值顺序）
        let calleeResult, thisValue;

        if (node.callee.type === NODE_TYPE.MEMBER_EXPRESSION) {
            // 方法调用（如 console.log(x)）：求值 base object 一次，复用于成员访问和 this 绑定
            const baseObj = this.evaluate(node.callee.object);
            calleeResult = this._evalMemberExpression(node.callee, baseObj);
            const args = node.args.map(a => this.evaluate(a));
            thisValue = this._resolveThisForCall(node.callee, calleeResult, baseObj);
            return this._applyFunction(calleeResult, args, thisValue);
        }

        calleeResult = this.evaluate(node.callee);
        const args = node.args.map(a => this.evaluate(a));
        thisValue = this._resolveThisForCall(node.callee, calleeResult);
        return this._applyFunction(calleeResult, args, thisValue);
    }

    /**
     * 求值成员表达式（obj.prop 或 obj[expr]）。
     *
     * 支持对象属性访问和数组元素访问（含 length）。
     *
     * @param {Object} node - MemberExpression AST 节点
     * @returns {*} 属性值
     */
    _evalMemberExpression(node, preEvaluatedObject) {
        const obj = preEvaluatedObject !== undefined ? preEvaluatedObject : this.evaluate(node.object);
        if (!isReference(obj)) {
            throw new TypeError('Cannot read properties of ' + String(obj));
        }

        const prop = node.computed ? this.evaluate(node.property) : node.property.name;
        const entry = this.memory.getEntry(getRefAddress(obj));

        if (entry.type === VALUE_TYPE.OBJECT) {
            return entry.value.properties.get(prop);
        }
        if (entry.type === VALUE_TYPE.ARRAY) {
            if (prop === 'length') return entry.value.elements.length;
            const idx = Number(prop);
            return entry.value.elements[idx];
        }

        return undefined;
    }

    /**
     * 求值 this 表达式。
     *
     * this 的值来源于当前执行上下文的 thisBinding，它在 EC 创建时就被确定。
     * 不同类型的 EC 有不同的 thisBinding 来源：
     *   - 全局 EC：this = globalObject
     *   - 函数 EC：this 取决于调用方式（方法调用 / 显式绑定 / 箭头函数等）
     *   - 块   EC：this 继承外层 EC
     *
     * @returns {*} 当前 this 绑定值
     */
    _evalThisExpression() {
        const thisBinding = this.ecStack.current().thisBinding;
        this.hooks.emit(HookEvents.THIS_RESOLVE, {
            pattern: this._getThisPattern(),
            value: this._safeHookValue(thisBinding),
        });
        return thisBinding;
    }

    /**
     * 求值 new 表达式。
     *
     * 【new 的三步曲】
     *   1. 创建一个空对象（在 Memory 中分配）
     *   2. 以该空对象为 this 调用构造函数
     *   3. 如果构造函数返回对象，返回该对象；否则返回新创建的空对象
     *
     * 这与 ES 规范 [[Construct]] 的内部方法一致。
     *
     * @param {Object} node - NewExpression AST 节点
     * @returns {Object} Ref<Object>
     */
    _evalNewExpression(node) {
        const callee = this.evaluate(node.callee);
        const args = node.args.map(a => this.evaluate(a));

        if (!isReference(callee)) {
            throw new TypeError(`${String(callee)} is not a constructor`);
        }

        // Step 1: 创建新对象
        const newObjAddr = this.memory.allocate(VALUE_TYPE.OBJECT, { properties: new Map() });
        const newObj = makeRef(newObjAddr);

        // Step 2: 以新对象为 this 调用构造函数
        this.hooks.emit(HookEvents.THIS_RESOLVE, { pattern: THIS_PATTERN.NEW, value: '<new object>' });
        const result = this._applyFunction(callee, args, newObj);

        // Step 3: 如果构造函数返回引用类型，使用返回值；否则使用新对象
        if (isReference(result)) return result;
        return newObj;
    }

    /**
     * 求值对象字面量表达式（{ key: value, ... }）。
     *
     * 在 Memory 堆中分配 Object 类型的数据，填充 properties Map。
     *
     * @param {Object} node - ObjectExpression AST 节点
     * @returns {Object} Ref<Object>
     */
    _evalObjectExpression(node) {
        const props = new Map();
        for (const prop of node.properties) {
            const key = prop.key.type === NODE_TYPE.IDENTIFIER ? prop.key.name :
                                    prop.key.type === NODE_TYPE.LITERAL ? String(prop.key.value) :
                                    this.evaluate(prop.key);
            const value = this.evaluate(prop.value);
            props.set(key, value);
        }
        const addr = this.memory.allocate(VALUE_TYPE.OBJECT, { properties: props });
        return makeRef(addr);
    }

    /**
     * 求值数组字面量表达式（[elem1, elem2, ...]）。
     *
     * @param {Object} node - ArrayExpression AST 节点
     * @returns {Object} Ref<Array>
     */
    _evalArrayExpression(node) {
        const elements = node.elements.map(e => this.evaluate(e));
        const addr = this.memory.allocate(VALUE_TYPE.ARRAY, { elements });
        return makeRef(addr);
    }

    /**
     * 求值箭头函数表达式（() => { ... }）。
     *
     * =========================================================================
     * 【设计决策：capturedThis —— 箭头函数的 this 在定义时确定】
     * =========================================================================
     *
     * 箭头函数与普通函数在 this 上的根本区别：
     *
     *   普通函数：this 在调用时动态确定（取决于调用方式）
     *     func()       → this = globalObject（非严格模式）
     *     obj.func()   → this = obj
     *     func.call(x) → this = x
     *
     *   箭头函数：this 在定义时静态捕获（词法 this）
     *     const f = () => { ... }  ← 定义时，当前 EC 的 thisBinding 被捕获
     *     f()             → this 仍是定义时的值，调用方式不影响
     *     obj.f = f; obj.f() → this 仍是定义时的值，obj 被忽略
     *
     * 实现方式：
     *   - 定义箭头函数时，将当前 EC 的 thisBinding 存入 capturedThis
     *   - _applyFunction 中检查 funcObj.type === 'arrow'，忽略传入的 thisValue，
     *     直接使用 funcObj.capturedThis
     *
     * 这模拟了 ES 规范中箭头函数没有 [[ThisMode]]（或 [[ThisMode]] = lexical）
     * 的行为。
     *
     * @param {Object} node - ArrowFunctionExpression AST 节点
     * @returns {Object} Ref<ArrowFunctionObject>
     */
    _evalArrowFunction(node) {
        // 捕获定义时的词法环境（闭包）和 this 绑定
        const closureEnv = this.ecStack.current().lexicalEnvironment;
        const capturedThis = this.ecStack.current().thisBinding;

        const funcObj = {
            type: 'arrow',
            name: '',
            params: node.params.map(p => p.name),
            body: node.body,
            closure: closureEnv,          // [[Environment]]：闭包链
            capturedThis: capturedThis,   // [[ThisMode]] = lexical
        };

        const addr = this.memory.allocate(VALUE_TYPE.FUNCTION, funcObj);

        this.hooks.emit(HookEvents.CLOSURE_CREATE, {
            funcName: '(arrow)',
            capturedVars: Object.keys(closureEnv.environmentRecord.snapshot()),
        });

        return makeRef(addr);
    }

    /**
     * 求值更新表达式（++i / --i / i++ / i--）。
     *
     * @param {Object} node - UpdateExpression AST 节点
     * @returns {number} prefix 返回新值，postfix 返回旧值
     */
    _evalUpdateExpression(node) {
        const { environment } = this._resolveIdentifierWithEnv(node.argument.name);
        const name = node.argument.name;
        const oldValue = environment.environmentRecord.getBindingValue(name);
        const delta = node.operator === '++' ? 1 : -1;
        const newValue = oldValue + delta;

        environment.environmentRecord.setMutableBinding(name, newValue);

        this.hooks.emit(HookEvents.VARIABLE_ASSIGN, {
            name,
            oldValue,
            newValue,
        });

        // prefix: 先增后返回; postfix: 先返回后增
        return node.prefix ? newValue : oldValue;
    }

    /**
     * 求值条件表达式（test ? consequent : alternate）。
     *
     * 只求值走到的分支（短路）。
     *
     * @param {Object} node - ConditionalExpression AST 节点
     * @returns {*} 被选中分支的求值结果
     */
    _evalConditionalExpression(node) {
        const test = this.evaluate(node.test);
        return isTruthy(test) ? this.evaluate(node.consequent) : this.evaluate(node.alternate);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 辅助方法 (Helpers)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * 顺序执行语句列表，传播 RETURN_SENTINEL。
     *
     * 【哨兵传播机制】
     * 遍历每条语句，如果某条返回了哨兵对象（即遇到了 return 语句），
     * 立即停止执行并将哨兵原样返回。调用者（BlockStatement / IfStatement 等）
     * 同样检查哨兵并继续向上传播，直到 _applyFunction 解包它。
     *
     * @param {Object[]} body - 语句 AST 节点数组
     * @returns {*} 最后一条语句的值，或 RETURN_SENTINEL
     */
    _evalStatements(body) {
        let result;
        for (const stmt of body) {
            result = this.evaluate(stmt);
            // 哨兵传播：如果遇到 return，立即停止并向上传递
            if (result && result[RETURN_SENTINEL]) return result;
        }
        return result;
    }

    /**
     * 在作用域链中解析标识符名称。
     *
     * =========================================================================
     * 【设计决策：为什么从当前 LE 向外查找？】
     * =========================================================================
     *
     * ES 规范中的作用域链是一个单向链表（由 outer 引用链接）。
     * 查找方向：从当前执行上下文的 LE 开始，沿 outer 链向外（向上）遍历。
     *
     * 这个方向性（内 → 外）实现了"遮蔽"（shadowing）：
     *   内层声明会遮蔽外层同名变量，因为内层 LE 先被检查到。
     *
     * 为什么要同时检查 hasBinding 和 hasUninitializedBinding？
     *   - hasBinding: 变量已被声明且初始化（正常可访问）
     *   - hasUninitializedBinding: 变量已声明但未初始化 → TDZ（暂时性死区）
     *     两者都表示"找到声明位置"，但 TDZ 变量在 getBindingValue 时会抛出错误
     *
     * @param {string} name - 变量名
     * @returns {*} 变量的值
     * @throws {ReferenceError} 变量未定义
     */
    _resolveIdentifier(name) {
        this.hooks.emit(HookEvents.SCOPE_LOOKUP, { name });

        // 从最内层 LE 开始，沿 outer 链向外查找
        let env = this.ecStack.current().lexicalEnvironment;
        let depth = 0;
        const envChain = [];

        while (env) {
            envChain.push(env.snapshot().bindings);
            // 检查是否有该名称的绑定（包括 TDZ 状态）
            if (env.environmentRecord.hasBinding(name) || env.environmentRecord.hasUninitializedBinding(name)) {
                this.hooks.emit(HookEvents.SCOPE_CHAIN_RESOLVE, { name, found: true, depth, envChain });
                const value = env.environmentRecord.getBindingValue(name);
                this.hooks.emit(HookEvents.VARIABLE_READ, { name, value: this._safeHookValue(value) });
                return value;
            }
            // 向上一层（外层作用域）
            env = env.outer;
            depth++;
        }

        this.hooks.emit(HookEvents.SCOPE_CHAIN_RESOLVE, { name, found: false, depth, envChain });
        throw new ReferenceError(`${name} is not defined`);
    }

    /**
     * 解析标识符并返回值和所属环境（用于赋值场景）。
     *
     * 与 `_resolveIdentifier` 的区别：
     *   - _resolveIdentifier：只返回值（用于读取）
     *   - _resolveIdentifierWithEnv：返回值 + 环境引用（用于写入，需要知道在哪个 env 上 setBinding）
     *
     * @param {string} name - 变量名
     * @returns {{ value: *, environment: LexicalEnvironment }}
     * @throws {ReferenceError} 变量未定义
     */
    _resolveIdentifierWithEnv(name) {
        this.hooks.emit(HookEvents.SCOPE_LOOKUP, { name });

        let env = this.ecStack.current().lexicalEnvironment;
        let depth = 0;

        while (env) {
            if (env.environmentRecord.hasBinding(name) || env.environmentRecord.hasUninitializedBinding(name)) {
                this.hooks.emit(HookEvents.SCOPE_CHAIN_RESOLVE, { name, found: true, depth });
                return { value: env.environmentRecord.getBindingValue(name), environment: env };
            }
            env = env.outer;
            depth++;
        }

        throw new ReferenceError(`${name} is not defined`);
    }

    /**
     * 根据声明类型（var / let / const）获取对应的目标环境。
     *
     * =========================================================================
     * 【设计决策：var 沿 EC 栈向上查找函数/全局 EC】
     * =========================================================================
     *
     * 这一方法体现了 var 和 let/const 在作用域模型上的根本差异：
     *
     *   var   → 向上遍历 EC 栈，跳过块 EC，找到最近的函数 EC 或全局 EC 的 VE
     *   let   → 直接返回当前 EC 的 LE（留在当前块作用域）
     *   const → 同 let（在当前块作用域）
     *
     * 为什么 var 要向上找？
     *   因为在 ES 中，var 声明不受块作用域限制。当你写：
     *
     *     function foo() {
     *       if (true) { var x = 1; }   ← x 实际属于 foo 的作用域
     *       console.log(x);             // 1（可访问）
     *     }
     *
     *   块 EC 虽然有自己的 LE，但其 VE 指向外层函数的 VE。
     *   所以 var 声明需要写入的是函数 EC 的 VE，而不是块 EC 的 LE。
     *   本方法通过从栈顶向下查找第一个 FUNCTION/GLOBAL EC 来实现这一点。
     *
     * @param {string} kind - 'var' / 'let' / 'const'
     * @returns {LexicalEnvironment} 目标环境
     */
    _getEnvForKind(kind) {
        const currentEC = this.ecStack.current();
        if (kind === VARIABLE_KIND.VAR) {
            // var 去最近的函数/全局作用域
            // 从栈顶向下找到第一个 function 或 global EC
            for (let i = this.ecStack.stack.length - 1; i >= 0; i--) {
                const ec = this.ecStack.stack[i];
                if (ec.type === EC_TYPE.GLOBAL || ec.type === EC_TYPE.FUNCTION) {
                    return ec.variableEnvironment;
                }
            }
        }
        // let / const 去当前词法环境（块作用域）
        return currentEC.lexicalEnvironment;
    }

    /**
     * 扫描语句列表中的声明并执行提升（hoisting）。
     *
     * =========================================================================
     * 【Hoisting 两阶段模式】
     * =========================================================================
     *
     * ECMAScript 规范规定：在执行任何代码之前，需要先扫描所有声明并在作用域中
     * 创建对应的绑定（binding）。这个过程称为"提升"（hoisting）。
     *
     *   Phase 1: 扫描 & 创建绑定（本方法）
     *     - var:    创建可变绑定 + 立即初始化为 undefined
     *     - let:    创建可变绑定 + 标记为未初始化（TDZ 区）
     *     - const:  创建不可变绑定 + 标记为未初始化
     *     - function: 创建可变绑定 + 立即初始化为函数对象
     *
     *   Phase 2: 执行 & 初始化（_evalStatements 遍历执行时触发）
     *     - 遇到 var x = 5 → initializeBinding('x', 5) 覆盖 undefined
     *     - 遇到 let y = 5 → initializeBinding('y', 5) 退出 TDZ
     *     - 函数声明在 Phase 1 即完成初始化，Phase 2 无需操作
     *
     * 为什么要分两个阶段？
     *   因为 JS 允许在声明之前使用变量（虽然结果不同）：
     *     - var: 声明前使用得到 undefined（Phase 1 已初始化为 undefined）
     *     - let: 声明前使用抛出 ReferenceError（TDZ——Phase 1 标记了未初始化）
     *   如果只有一个阶段，无法在"遇到声明"之前就"知道"变量的存在，
     *   也就无法实现 TDZ 和 var 的 undefined 语义。
     *
     * @param {Object[]} body      - 语句列表
     * @param {LexicalEnvironment} targetEnv - 目标环境
     */
    _hoistDeclarations(body, targetEnv, varEnv = null) {
        for (const stmt of body) {
            if (stmt.type === NODE_TYPE.VARIABLE_DECLARATION) {
                this._hoistOneDeclaration(stmt, targetEnv, varEnv);
            } else if (stmt.type === NODE_TYPE.FUNCTION_DECLARATION) {
                this._hoistFunctionDeclaration(stmt, targetEnv);
            }
        }
    }

    /**
     * 在目标环境中为一个变量声明创建绑定。
     *
     * 【var 的特殊性】
     * var 在创建绑定后立即初始化为 undefined，所以声明前访问得到 undefined。
     * let/const 保持未初始化状态（TDZ），声明前访问抛出 ReferenceError。
     * const 创建不可变绑定（createImmutableBinding），赋值给它会抛出错误。
     *
     * 【varEnv 参数】
     * 块作用域中 var 声明应穿透到外层函数/全局 VE，而非块 LE。
     * 调用方通过 varEnv 传入正确的穿透目标环境。
     *
     * @param {Object} stmt - VariableDeclaration AST 节点
     * @param {LexicalEnvironment} targetEnv - let/const 的目标环境
     * @param {LexicalEnvironment} [varEnv=null] - var 的目标环境（默认与 targetEnv 相同）
     */
    _hoistOneDeclaration(stmt, targetEnv, varEnv = null) {
        // var 声明穿透块作用域，进入外层函数/全局 VE
        const env = (stmt.kind === VARIABLE_KIND.VAR && varEnv) ? varEnv : targetEnv;

        for (const decl of stmt.declarations) {
            const name = decl.id.name;

            // 如果已有 TDZ 绑定（被其他同名声明占用），跳过
            if (env.environmentRecord.hasUninitializedBinding(name)) continue;

            if (stmt.kind === VARIABLE_KIND.CONST) {
                env.environmentRecord.createImmutableBinding(name);
            } else {
                env.environmentRecord.createMutableBinding(name);
            }

            // 【关键】var 立即初始化为 undefined，let/const 保持未初始化（TDZ）
            if (stmt.kind === VARIABLE_KIND.VAR) {
                env.environmentRecord.initializeBinding(name, undefined);
            }

            this.hooks.emit(HookEvents.VARIABLE_DECLARE, {
                name,
                kind: stmt.kind,
                initialized: stmt.kind === VARIABLE_KIND.VAR,
            });
        }
    }

    /**
     * 在目标环境中提升函数声明。
     *
     * 函数声明在 hoisting 阶段即创建函数对象并完成初始化。
     * 这与 var (= undefined) 和 let/const (= TDZ) 都不同 ——
     * 函数声明是唯一在 hoisting 阶段就"完全就绪"的声明类型。
     *
     * 注意：如果目标已有同名 TDZ 绑定，先改为普通绑定再初始化，
     * 这是为了处理 let x; function x(){} 这种边界情况。
     *
     * @param {Object} stmt - FunctionDeclaration AST 节点
     * @param {LexicalEnvironment} targetEnv - 目标环境
     */
    _hoistFunctionDeclaration(stmt, targetEnv) {
        const name = stmt.id.name;

        // 如果已有 TDZ 绑定，先转为普通绑定
        if (targetEnv.environmentRecord.hasUninitializedBinding(name)) {
            targetEnv.environmentRecord.setMutableBinding(name, undefined);
        } else {
            targetEnv.environmentRecord.createMutableBinding(name, false);
        }

        // 闭包关键：以 targetEnv（当前函数的词法环境）为 [[Environment]]，而非当前 EC 的 LE
        // 因为 hoisting 阶段新 EC 尚未入栈，this.ecStack.current() 是外层调用者
        const funcObj = this._createFunctionObject(stmt, targetEnv);
        targetEnv.environmentRecord.initializeBinding(name, funcObj);

        this.hooks.emit(HookEvents.VARIABLE_DECLARE, {
            name,
            kind: 'function',
            initialized: true,
        });
    }

    /**
     * 创建函数对象（用于函数声明和函数表达式）。
     *
     * 【闭包的关键】
     * `closureEnv` 参数被设为函数对象的 `closure` 属性（即 [[Environment]]）。
     * 当函数被调用时，新创建的 LE 的 outer 指向这个 `closure`，
     * 而不是指向调用点的 LE。这就是"定义时作用域"（静态作用域 / 词法作用域）。
     *
     * @param {Object} node - 函数 AST 节点
     * @param {LexicalEnvironment} closureEnv - 定义时的词法环境（成为函数的 [[Environment]]）
     * @returns {Object} Ref<FunctionObject>
     */
    _createFunctionObject(node, closureEnv) {
        const funcObj = {
            type: 'regular',
            name: node.id ? node.id.name : '',
            params: node.params.map(p => p.name),
            body: node.body,
            closure: closureEnv,  // [[Environment]]: 词法作用域链的起点
        };

        // 收集函数自身声明的局部变量，用于过滤 capturedVars
        const localNames = new Set(funcObj.params);
        localNames.add(funcObj.name); // 函数名遮蔽外层同名变量
        this._collectLocalDeclarations(node.body, localNames);
        const outerBindings = Object.keys(closureEnv.environmentRecord.snapshot());
        const capturedVars = outerBindings.filter(v =>
            !['console','Object','Array','Function','undefined','NaN','Infinity'].includes(v) &&
            !localNames.has(v)
        );

        // 真闭包：嵌套函数且实际捕获了外层变量（非自身声明遮蔽）
        const isNested = closureEnv !== this.realm.globalEnv;
        const isRealClosure = isNested && capturedVars.length > 0;
        this.hooks.emit(HookEvents.CLOSURE_CREATE, {
            funcName: funcObj.name || '(anonymous)',
            capturedVars,
            isRealClosure,
            isNested,
        });

        const addr = this.memory.allocate(VALUE_TYPE.FUNCTION, funcObj);
        return makeRef(addr);
    }

    /**
     * 递归收集函数体中的局部声明名称（形参 / var / let / const / function）
     * 用于区分"真闭包捕获的外层变量"与"自身声明遮蔽同名变量"的情况
     */
    _collectLocalDeclarations(bodyNode, names) {
        if (!bodyNode) return;
        const stmts = bodyNode.type === NODE_TYPE.BLOCK_STATEMENT ? bodyNode.body : [bodyNode];
        for (const stmt of stmts) {
            if (stmt.type === NODE_TYPE.VARIABLE_DECLARATION) {
                for (const decl of (stmt.declarations || [])) {
                    names.add(decl.id.name);
                }
            } else if (stmt.type === NODE_TYPE.FUNCTION_DECLARATION && stmt.id) {
                names.add(stmt.id.name);
            }
        }
    }

    /**
     * 根据 callee 的调用形式解析 this 绑定。
     *
     * 【this 解析规则】（非严格模式简化版）
     *   obj.method()  → this = obj（方法调用模式）
     *   func()        → this = globalObject（裸调用模式）
     *   obj.call()    → 不绑定 obj，返回 globalObject（由 _handleCallApplyBind 另行处理）
     *
     * @param {Object} calleeNode  - callee 的 AST 节点
     * @param {*}      calleeResult - callee 的求值结果
     * @returns {*} this 值
     */
    _resolveThisForCall(calleeNode, calleeResult, baseObj) {
        // 方法调用：obj.method() → this = obj
        if (calleeNode.type === NODE_TYPE.MEMBER_EXPRESSION) {
            const propName = calleeNode.computed
                ? this.evaluate(calleeNode.property)
                : calleeNode.property.name;

            // call/apply/bind 不把函数对象本身作为 this（它们是工具方法）
            if (propName === 'call' || propName === 'apply' || propName === 'bind') {
                this.hooks.emit(HookEvents.THIS_RESOLVE, { pattern: THIS_PATTERN.DEFAULT, value: 'global' });
                return this.realm.globalObject;
            }

            // 复用调用方传入的 base object，避免重复求值
            const obj = baseObj !== undefined ? baseObj : this.evaluate(calleeNode.object);
            this.hooks.emit(HookEvents.THIS_RESOLVE, { pattern: THIS_PATTERN.METHOD_CALL, value: this._safeHookValue(obj) });
            return obj;
        }

        // 裸调用：func() → this = globalObject（非严格模式）
        this.hooks.emit(HookEvents.THIS_RESOLVE, { pattern: THIS_PATTERN.DEFAULT, value: 'global' });
        return this.realm.globalObject;
    }

    /**
     * 处理 call / apply / bind 调用。
     *
     * =========================================================================
     * 【设计决策：为什么 bind 返回独立的 'bound' 函数类型？】
     * =========================================================================
     *
     * Function.prototype.bind 创建一个新函数，其 this 和部分参数被永久固定。
     * 在 ECMAScript 中，这通过 %BoundFunctionCreate% 抽象操作实现。
     *
     * 为什么要用 type='bound' 而非创建新 regular 函数？
     *   1. 语义区分：bound 函数不是常规函数，没有闭包、没有函数体
     *   2. 参数合并：bound 函数的参数 = boundArgs + callArgs（需要运行时拼接）
     *   3. 避免递归闭包：如果 bind 返回 regular 函数，这个新函数的函数体
     *      又要调用原函数，会形成递归引用，调试困难
     *
     * 执行流程：
     *   call:  thisArg = args[0]，剩余 = args[1...]，直接调用 targetFunc
     *   apply: thisArg = args[0]，argArray = args[1] 的元素，调用 targetFunc
     *   bind:  创建 { type:'bound', targetFunc, boundThis, boundArgs }，
     *          调用时在 _applyFunction 中合并参数后递归调用 targetFunc
     *
     * @param {Object} node   - CallExpression AST 节点
     * @param {string} method - 'call' / 'apply' / 'bind'
     * @returns {*} 调用结果（call/apply）或 BoundFunction ref（bind）
     */
    _handleCallApplyBind(node, method) {
        const targetFunc = this.evaluate(node.callee.object);
        const args = node.args.map(a => this.evaluate(a));

        if (method === 'call') {
            // fn.call(thisArg, arg1, arg2, ...)
            const thisArg = args[0] !== undefined ? args[0] : this.realm.globalObject;
            const callArgs = args.slice(1);
            this.hooks.emit(HookEvents.THIS_RESOLVE, { pattern: THIS_PATTERN.EXPLICIT, value: this._safeHookValue(thisArg) });
            return this._applyFunction(targetFunc, callArgs, thisArg);
        }

        if (method === 'apply') {
            // fn.apply(thisArg, [arg1, arg2, ...])
            const thisArg = args[0] !== undefined ? args[0] : this.realm.globalObject;
            let applyArgs = [];
            if (args[1] && isReference(args[1])) {
                const arrEntry = this.memory.getEntry(args[1].address);
                if (arrEntry && arrEntry.type === VALUE_TYPE.ARRAY) {
                    applyArgs = arrEntry.value.elements;
                }
            }
            this.hooks.emit(HookEvents.THIS_RESOLVE, { pattern: THIS_PATTERN.EXPLICIT, value: this._safeHookValue(thisArg) });
            return this._applyFunction(targetFunc, applyArgs, thisArg);
        }

        if (method === 'bind') {
            // fn.bind(thisArg, arg1, arg2, ...) → 返回一个新的 bound 函数
            const thisArg = args[0] !== undefined ? args[0] : this.realm.globalObject;
            const boundArgs = args.slice(1);

            // 创建 bound 函数对象：记住目标函数、绑定的 this 和预填参数
            const boundFunc = {
                type: 'bound',
                name: 'bound',
                targetFunc,          // 目标函数
                boundThis: thisArg,  // 永久绑定的 this
                boundArgs,           // 预填参数列表
            };
            const addr = this.memory.allocate(VALUE_TYPE.FUNCTION, boundFunc);
            this.hooks.emit(HookEvents.THIS_RESOLVE, { pattern: THIS_PATTERN.EXPLICIT, value: this._safeHookValue(thisArg) });
            return makeRef(addr);
        }
    }

    /**
     * 应用（调用）一个函数。
     *
     * =========================================================================
     * 【核心流程 —— ECMAScript [[Call]] 内部方法模拟】
     * =========================================================================
     *
     *  1. 验证 funcRef 是函数类型
     *  2. 如果是 bound 函数 → 合并参数后递归调用 targetFunc
     *  3. 如果是 builtin 函数 → 直接执行
     *  4. 创建新的 LE 和 VE（对于函数 EC，两者指向同一环境）
     *  5. 绑定参数到新环境
     *  6. 提升函数体内的声明到新环境
     *  7. 确定 this 绑定（箭头函数特殊处理：忽略传入的 thisValue，使用 capturedThis）
     *  8. 创建并推入新的函数 EC
     *  9. 执行函数体（检测 RETURN_SENTINEL）
     * 10. 弹出 EC，返回结果
     *
     * =========================================================================
     * 【设计决策：函数 EC 中 LE === VE】
     * =========================================================================
     *
     * 在函数 EC 中，lexicalEnvironment 和 variableEnvironment 指向同一个环境对象。
     * 这是因为函数体是 var 的作用域边界——var 和 let/const 在函数体内都存在于同一
     * 个作用域。但块 EC 中 LE !== VE（块 EC 的 VE 指向外层函数的 VE），这是实现
     * 块级作用域的关键。
     *
     * 为什么不是所有 EC 都 LE === VE？
     *   因为 var 不创建块作用域。如果块 EC 也是 LE === VE（即 VE 也是新环境），
     *   那么块内的 var 声明就会被关在块内，这与 JS 语义不符。
     *
     * @param {Object} funcRef   - 函数引用
     * @param {Array}  args      - 实参列表
     * @param {*}      thisValue - 调用时传入的 this（箭头函数会忽略它）
     * @returns {*} 函数返回值
     */
    _applyFunction(funcRef, args, thisValue) {
        if (!isReference(funcRef)) {
            throw new TypeError(`${String(funcRef)} is not a function`);
        }

        const entry = this.memory.getEntry(getRefAddress(funcRef));
        if (entry.type !== VALUE_TYPE.FUNCTION) {
            throw new TypeError(`${String(funcRef)} is not a function`);
        }

        const funcObj = entry.value;

        // ─── Bound 函数处理：合并预填参数，递归到 targetFunc ───
        // boundArgs 先于 callArgs（bind 的预填参数在前面）
        if (funcObj.type === 'bound') {
            const mergedArgs = [...funcObj.boundArgs, ...args];
            return this._applyFunction(funcObj.targetFunc, mergedArgs, funcObj.boundThis);
        }

        // ─── 内置函数处理：直接调用 ───
        if (funcObj.type === 'builtin') {
            return funcObj.call(...args);
        }

        const funcName = funcObj.name || '(anonymous)';

        // ═══════════════════════════════════════════════════════════
        // Phase 1: 创建阶段（Creation Phase）
        //
        // 在此阶段，引擎设置函数调用所需的一切运行时结构，但尚未执行
        // 任何函数体代码。这包括：
        //   1. 创建新的词法环境（outer 指向闭包捕获的 [[Environment]]）
        //   2. 绑定形参到实参值
        //   3. Hoist 函数体内的 var/let/const/function 声明
        //   4. 确定 this 绑定（箭头函数忽略传入的 thisValue）
        //   5. 创建 ExecutionContext 并入栈
        //
        // 规范中，这些都是 Reify / PrepareForOrdinaryCall 的一部分。
        // 外部可通过 context:creation:start/end hook 精确观察此阶段。
        // ═══════════════════════════════════════════════════════════
        this.hooks.emit(HookEvents.CONTEXT_CREATION_START, {
            type: 'function',
            name: funcName,
        });

        // 1. 创建函数的词法环境（outer = [[Environment]]，闭包基石）
        const localEnv = new LexicalEnvironment(funcObj.closure || this.realm.globalEnv);
        const varEnv = localEnv; // 函数域：LE 和 VE 指向同一环境

        // 2. 绑定形参：每个形参在 localEnv 中创建可变绑定并初始化为实参值
        for (let i = 0; i < (funcObj.params || []).length; i++) {
            const paramName = funcObj.params[i];
            localEnv.environmentRecord.createMutableBinding(paramName);
            localEnv.environmentRecord.initializeBinding(
                paramName,
                args[i] !== undefined ? args[i] : undefined,
            );
        }

        // 3. Hoist 函数体内的声明（var → undefined，let/const → TDZ，function → 完整初始化）
        const bodyStatements = funcObj.body.type === NODE_TYPE.BLOCK_STATEMENT
            ? funcObj.body.body
            : [funcObj.body];
        this._hoistDeclarations(bodyStatements, localEnv);

        // 4. 确定 this 绑定
        // 箭头函数忽略调用时传入的 thisValue，使用定义时捕获的 capturedThis
        let effectiveThis = thisValue;
        if (funcObj.type === 'arrow') {
            effectiveThis = funcObj.capturedThis;
            this.hooks.emit(HookEvents.THIS_RESOLVE, {
                pattern: THIS_PATTERN.ARROW,
                value: this._safeHookValue(effectiveThis),
            });
        }

        // 5. 创建执行上下文并入栈
        const funcEC = new ExecutionContext(
            EC_TYPE.FUNCTION,
            localEnv,   // LE
            varEnv,     // VE（=== LE，函数是 var 的作用域边界）
            effectiveThis,
            { name: funcName },
        );
        this.ecStack.push(funcEC);

        this.hooks.emit(HookEvents.CONTEXT_CREATION_END, {
            type: 'function',
            name: funcName,
            envSnapshot: localEnv.snapshot(),
        });

        // ═══════════════════════════════════════════════════════════
        // Phase 2: 执行阶段（Execution Phase）
        //
        // 逐条执行函数体语句。var 在 Phase 1 已初始化为 undefined，
        // 此时遇到变量声明语句才赋实际值。let/const 也在此阶段
        // 到达声明行时才完成初始化（从 TDZ 中释放）。
        //
        // RETURN_SENTINEL 在此被解包：函数遇到 return 时产生哨兵，
        // 本循环检测哨兵后立即停止执行并取出真实返回值。
        // ═══════════════════════════════════════════════════════════
        this.hooks.emit(HookEvents.FUNCTION_CALL, {
            name: funcName,
            args: args.map(a => this._safeHookValue(a)),
            thisValue: this._safeHookValue(effectiveThis),
        });
        this.hooks.emit(HookEvents.CONTEXT_PUSH, funcEC.snapshot());

        let result;
        const evalBody = funcObj.body.type === NODE_TYPE.BLOCK_STATEMENT
            ? funcObj.body.body
            : [funcObj.body];

        for (const stmt of evalBody) {
            result = this.evaluate(stmt);
            // 检测 RETURN_SENTINEL：遇到 return 时解包哨兵并停止执行
            if (result && result[RETURN_SENTINEL]) {
                result = result.value;
                break;
            }
        }

        // ─── 退出函数：弹栈 → 触发 hook → 返回结果 ───
        this.ecStack.pop();
        this.hooks.emit(HookEvents.CONTEXT_POP, { type: 'function', name: funcName });
        this.hooks.emit(HookEvents.FUNCTION_RETURN, {
            name: funcName,
            value: this._safeHookValue(result),
        });

        return result;
    }

    /**
     * 推断当前 this 模式（用于钩子事件）。
     *
     * @returns {string} this 模式标识
     */
    _getThisPattern() {
        // Infer the current this pattern from context
        return 'current';
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 运算符实现 (Operator Implementations)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * 加法运算符（含字符串拼接逻辑）。
     *
     * 【JS 的 + 运算符特殊性】
     * 如果任一操作数是字符串，则执行字符串拼接。
     * 这与严格类型语言（如 Python）不同，后者用不同的运算符（+ vs & 或 concat）。
     * 这里遵循 ECMAScript 规范：只要有一个是 string，两边都转为 string。
     *
     * @param {*} left  - 左操作数
     * @param {*} right - 右操作数
     * @returns {number|string} 加法或拼接结果
     */
    _add(left, right) {
        if (typeof left === 'string' || typeof right === 'string') {
            return String(left) + String(right);
        }
        return left + right;
    }

    /**
     * typeof 运算符。
     *
     * 处理引用类型（函数返回 'function'，其他对象返回 'object'）
     * 和基本类型（null 返回 'object'——这是 JS 的历史遗留 bug，这里忠实地复现）。
     *
     * @param {*} val - 被检测的值
     * @returns {string} 类型字符串
     */
    _typeof(val) {
        if (isReference(val)) {
            const entry = this.memory.getEntry(getRefAddress(val));
            if (entry.type === VALUE_TYPE.FUNCTION) return 'function';
            return 'object';
        }
        if (val === null) return 'object'; // 历史遗留：typeof null === 'object'
        return typeof val;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 内置方法工厂 (Built-in Method Factories)
    //
    // 这些方法创建 call / apply / bind 的"占位符"函数对象。
    // 它们不是真实调用的——真实逻辑在 _handleCallApplyBind 中。
    // 这些工厂仅用于提供函数对象的元数据（名称、参数签名等）。
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * 创建 Function.prototype.call 的占位函数对象。
     * 实际调用逻辑在 _handleCallApplyBind 中。
     *
     * @returns {Object} 占位函数对象
     */
    _createCallMethod() {
        return {
            type: 'regular',
            name: 'call',
            params: ['thisArg', '...args'],
            body: null,
            closure: null,
        };
    }

    /**
     * 创建 Function.prototype.apply 的占位函数对象。
     * 实际调用逻辑在 _handleCallApplyBind 中。
     *
     * @returns {Object} 占位函数对象
     */
    _createApplyMethod() {
        return {
            type: 'regular',
            name: 'apply',
            params: ['thisArg', 'argsArray'],
            body: null,
            closure: null,
        };
    }

    /**
     * 创建 Function.prototype.bind 的占位函数对象。
     * 实际调用逻辑在 _handleCallApplyBind 中。
     *
     * @returns {Object} 占位函数对象
     */
    _createBindMethod() {
        return {
            type: 'regular',
            name: 'bind',
            params: ['thisArg', '...args'],
            body: null,
            closure: null,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 安全的钩子值转换 (Safe Hook Value)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * 将任意值转换为钩子事件中可安全传输的表示。
     *
     * =========================================================================
     * 【设计决策：为什么需要 _safeHookValue？】
     * =========================================================================
     *
     * 钩子系统（Hooks）用于将运行时信息传递给外部工具（调试器、可视化面板、
     * 测试框架）。传递原始值存在几个风险：
     *
     *   1. 循环引用导致 JSON.stringify() 崩溃
     *      → 对象可能通过 properties 形成循环引用（如 a.b = a）
     *      → 直接 JSON.stringify 会抛出 "Converting circular structure to JSON"
     *      → _safeHookValue 将引用类型转为字符串标签，打断循环
     *
     *   2. 引用值在钩子回调中被修改导致引擎状态不一致
     *      → 钩子是观察者，不应修改被观察对象
     *      → 转换为不可变的简单字符串/数字可防止意外修改
     *
     *   3. 大型对象传递给钩子造成性能问题
     *      → 完整深拷贝一个大对象代价高昂
     *      → 用 '<object>' / '<array>' 标签替代，只传递概要信息
     *
     *   4. 空指针悬垂引用
     *      → 引用的 address 可能指向已释放的内存
     *      → 检查 entry 是否存在，不存在返回 '<ref:dangling>'
     *
     * 转换规则：
     *   基本类型       → 原样返回（无风险）
     *   Function ref   → '<function:name>'
     *   Object ref     → '<object>'
     *   Array ref      → '<array>'
     *   悬垂 ref       → '<ref:dangling>'
     *   普通 JS 对象   → JSON.stringify（含 try-catch 保护）
     *   Native 函数    → '<native function>'
     *
     * @param {*} val - 原始值
     * @returns {*} 安全的、可序列化的值
     */
    _safeHookValue(val) {
        if (val === null || val === undefined) return val;
        if (typeof val === 'object' && val !== null) {
            // 检查是否为引擎内部的引用类型（Ref）
            if ('address' in val) {
                const entry = this.memory.getEntry(val.address);
                if (!entry) return '<ref:dangling>'; // 悬垂引用保护
                if (entry.type === VALUE_TYPE.FUNCTION) return `<function:${entry.value.name || 'anonymous'}>`;
                if (entry.type === VALUE_TYPE.OBJECT) return '<object>';
                if (entry.type === VALUE_TYPE.ARRAY) return '<array>';
                return `<ref:${val.address}>`;
            }
            // 普通 JS 对象：尝试 JSON 序列化，失败则返回 '<object>'
            try {
                return JSON.stringify(val);
            } catch {
                return '<object>'; // 循环引用保护：序列化失败时降级为标签
            }
        }
        if (typeof val === 'function') return '<native function>';
        return val;
    }
}
