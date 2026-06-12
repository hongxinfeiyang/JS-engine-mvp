/**
 * 内存管理模块 —— 模拟 JavaScript 引擎的堆（Heap）内存
 *
 * 设计目标：
 *   为本项目这个「教学向 JS 引擎」提供一个最小但足够真实的内存抽象层。
 *   真实的 JS 引擎（如 V8）拥有分代 GC、隐藏类（Hidden Class）、指针压缩等
 *   复杂机制，这里用 Map + 自增地址的方式将其简化到可理解的核心模型：
 *
 *     - 每个值存储在堆上的一个「槽位」中，由数字地址唯一标识。
 *     - 所有环境记录（EnvironmentRecord）持有的不是原始值，而是堆地址。
 *     - 引用计数（refCount）为后续实现 GC 预留接口。
 *     - Hook 机制贯穿所有操作，支持调试可视化、执行追踪等外部观察者。
 *
 * 为什么用 Map 而不是数组 / 对象？
 *   - Map 的 key 可以是任意值（这里用 number），删除不会产生空洞。
 *   - 删除操作为 O(1)，比稀疏数组更符合「堆分配/释放」的语义。
 *   - Map 保持插入顺序，对 snapshot 遍历友好。
 *
 * 为什么用自增整数作地址而不是「指针」？
 *   - 这是教学引擎，运行在宿主 JS 引擎之上，无法操作真实内存地址。
 *   - 自增整数简单、可预测，方便在调试工具中追踪每个分配。
 *
 * 为什么对外暴露 refCount？
 *   - GC 通常和内存管理器紧密耦合，把 refCount 放在 entry 里让 GC
 *     模块可以直接读写，避免跨模块频繁查表。
 *
 * @module Memory
 */

import { HookEvents } from '../hooks/HookEvents.js';

// ─── Memory 类 ────────────────────────────────────────────────────────

export class Memory {
    /**
     * 创建一个堆内存管理器实例。
     *
     * @param {object} hooks - 事件钩子系统实例，用于对外广播内存操作事件。
     *   hooks 上需提供 emit(eventName, payload) 方法。
     */
    constructor(hooks) {
        // ── 依赖注入：hooks 由外部传入，实现控制反转 ──
        // 这样 Memory 无需知道谁是事件的消费者（调试器？GC？可视化面板？），
        // 只负责在关键节点「喊一声」，由 hooks 系统路由给已注册的监听器。
        this.hooks = hooks;

        // ── 堆存储：Map<address, Entry> ──
        // Entry 结构：{ type: string, value: any, refCount: number }
        // type 记录值的 ECMAScript 类型标签（如 "number", "object", "string"），
        // 方便 GC 和调试工具按类型做差异化处理。
        this.heap = new Map();

        // ── 地址分配器：从 1 开始，0 保留为「空地址」语义 ──
        // 真实引擎中 0x0 常表示 null / undefined 的内部标记。
        // 这里保持相同惯例，让调试输出更直观。
        this.nextAddress = 1;
    }

    // ─── 核心操作：分配（Allocate）──────────────────────────────

    /**
     * 在堆上分配一块新内存，返回其地址。
     *
     * 设计要点：
     *   - refCount 初始为 1，因为分配者至少持有一个引用。
     *   - 调用方负责在不再使用时调用 free() 或由 GC 扫描回收。
     *
     * @param {string} type  - ECMAScript 类型标签，如 "number"、"object"、"string"
     * @param {*}      value - 要存储的值
     * @returns {number} 分配的堆地址
     */
    allocate(type, value) {
        const address = this.nextAddress++;

        // 写入堆条目：每个条目是一个「盒子」，包含类型、值和引用计数
        this.heap.set(address, { type, value, refCount: 1 });

        // 广播分配事件 —— 外部观察者（如调试面板）依赖此事件更新视图
        // _safeValue 用于防止循环引用导致序列化炸栈
        this.hooks.emit(HookEvents.MEMORY_ALLOCATE, {
            address,
            type,
            value: this._safeValue(value),
        });

        return address;
    }

    // ─── 核心操作：读取（Read）────────────────────────────────

    /**
     * 读取指定地址的堆条目。
     *
     * 为什么返回整个 entry 而不只是 value？
     *   - 调用方（如 EnvironmentRecord、GC）可能需要同时访问 type 和 refCount。
     *   - 避免二次查表，减少方法调用开销。
     *
     * @param {number} address - 堆地址
     * @returns {{ type: string, value: *, refCount: number }} 堆条目
     * @throws {Error} 当地址不存在时抛出（空指针访问模拟）
     */
    read(address) {
        const entry = this.heap.get(address);

        // 模拟真实引擎中的「段错误」—— 访问无效地址应尽早暴露 bug
        if (!entry) {
            throw new Error(`Memory read error: no entry at address ${address}`);
        }

        this.hooks.emit(HookEvents.MEMORY_READ, {
            address,
            type: entry.type,
            value: this._safeValue(entry.value),
        });

        return entry;
    }

    // ─── 核心操作：写入（Write）────────────────────────────────

