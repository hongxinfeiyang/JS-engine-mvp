/**
 * 环境记录（Environment Record）模块 —— 实现 ECMAScript 规范中的标识符绑定机制
 *
 * 在 ECMAScript 规范中，每个执行上下文（Execution Context）持有一个
 * 词法环境（Lexical Environment），而词法环境由两部分组成：
 *   1. 环境记录（Environment Record）—— 存储当前作用域内的变量绑定
 *   2. 外部环境引用（[[OuterEnv]]）—— 指向外层词法环境，形成作用域链
 *
 * 本模块实现环境记录部分，支持两种规范定义的类型：
 *
 *   声明式环境记录（DeclarativeEnvironmentRecord）
 *     - 适用场景：函数体、catch 块、let/const/class 的块级作用域
 *     - 特点：绑定直接存储在环境记录自身内部，不与任何 JS 对象关联
 *     - 经典示例：`{ let x = 1; }` 中的 x 就由声明式记录管理
 *
 *   对象式环境记录（ObjectEnvironmentRecord）
 *     - 适用场景：全局作用域、with 语句
 *     - 特点：绑定实际存储在一个「绑定对象」的属性中
 *     - 经典示例：`with (obj) { ... }` 将 obj 的属性暴露为标识符
 *     - 为何需要 bindingObject？因为 with 语句中 obj.x = 1 必须反映回
 *       原始对象 obj 上，不能只是内部记录的值
 *
 * 核心概念 —— 三个正交的绑定状态位：
 *
 *   mutable   (可变性)   true = var / let  可以重新赋值
 *                        false = const     不可重新赋值
 *
 *   deletable (可删除性) true = var / 非严格模式函数声明  可用 delete 删除
 *                        false = let / const / class      不可删除
 *
 *   initialized (已初始化) true = 绑定已完成初始化，可安全访问
 *                          false = 绑定处于 TDZ 中，访问抛出 ReferenceError
 *
 * 关于「暂时性死区（Temporal Dead Zone，TDZ）」的实现：
 *   为什么要设计 initialized 标志位？
 *     ES6 的 let/const 声明会被「提升」（hoisting），但不像 var 那样
 *     初始化为 undefined。从块开始到声明语句执行前的这段区域就是 TDZ。
 *     在 TDZ 中访问变量会抛出 ReferenceError。
 *
 *   实现方式：
 *     1. createMutableBinding / createImmutableBinding → initialized = false
 *     2. initializeBinding → initialized = true
 *     3. getBindingValue 检查 initialized，未初始化则抛出 TDZ 错误
 *
 *   为什么要区分 hasBinding 和 hasUninitializedBinding？
 *     hasBinding → 仅在 initialized 为 true 时返回 true（对用户代码而言
 *                  该变量「存在且可用」）
 *     hasUninitializedBinding → 只要绑定被创建就返回 true（用于静态分析
 *                               和引擎内部判断，即使还不可访问）
 *
 * @module EnvironmentRecord
 */

// ─── 声明式环境记录 ────────────────────────────────────────────────

export class DeclarativeEnvironmentRecord {
    /**
     * 创建一个空的声明式环境记录。
     *
     * 为什么用 Map 存储绑定？
     *   - Map 没有原型链污染风险：使用普通对象 {} 时，hasOwnProperty 等
     *     原型属性会被误判为绑定名称。
     *   - Map 的 key 可以是任意值，对 Symbol 命名的属性天然支持。
     *   - Map 的 delete 语义清晰，不受原型链影响。
     */
    constructor() {
        /**
         * bindings: Map<name, Binding>
         *
         * Binding 结构：
         *   {
         *       value:       *,        // 绑定的当前值
         *       mutable:     boolean,  // 是否可修改
         *       deletable:   boolean,  // 是否可删除
         *       initialized: boolean,  // 是否已完成初始化（TDZ 关键位）
         *   }
         */
        this.bindings = new Map();
    }

    // ── 创建绑定 ──

    /**
     * 创建一个可变绑定，对应 `let` / `var` 声明。
     *
     * 注意：绑定创建后 initialized 为 false，处于 TDZ 中。
     *       必须显式调用 initializeBinding 后才能通过 getBindingValue 访问。
     *       这模拟了规范中「创建绑定」和「初始化绑定」两步分离的设计。
     *
     * @param {string}  name      - 绑定名称（标识符）
     * @param {boolean} deletable - 是否可用 delete 删除，默认 true（var 语义）
     */
    createMutableBinding(name, deletable = true) {
        this.bindings.set(name, {
            value: undefined,
            mutable: true,
            deletable,
            initialized: false,
        });
    }

