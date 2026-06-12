/**
 * Realm — JS 引擎的“全局环境”
 *
 * 在 ECMA-262 规范中，Realm 是一个独立的全局执行环境：它拥有自己的全局对象、
 * 全局环境记录、内建构造函数原型链，以及一套完整的内存堆和执行上下文栈。
 * 不同 Realm 之间完全隔离（例如浏览器中每个 iframe 都有自己的 Realm），
 * 一个 Realm 中的 Array 和另一个 Realm 中的 Array 是不同的对象。
 *
 * 本模块中的 Realm 负责：
 *   1. 持有 Memory（堆内存分配器）—— 所有 JS 对象/数组/闭包变量存在这里
 *   2. 持有 ExecutionContextStack（调用栈）—— 函数调用、块级作用域等都会压栈
 *   3. 初始化全局对象（globalThis），注入 console、Object、Array、Function 等内建绑定
 *   4. 初始化全局词法环境，并创建首个全局执行上下文压入调用栈
 *
 * 设计决策：
 *   - 将 Memory 挂在 Realm 下而非全局单例，是为了支持多 Realm 隔离。
 *     未来若实现 iframe 或 vm.createContext()，每个 Realm 有独立堆。
 *   - hooks 参数贯穿整个引擎，用于可观测性（trace / debugger）。
 *     每个 Realm 创建时接收同一个 HookSystem 实例，确保事件聚合在一个总线中。
 */

import { Memory } from './Memory.js';
import { LexicalEnvironment } from './LexicalEnvironment.js';
import { ObjectEnvironmentRecord } from './EnvironmentRecord.js';
import { ExecutionContext } from './ExecutionContext.js';
import { ExecutionContextStack } from './ExecutionContextStack.js';
import { makeRef } from './Value.js';
import { EC_TYPE, VALUE_TYPE } from '../types.js';

// ─── Realm 类 ─────────────────────────────────────────────────────────────────
// 每一个 JS-engine 实例创建一个 Realm，代表一个完整的 JS 运行沙箱。

export class Realm {
    /**
     * 创建一个新的 JS 执行环境（Realm 实例）
     *
     * @param {import('../hooks/HookSystem.js').HookSystem} hooks
     *        全局事件总线，Realm 内发生的所有操作（内存分配、变量读写等）
     *        都会通过此 hooks 实例发出事件，供调试/可视化消费
     */
    constructor(hooks) {
        this.hooks = hooks;

        // 堆内存分配器 —— Realm 内所有对象/数组/闭包的归宿
        // 之所以不采用全局单例，是预留了多 Realm（iframe / vm 沙箱）的扩展空间
        this.memory = new Memory(hooks);

        // ES 规范中的执行上下文栈（EC Stack）
        // 每次函数调用、eval 调用、全局代码执行都会导致压栈/弹栈
        this.ecStack = new ExecutionContextStack();

        // 初始化顺序很重要：必须先创建全局对象并将其放入堆中，
        // 然后才能创建引用该全局对象的词法环境记录。
        // 这遵循了 ES 规范中 Realm 创建的步骤：
        //   CreateGlobalObject() → CreateGlobalEnvironment() → PushGlobalEC()
        this._initGlobalObject();
        this._initGlobalEnvironment();
    }

    // ─── 全局对象初始化 ──────────────────────────────────────────────────────

