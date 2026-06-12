/**
 * Value.js —— 运行时“值”的封装与工具函数
 *
 * 本模块不直接定义“Value 类”，而是提供一组纯函数，用来在
 * 宿主（JavaScript 引擎本身）与模拟的 ES 运行时之间执行类型判断、
 * 引用创建、真值检测等通用操作。
 *
 * 设计思路：
 * - 模拟 ES 规范中的“引用（Reference）”概念，用一个带有 Symbol 标签
 *   的普通对象来表示对堆中某个地址的引用。
 * - 所有函数都保持无副作用，方便在 AST 求值器各处组合调用。
 */

import { VALUE_TYPE } from '../types.js';

// ─── 引用（Reference）标记 ───────────────────────────────────────────────
//
// 在 ES 规范中，Reference 是规范类型，用来描述“变量名绑定到哪个
// 存储位置”的信息。这里用 Symbol 作为标记，避免和用户数据中的
// 任意字段冲突——Symbol 是不可伪造的键。

/**
 * 用于标记一个对象为“引用（Reference）”的 Symbol 键。
 *
 * 为什么用 Symbol 而不是字符串？
 * Symbol 在 JS 引擎中是唯一的、不可枚举的，不会被 JSON.stringify
 * 或 for...in 意外暴露，能最安全地充当内部标记。
 */
const REF_TAG = Symbol('ref');

// ─── 引用检测 ───────────────────────────────────────────────────────────

/**
 * 判断一个值是否为“引用（Reference）”类型。
 *
 * @param {*} value - 任意 JS 值
 * @returns {boolean} 当 value 是通过 makeRef 创建的引用对象时返回 true
 *
 * 为什么这样设计？
 * 引用对象在堆中代理真实值，求值时必须先“解引用”才能拿到实际数据。
 * 此函数作为解引用操作的“前置判断点”，每次变量访问都会调用。
 */
export function isReference(value) {
    return value !== null && typeof value === 'object' && REF_TAG in value;
}

// ─── 原始值检测 ─────────────────────────────────────────────────────────

/**
 * 判断一个值是否为“原始值”（Primitive）——即非引用类型。
 *
 * 在 ES 规范中，null 虽然 typeof 返回 "object"，但它属于 primitive。
 * 此函数专门处理了这个边界情况。
 *
 * @param {*} value - 任意值
 * @returns {boolean}
 */
export function isPrimitive(value) {
    return !isReference(value) || value === null;
}

// ─── 引用构造与解引用 ────────────────────────────────────────────────────

/**
 * 创建一个引用（Reference）对象，指向堆中的某个地址。
 *
 * 在赋值表达式左侧出现标识符时，我们不能直接求值出存储内容，
 * 而需要保留“地址”——这使得 PutValue 能找到正确的位置写入新值。
 *
 * @param {string|number} address - 堆中的存储地址
 * @returns {{ [REF_TAG]: true, address }} 引用对象
 */
export function makeRef(address) {
    return { [REF_TAG]: true, address };
}

/**
 * 从引用对象中提取出堆地址。
 *
 * 使用时总是先调用 isReference 检测，然后才调用此函数获取地址。
 *
 * @param {{ [REF_TAG]: true, address }} ref - makeRef 创建的引用对象
 * @returns {string|number} 堆地址
 */
export function getRefAddress(ref) {
    return ref.address;
}

// ─── 类型推断 ───────────────────────────────────────────────────────────

/**
 * 获取运行时值的规范类型（VALUE_TYPE 枚举成员之一）。
 *
 * 设计要点：
 * - null / undefined 在 ES 中既是值也是类型，因此优先检测。
 * - 若检测到是引用，先返回 OBJECT 作为默认类型——真正的类型
 *   存储在堆条目中，后续堆查找会覆盖此结果。
 * - 其余情况直接复用 JS 宿主的 typeof 作为高效回退。
 *
 * @param {*} value - 任意值
 * @returns {string} VALUE_TYPE 中的类型标识符
 */
export function getType(value) {
    if (value === null) return VALUE_TYPE.NULL;
    if (value === undefined) return VALUE_TYPE.UNDEFINED;
    if (isReference(value)) {
        // 引用对象本身的 typeof 是 object，真正类型存在堆条目中；
        // 这里返回 OBJECT 作为占位，调用方在解引用后应当用堆记录的类型覆盖。
        return VALUE_TYPE.OBJECT;
    }
    const t = typeof value;
    if (t === 'number') return VALUE_TYPE.NUMBER;
    if (t === 'string') return VALUE_TYPE.STRING;
    if (t === 'boolean') return VALUE_TYPE.BOOLEAN;
    return t;
}

// ─── 真值判断 ───────────────────────────────────────────────────────────

/**
 * 判断值在布尔上下文中的“真值性”（Truthiness）。
 *
 * 严格按照 ECMA-262 规范的 ToBoolean 抽象操作实现：
 * 仅以下值为 false：null、undefined、false、0、NaN、空字符串。
 * 所有对象（包括引用对象）均为 true。
 *
 * @param {*} value - 任意值
 * @returns {boolean} 若值在布尔上下文中被视为 true 则返回 true
 */
export function isTruthy(value) {
    if (value === null || value === undefined) return false;
    if (value === false) return false;
    if (value === 0) return false;
    if (value === '') return false;
    if (typeof value === 'number' && isNaN(value)) return false;
    return true;
}