    /**
     * 创建一个不可变绑定，对应 `const` 声明。
     *
     * 与可变绑定的区别：
     *   - mutable = false：后续 setMutableBinding 会抛出 TypeError
     *   - deletable = false：delete 操作无效
     *   - const 声明的变量必须在声明时初始化，所以 initializeBinding
     *     紧接着 createImmutableBinding 调用
     *
     * @param {string} name - 绑定名称（标识符）
     */
    createImmutableBinding(name) {
        this.bindings.set(name, {
            value: undefined,
            mutable: false,
            deletable: false,
            initialized: false,
        });
    }

    // ── 初始化绑定 ──

    /**
     * 初始化绑定的值，解除 TDZ 状态。
     *
     * 设计要点：
     *   - 这里不做类型检查，因为调用方（Runtime 执行模块）已经在解析阶段
     *     确保了只有声明语句才能调用此方法。
     *   - 对于 const，此调用后不能再修改值（由 setMutableBinding 守卫）。
     *
     * @param {string} name  - 绑定名称
     * @param {*}      value - 初始化的值
     * @throws {ReferenceError} 如果绑定不存在
     */
    initializeBinding(name, value) {
        const binding = this.bindings.get(name);

        // 绑定不存在 = 从未声明 = 运行时错误（通常是引擎内部 bug）
        if (!binding) {
            throw new ReferenceError(`${name} is not defined`);
        }

        binding.value = value;

        // 关键：设置 initialized = true 解除 TDZ
        binding.initialized = true;
    }

    // ── 读写操作 ──

    /**
     * 修改可变绑定的值（对应赋值语句 `x = 42`）。
     *
     * @param {string} name  - 绑定名称
     * @param {*}      value - 新值
     * @throws {ReferenceError} 如果绑定不存在
     * @throws {TypeError}      如果绑定为不可变（const 重新赋值）
     */
    setMutableBinding(name, value) {
        const binding = this.bindings.get(name);

        if (!binding) {
            throw new ReferenceError(`${name} is not defined`);
        }

        // 模拟 const 的「赋值给常量」TypeError
        // 规范 8.1.1.3.3 SetMutableBinding 步骤 3：
        // "If the binding is not mutable, throw a TypeError"
        if (!binding.mutable) {
            throw new TypeError(`Assignment to constant variable: ${name}`);
        }

        binding.value = value;
    }

    /**
     * 读取绑定的值（对应标识符引用 `x`）。
     *
     * 为什么先检查 initialized 再返回？
     *   - 这是 TDZ 的核心实现。如果绑定存在但 initialized 为 false，
     *     说明变量已提升但声明语句尚未执行，访问它是规范禁止的行为。
     *
     * @param {string} name - 绑定名称
     * @returns {*} 绑定的值
     * @throws {ReferenceError} 绑定不存在 或 尚未初始化（TDZ）
     */
    getBindingValue(name) {
        const binding = this.bindings.get(name);

        // 情况 1：变量从未声明 —— 最普通的 ReferenceError
        if (!binding) {
            throw new ReferenceError(`${name} is not defined`);
        }

        // 情况 2：变量已声明但未初始化 —— TDZ 错误
        // 规范原文："Cannot access 'x' before initialization"
        if (!binding.initialized) {
            throw new ReferenceError(`Cannot access '${name}' before initialization`);
        }

        return binding.value;
    }

    // ── 删除操作 ──

    /**
     * 尝试删除绑定。
     *
     * 注意返回值语义：
     *   - true: 删除成功
     *   - false: 绑定不可删除 或 绑定不存在（静默失败，与 JS delete 行为一致）
     *
     * @param {string} name - 绑定名称
     * @returns {boolean} 是否删除成功
     */
    deleteBinding(name) {
        const binding = this.bindings.get(name);

        // deletable = false（如 let/const）或绑定不存在时返回 false
        // 不抛出错误是与 JS 的 delete 运算符行为保持一致
        if (!binding || !binding.deletable) return false;

        this.bindings.delete(name);
        return true;
    }

    // ── 存在性检查 ──

    /**
     * 检查绑定是否存在且已初始化。
     *
     * 为什么 initialized 为 false 时返回 false？
     *   - 对用户代码而言，TDZ 中的变量「不可见」。
     *   - 例如：typeof x 在 let x 声明之前返回 "undefined" 而非抛出错误，
     *     但 x 实际存在于词法环境中——hasBinding 返回 false 可以辅助
     *     作用域链查找的决策（跳过当前记录，去外层继续查找）。
     *
     * @param {string} name - 绑定名称
     * @returns {boolean} 绑定存在且已初始化
     */
    hasBinding(name) {
        const binding = this.bindings.get(name);
        return binding !== undefined && binding.initialized;
    }

    /**
     * 检查绑定是否已被创建（无论是否初始化）。
     *
     * 用于引擎内部判断：
     *   - 确定标识符在当前作用域内是否有声明（即使还在 TDZ 中）。
     *   - 辅助实现 typeof 运算符对 TDZ 变量的特殊处理。
     *
     * @param {string} name - 绑定名称
     * @returns {boolean} 绑定已被创建（可能未初始化）
     */
    hasUninitializedBinding(name) {
        return this.bindings.has(name);
    }