    /**
     * 创建并初始化全局对象（globalThis / window 等价物）
     *
     * 按 ES 规范，全局对象是一个普通对象，但其属性（如 undefined、NaN）
     * 拥有特定的属性描述符（writable: false 等）。
     * 这里做了简化：使用 Map 存储属性，不区分数据/访问器属性描述符。
     *
     * 注入的内建绑定：
     *   - console.log —— 桥接到宿主 console，方便用户调试自己的脚本
     *   - Object / Array / Function —— 最小化的构造函数占位，
     *     它们的原型链和完整方法会在后续阶段挂载
     *   - undefined / NaN / Infinity —— ES 规范要求的全局常量
     *
     * @private
     */
    _initGlobalObject() {
        // 在堆上分配全局对象。注意：这只是一个普通 OBJECT 节点，
        // 并不会被标记为 "global" 类型 —— 全局性体现在它被全局环境记录引用。
        const globalObjAddr = this.memory.allocate(VALUE_TYPE.OBJECT, {});
        const globalEntry = this.memory.getEntry(globalObjAddr);

        // 使用 Map 而非普通对象存储属性，原因有二：
        //   1. Map 的 key 可以是任意类型（Symbol 等），与 ES 规范对齐
        //   2. Map 迭代顺序 = 插入顺序（ES2015+），便于调试时观察属性
        const props = new Map();

        // ── console ──
        // 桥接到宿主 console。这里没有实现完整的 Console API，
        // 只暴露了 log 方法，以降低初期实现复杂度。
        // 注意：console.log 必须作为 FUNCTION 类型存入堆中（而非原始 JS 函数），
        // 因为 _evalMemberExpression 返回属性值后，_applyFunction 需要 isReference
        // 检查通过，然后从堆中取出 funcObj.call 来执行。
        const self = this;
        const logFunc = {
            type: 'builtin',
            name: 'log',
            call(...args) {
                const formatted = args.map(a => self._formatValue(a));
                console.log(...formatted);
                return undefined;
            },
        };
        const logAddr = this.memory.allocate(VALUE_TYPE.FUNCTION, logFunc);

        const consoleObj = {
            properties: new Map(),
        };
        consoleObj.properties.set('log', makeRef(logAddr));
        const consoleAddr = this.memory.allocate(VALUE_TYPE.OBJECT, consoleObj);
        props.set('console', makeRef(consoleAddr));

        // ── 内建构造函数（最小化占位） ──
        // 这些函数目前只返回一个哑引用 (address 0)，
        // 完整的构造函数逻辑（原型链、实例化等）在 Evaluator 中实现。
        // 这里预先创建是为了让解析阶段就能引用到这些标识符。
        props.set('Object', this._createBuiltinFunc('Object'));
        props.set('Array', this._createBuiltinFunc('Array'));
        props.set('Function', this._createBuiltinFunc('Function'));

        // ── 全局常量 ──
        // undefined / NaN / Infinity 直接存为 JS 原生值。
        // 注意：ES 规范中这些属性是 non-writable 的，
        // 当前简化实现不会阻止对其重新赋值。
        props.set('undefined', undefined);
        props.set('NaN', NaN);
        props.set('Infinity', Infinity);

        // 将属性表写回堆上的全局对象节点
        globalEntry.value.properties = props;

        // makeRef 创建对堆地址的引用，这是引擎内部传递对象值的标准方式
        this.globalObject = makeRef(globalObjAddr);
    }

    // ─── 全局环境初始化 ──────────────────────────────────────────────────────

    /**
     * 创建全局词法环境并将首个执行上下文压入调用栈
     *
     * 在 ES 规范中，全局环境是独一无二的：
     *   - 它的 EnvironmentRecord 不是 DeclarativeEnvironmentRecord，
     *     而是 ObjectEnvironmentRecord（绑定到全局对象上）
     *   - 它的 outer 引用为 null（作用域链的终点）
     *   - 变量声明（var / function declaration）直接成为全局对象的属性
     *
     * 这里先创建 ObjectEnvironmentRecord（其内部直接引用全局对象的属性 Map），
     * 然后用它构造 LexicalEnvironment，最后创建一个 GLOBAL 类型的执行上下文压入栈顶。
     *
     * 压栈后，所有后续的标识符解析都会沿着此 EC 的作用域链查找，最终沉降到全局。
     *
     * @private
     */
    _initGlobalEnvironment() {
        // ObjectEnvironmentRecord 直接复用全局对象的属性 Map
        // Why: 这样 var a = 1 会直接反映到 globalThis.a 上，符合 ES 规范
        const globalRecord = new ObjectEnvironmentRecord({
            properties: this.memory.getEntry(this.globalObject.address).value.properties,
        });
        this.globalEnv = new LexicalEnvironment(null, globalRecord);

        // 创建全局执行上下文
        //   - thisValue 指向 globalObject（在全局代码中 this === globalThis）
        //   - variableEnvironment === lexicalEnvironment（全局代码中没有 with/catch 等
        //     需要独立变量环境的场景，因此二者指向同一个词法环境）
        const globalEC = new ExecutionContext(
            EC_TYPE.GLOBAL,
            this.globalEnv,        // variableEnvironment
            this.globalEnv,        // lexicalEnvironment
            makeRef(this.globalObject.address), // thisValue
            { name: 'global' }     // 元数据，用于调试输出
        );

        // 将全局 EC 压栈：引擎启动后首先进入此上下文
        this.ecStack.push(globalEC);
    }