    /**
     * 更新指定地址的类型和值，原地修改（mutation）。
     *
     * 设计说明 —— 为什么允许原地修改？
     *   - JS 规范中变量重新赋值（如 `x = 5`）不需要移动堆位置，
     *     只需更新同一个绑定槽位的值。这里模拟相同语义。
     *   - 对于对象属性的修改（如 `obj.x = 1`），对象本身地址不变，
     *     只有属性值发生变化，原地修改更符合直觉。
     *   - refCount 不变：引用方没变，只是引用指向的内容变了。
     *
     * @param {number} address - 堆地址
     * @param {string} type    - 新的 ECMAScript 类型标签
     * @param {*}      value   - 新值
     * @throws {Error} 当地址不存在时抛出
     */
    write(address, type, value) {
        const entry = this.heap.get(address);

        if (!entry) {
            throw new Error(`Memory write error: no entry at address ${address}`);
        }

        const oldValue = entry.value;
        entry.type = type;
        entry.value = value;

        // 广播写入事件，携带新旧值方便实现「撤销/重做」或 diff 展示
        this.hooks.emit(HookEvents.MEMORY_WRITE, {
            address,
            type,
            oldValue: this._safeValue(oldValue),
            newValue: this._safeValue(value),
        });
    }

    // ─── 核心操作：释放（Free）────────────────────────────────

    /**
     * 释放指定地址的堆条目。
     *
     * 注意：当前实现为简单删除，不做任何安全检查。
     * 在完整的 GC 实现中，这里应该由 GC 在确认 refCount === 0 后调用，
     * 而非由用户代码直接调用。
     *
     * @param {number} address - 要释放的堆地址
     */
    free(address) {
        this.heap.delete(address);
        this.hooks.emit(HookEvents.MEMORY_FREE, { address });
    }

    // ─── 查询辅助方法 ─────────────────────────────────────────

    /**
     * 获取堆条目（不触发事件），用于内部只读查询。
     *
     * 为什么单独提供「静默」读方法？
     *   - read() 会触发 hook 事件，GC 在标记阶段需要大量读操作，
     *     如果每次都广播事件会产生严重的性能和噪音问题。
     *   - getEntry() 是纯粹的查询，调用方自行决定是否需要广播。
     *
     * @param {number} address - 堆地址
     * @returns {object|undefined} 堆条目，不存在时返回 undefined
     */
    getEntry(address) {
        return this.heap.get(address);
    }

    /**
     * 判断指定地址是否存在有效条目。
     *
     * @param {number} address - 堆地址
     * @returns {boolean}
     */
    has(address) {
        return this.heap.has(address);
    }

    // ─── 快照（调试用）─────────────────────────────────────────

    /**
     * 生成当前堆的完整快照（浅拷贝），用于调试面板展示。
     *
     * 为什么返回普通对象而非 Map？
     *   - JSON 序列化 / console.table 对普通对象的支持更好。
     *   - 调试面板不需要 Map 的迭代器接口。
     *
     * @returns {object} 以地址为 key 的快照对象
     */
    snapshot() {
        const snap = {};
        for (const [addr, entry] of this.heap) {
            snap[addr] = {
                type: entry.type,
                value: this._safeValue(entry.value),
                refCount: entry.refCount,
            };
        }
        return snap;
    }

    // ─── 安全值转换（防止序列化炸栈）──────────────────────────

    /**
     * 将堆中的值转换为「安全可序列化」的形式。
     *
     * 这是整个模块中最关键的防御性设计：
     *
     *   问题 —— 循环引用：
     *     对象 A 的属性指向对象 B，B 的属性又指向 A。
     *     当 hook 事件试图序列化这种值时，JSON.stringify 会抛
     *     "Converting circular structure to JSON" 错误。
     *
     *   解决方案（分层处理）：
     *     1. 值带有 address 字段且值为 number 时，判定为本引擎的堆引用
     *        对象，输出 `<ref:地址>` 避免展开。
     *     2. 普通对象：用 try/catch 包裹 JSON.parse(JSON.stringify())，
     *        成功则返回深拷贝（断开与原对象的引用），失败则退化为
     *        String(value) —— 至少能显示 "[object Object]"。
     *     3. 数组：递归处理每个元素，因为数组中也可能包含堆引用对象。
     *     4. 原始值：原样返回。
     *
     *   为什么用 JSON.parse(JSON.stringify) 深拷贝？
     *     - 简单且内置，不需要引入 lodash.cloneDeep。
     *     - 深拷贝确保 hook 回调拿到的快照是「那一刻」的值，
     *       不会因为后续代码修改而被意外改变（时间旅行调试的关键）。
     *
     * @param {*} value - 堆中存储的原始值
     * @returns {*}      安全可序列化的值
     */
    _safeValue(value) {
        // 情况 1：值为 null —— 直接返回
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {

            // 情况 1a：堆引用对象 —— 用 <ref:地址> 代替，防止无限展开
            if ('address' in value && typeof value.address === 'number') {
                return `<ref:${value.address}>`;
            }

            // 情况 1b：将 Map 转为普通对象后再序列化
            // JSON.stringify 会把 Map 序列化为 {}，丢失全部属性
            const replacer = (key, val) => {
                if (val instanceof Map) {
                    const obj = {};
                    for (const [k, v] of val) obj[k] = v;
                    return obj;
                }
                return val;
            };

            try {
                return JSON.parse(JSON.stringify(value, replacer));
            } catch {
                return String(value);
            }
        }

        // 情况 2：数组 —— 递归安全化每个元素
        // 不能把整个数组丢进上述分支，因为 Array.isArray 被排除了
        if (Array.isArray(value)) {
            return value.map(v => this._safeValue(v));
        }

        // 情况 3：原始值（number, string, boolean, undefined, null）
        // 这些值没有引用问题，原样返回
        return value;
    }
}