    // ── 快照（调试用）──

    /**
     * 生成当前环境记录的只读快照。
     *
     * 为什么未初始化的值显示为 '<uninitialized>'？
     *   - 调试工具需要明确区分「值为 undefined」和「尚未初始化」。
     *   - 前者说明变量已被赋值为 undefined，后者说明变量处于 TDZ。
     *   - 使用特殊字符串标记让这两种情况在调试面板中一目了然。
     *
     * @returns {object} 以绑定名称为 key 的快照对象
     */
    snapshot() {
        const bindings = {};
        for (const [name, binding] of this.bindings) {
            // undefined 会被 JSON.stringify 丢弃，用 '<undefined>' 占位保留
            const raw = binding.initialized ? binding.value : '<uninitialized>';
            bindings[name] = {
                value: raw !== undefined ? raw : '<undefined>',
                mutable: binding.mutable,
            };
        }
        return bindings;
    }
}

// ─── 对象式环境记录 ────────────────────────────────────────────────

export class ObjectEnvironmentRecord {
    /**
     * 创建一个对象式环境记录。
     *
     * 架构设计：为什么需要分离 bindingObject 和 _meta？
     *
     *   对象式环境记录的特殊之处在于：绑定值不是内部存储的，而是
     *   读写到一个「绑定对象」的属性上。典型场景是 with 语句：
     *
     *     with (someObj) { x = 42; }
     *
     *   这里 x 应该是 someObj 的属性 someObj.x，而不是某个内部变量。
     *   如果把「可变/可删/已初始化」这些元信息也存到 someObj 上，就会：
     *     1. 污染用户对象 —— 用户遍历 someObj 时会看到多余属性。
     *     2. 多级 with 嵌套时，同一个对象可能被多个环境记录引用，
     *        但每个记录的绑定属性不同。
     *
     *   因此这里采用「分离存储」模式：
     *     - bindingObject.properties (Map) —— 存储实际值和属性名
     *     - _meta (Map) —— 存储每个绑定的 mutable / deletable / initialized
     *
     *   两个 Map 以相同的 name 为 key 对齐。
     *
     * @param {object} bindingObject - 绑定对象，需提供 .properties (Map)
     *   properties 是 Map<string, any>，存储属性名到值的映射
     */
    constructor(bindingObject) {
        /**
         * 绑定对象 —— 实际的值存储在此对象的 .properties Map 中。
         * 对于全局作用域，这是 GlobalObject；对于 with 语句，这是
         * 被 with 包裹的那个对象。
         */
        this.bindingObject = bindingObject;

        /**
         * 元数据存储 —— 记录每个绑定的访问控制属性。
         * key 与 bindingObject.properties 的 key 对应。
         *
         * 为什么不在 bindingObject 上直接设置属性？
         *   避免污染对象自身，并且多个环境记录可以引用同一对象但
         *   有不同的绑定配置。
         */
        this._meta = new Map();
    }

    // ── 创建绑定 ──

    /**
     * 在绑定对象上创建一个可变绑定。
     *
     * 流程：
     *   1. 在 bindingObject.properties 中注册属性名（值暂为 undefined）
     *   2. 在 _meta 中记录该绑定的控制标志
     *
     * 与 DeclarativeEnvironmentRecord 的关键区别：
     *   绑定值存储在 bindingObject.properties 中而非内部 Map，
     *   这意味着 bindingObject 的其他用户也能看到这些属性。
     *
     * @param {string}  name      - 绑定名称
     * @param {boolean} deletable - 是否可删除
     */
    createMutableBinding(name, deletable = true) {
        // 在绑定对象上预注册属性 —— 值为 undefined，此时处于 TDZ
        this.bindingObject.properties.set(name, undefined);
        this._meta.set(name, { mutable: true, deletable, initialized: false });
    }

    /**
     * 在绑定对象上创建一个不可变绑定（对应 const）。
     *
     * @param {string} name - 绑定名称
     */
    createImmutableBinding(name) {
        this.bindingObject.properties.set(name, undefined);
        this._meta.set(name, { mutable: false, deletable: false, initialized: false });
    }

    // ── 初始化绑定 ──