    // ─── 辅助方法 ─────────────────────────────────────────────────────────────

    /**
     * 创建一个最小化的内建函数引用
     *
     * 返回的引用指向一个 FUNCTION 类型的堆对象，其 call 方法目前是占位实现。
     * 之所以在 Realm 初始化阶段就创建这些引用，而不是在 Evaluator 中按需创建：
     *   - 保证全局标识符解析（如 Object、Array）不会抛出 ReferenceError
     *   - 允许用户代码在声明阶段就引用这些名称（即使尚未调用）
     *
     * @param {string} name - 函数名称（如 'Object', 'Array'）
     * @returns {import('./Value.js').Ref} 指向堆上函数对象的引用
     * @private
     */
    _createBuiltinFunc(name) {
        const func = {
            type: 'builtin',
            name,
            // 占位实现 —— 返回指向地址 0 的引用。
            // 真正的 call 行为由 Evaluator 中的 visitCallExpression 分发，
            // 它会检测 func 是否为 'builtin' 类型并走内建函数调用路径，
            // 绕开这个占位 call。
            call: function () { return makeRef(0); },
        };
        const addr = this.memory.allocate(VALUE_TYPE.FUNCTION, func);
        return makeRef(addr);
    }

    /**
     * 将引擎内部的值格式化为人可读的字符串
     *
     * 主要用于 console.log 的输出，需要递归处理嵌套对象/数组/函数。
     * 这里需要特殊处理 Ref（引擎内部的引用包装），因为用户期望看到的是
     * 解引用后的实际值，而不是原始 Ref 对象。
     *
     * 设计考量：
     *   - 递归格式化时必须检查悬垂引用（dangling ref），即地址指向的堆记录
     *     已被 GC 回收或不存在的情况，避免运行时崩溃。
     *   - 字符串值用单引号包裹，与 Node.js 的 util.inspect 风格一致。
     *   - 不为 null 的 typeof === 'object' 且带 address 属性 → 判定为引擎内部引用
     *
     * @param {*} val - 待格式化的值（可能是原始值、JS 原生对象、或引擎内部 Ref）
     * @returns {string} 格式化后的字符串
     * @private
     */
    _formatValue(val) {
        if (val === null) return 'null';
        if (val === undefined) return 'undefined';

        // 检测引擎内部引用（Ref）
        // 判断条件：是对象、不为 null、拥有 address 属性。
        // 这里使用 duck-typing 而非 instanceof，因为 Ref 可能是冻结对象
        // 或由 makeRef 直接返回的普通对象。
        if (typeof val === 'object' && val !== null && 'address' in val) {
            const entry = this.memory.getEntry(val.address);
            // 防御性检查：堆地址可能因 GC 或 bug 而无效
            if (!entry) return '<dangling ref>';
            if (entry.type === VALUE_TYPE.FUNCTION) {
                return `[Function: ${entry.value.name || 'anonymous'}]`;
            }
            if (entry.type === VALUE_TYPE.ARRAY) {
                const items = entry.value.elements.map(e => this._formatValue(e)).join(', ');
                return `[ ${items} ]`;
            }
            if (entry.type === VALUE_TYPE.OBJECT) {
                const propEntries = [];
                for (const [k, v] of entry.value.properties) {
                    propEntries.push(`${k}: ${this._formatValue(v)}`);
                }
                return `{ ${propEntries.join(', ')} }`;
            }
        }
        // 字符串加引号，方便区分数字 123 和字符串 "123"
        if (typeof val === 'string') return `'${val}'`;
        return String(val);
    }
}