    /**
     * 初始化绑定的值，解除 TDZ。
     *
     * 为什么这里对 meta 不存在的情况做了容错（if (meta)）？
     *   - 有些属性可能是直接添加到 bindingObject 上而非通过
     *     createMutableBinding 创建的（如全局对象的内置属性）。
     *   - 这些属性的 _meta 条目不存在，但 initializeBinding 仍应
     *     正常设置值而不崩溃。
     *
     * @param {string} name  - 绑定名称
     * @param {*}      value - 初始化的值
     * @throws {ReferenceError} 如果属性不在 bindingObject 中
     */
    initializeBinding(name, value) {
        const meta = this._meta.get(name);

        // 检查属性是否存在于绑定对象上
        if (!this.bindingObject.properties.has(name)) {
            throw new ReferenceError(`${name} is not defined`);
        }

        // 在绑定对象上设置实际值 —— 这是 with 语句能「写回」对象的关键
        this.bindingObject.properties.set(name, value);

        // 容错处理：对于没有 meta 条目的属性（如内置属性），跳过初始化标记
        if (meta) meta.initialized = true;
    }

    // ── 读写操作 ──

    /**
     * 修改绑定对象上的可变绑定值。
     *
     * 同样对缺失 meta 的情况做容错 —— 没有 meta 条目的属性视为可变。
     *
     * @param {string} name  - 绑定名称
     * @param {*}      value - 新值
     * @throws {ReferenceError} 如果属性不存在
     * @throws {TypeError}      如果绑定为不可变
     */
    setMutableBinding(name, value) {
        if (!this.bindingObject.properties.has(name)) {
            throw new ReferenceError(`${name} is not defined`);
        }

        const meta = this._meta.get(name);

        // 有 meta 且标记为不可变 → 抛出 TypeError（模拟 const 语义）
        // 没有 meta → 视为可变（向后兼容，或绑定对象自有的普通属性）
        if (meta && !meta.mutable) {
            throw new TypeError(`Assignment to constant variable: ${name}`);
        }

        this.bindingObject.properties.set(name, value);
    }

    /**
     * 从绑定对象读取属性值。
     *
     * @param {string} name - 绑定名称
     * @returns {*} 绑定的值
     * @throws {ReferenceError} 属性不存在 或 处于 TDZ
     */
    getBindingValue(name) {
        if (!this.bindingObject.properties.has(name)) {
            throw new ReferenceError(`${name} is not defined`);
        }

        const meta = this._meta.get(name);

        // 有 meta 但未初始化 → TDZ 错误
        // 没有 meta → 视为已初始化的普通属性，直接返回
        if (meta && !meta.initialized) {
            throw new ReferenceError(`Cannot access '${name}' before initialization`);
        }

        return this.bindingObject.properties.get(name);
    }

    // ── 删除操作 ──

    /**
     * 从绑定对象上删除属性。
     *
     * @param {string} name - 绑定名称
     * @returns {boolean} 是否删除成功
     */
    deleteBinding(name) {
        const meta = this._meta.get(name);

        // 有 meta 但标记为不可删除 → 静默失败（与 JS delete 行为一致）
        if (meta && !meta.deletable) return false;

        // 同时从 meta 和 bindingObject 中删除
        this._meta.delete(name);

        // 注意：bindingObject.properties.delete 是 Map.delete，返回 boolean
        return this.bindingObject.properties.delete(name);
    }

    // ── 存在性检查 ──

    /**
     * 检查绑定是否存在且已初始化。
     *
     * 逻辑：
     *   - 属性必须在 bindingObject 中存在
     *   - 如果有 meta 条目，必须 initialized === true
     *   - 没有 meta 条目视为已初始化的普通属性
     *
     * @param {string} name - 绑定名称
     * @returns {boolean}
     */
    hasBinding(name) {
        const meta = this._meta.get(name);
        return this.bindingObject.properties.has(name) && (!meta || meta.initialized);
    }

    /**
     * 检查绑定是否已被创建（无论初始化状态）。
     *
     * 对于对象式记录，只要属性在 bindingObject 中存在就算已创建。
     *
     * @param {string} name - 绑定名称
     * @returns {boolean}
     */
    hasUninitializedBinding(name) {
        return this.bindingObject.properties.has(name);
    }

    // ── 快照（调试用）──

    /**
     * 生成当前对象式环境记录的只读快照。
     *
     * 遍历 bindingObject.properties（而非 _meta），因为所有绑定
     * 最终都需要体现在绑定对象上。
     *
     * @returns {object} 以绑定名称为 key 的快照对象
     */
    snapshot() {
        const bindings = {};

        // 遍历绑定对象的所有属性（包括没有 meta 的内置属性）
        for (const [name, value] of this.bindingObject.properties) {
            const meta = this._meta.get(name);

            bindings[name] = {
                // 有 meta 但未初始化 → 特殊标记；否则显示实际值
                // undefined 会被 JSON 丢弃，用 '<undefined>' 占位
                value: meta && !meta.initialized ? '<uninitialized>' : (value !== undefined ? value : '<undefined>'),

                // 没有 meta = 普通属性 → 默认视为可变（与 setMutableBinding 一致）
                mutable: meta ? meta.mutable : true,
            };
        }

        return bindings;
    }
}
