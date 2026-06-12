/**
 * ASTNode — 抽象语法树节点工厂模块
 *
 * 本模块为 JS 引擎的解析器（Parser）提供了一系列工厂函数，每种 ES 语法结构
 * 对应一个工厂，返回值是统一形状的 AST 节点对象。
 *
 * 设计理念：
 *   1. 每个节点包含 `type`（来自 NODE_TYPE 枚举）和唯一的 `id`，后者用于调试、
 *      可视化渲染、以及 React/Vue 等框架的 key 绑定场景。
 *   2. 采用“工厂函数”而非 class，因为 AST 节点是纯数据对象，没有任何方法。
 *      这与 ESTree / Babel 的 AST 规范一致，也方便序列化为 JSON。
 *   3. `createNode` 内部函数封装了 `type + id + spread props` 的通用流程，
 *      确保所有节点的 type/id 格式统一，避免各工厂函数各自为政。
 *   4. `nodeIdCounter` 是从 0 开始的模块级自增计数器 —— 不使用 UUID 是为了：
 *      - 保持 id 紧凑可读（0, 1, 2...）
 *      - 在调试时通过 id 大小直接推断节点的创建顺序
 *      - 避免导入 crypto 模块，保持零依赖
 *
 * 函数分类：
 *   - Statements（语句节点）：Program, VariableDeclaration, BlockStatement 等
 *   - Expressions（表达式节点）：Literal, Identifier, BinaryExpression 等
 */

import { NODE_TYPE } from '../types.js';

// ─── 全局计数器 ──────────────────────────────────────────────────────────────
// 模块级自增 ID，每个节点分配唯一序号。
// 不使用 Symbol/闭包隐藏它，因为：
//   - 测试代码可能需要重置计数器来获得确定性的输出
//   - 它是模块私有的（外部无法 import），不会污染全局

let nodeIdCounter = 0;

// ─── 内部工厂 ────────────────────────────────────────────────────────────────
// createNode 是本模块的核心，所有导出函数最终都调用它。
// 分离出这个内部函数而不是在每个导出函数里手动拼接对象，
// 是为了保证 type/id 字段的顺序和形式完全统一。

/**
 * 创建一个 AST 节点（内部函数，不导出）
 *
 * @param {string} type - 节点类型，来自 NODE_TYPE 枚举
 * @param {object} [props={}] - 节点特有的属性（key-value 对被展开到节点对象上）
 * @returns {object} 统一的 AST 节点对象 { type, id, ...props }
 */
function createNode(type, props = {}) {
    return {
        type,
        id: nodeIdCounter++,   // 先赋值当前值，再自增
        ...props,
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// Statements — 语句节点工厂
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Program（程序根节点）
 *
 * 位于 AST 顶层，是所有语句的容器。body 是一个子节点数组。
 * 每个有效的 JS 源码解析后，最外层必定是 Program 节点。
 *
 * @param {object[]} body - 程序的语句/模块项列表
 * @returns {object} Program 节点
 */
export function Program(body) {
    return createNode(NODE_TYPE.PROGRAM, { body });
}

/**
 * VariableDeclaration（变量声明语句）
 *
 * 对应 var / let / const 声明。注意：
 *   - kind 取值 'var' | 'let' | 'const'，由解析器根据关键字传入
 *   - declarations 是 VariableDeclarator 数组（一个声明语句可以同时声明多个变量，
 *     例如 let a = 1, b = 2; 会生成一个节点含两个 declarator）
 *
 * @param {string} kind - 声明种类：'var' | 'let' | 'const'
 * @param {object[]} declarations - VariableDeclarator 数组
 * @returns {object} VariableDeclaration 节点
 */
export function VariableDeclaration(kind, declarations) {
    return createNode(NODE_TYPE.VARIABLE_DECLARATION, { kind, declarations });
}

/**
 * VariableDeclarator（单个变量声明器）
 *
 * 这是 ESTree 的命名惯例：一个 declarator = 标识符 + 初始化值。
 * 注意：VariableDeclarator 不调用 createNode，因为它不是独立的 AST 节点
 *  —— 它始终作为 VariableDeclaration.declarations 的子元素存在。
 *
 * @param {object} id - Identifier 节点（变量名）
 * @param {object|null} init - 初始化表达式节点，无初始值时（如 let a;）为 null
 * @returns {object} { id, init } 声明器描述对象
 */
export function VariableDeclarator(id, init) {
    return { id, init };
}

/**
 * FunctionDeclaration（函数声明）
 *
 * 对应 function foo() {} 形式的函数声明。
 * 函数声明的语义特性（在 ES 规范中）：
 *   - 存在“提升”（hoisting）：声明会在所在作用域的代码执行前处理
 *   - 与 var 不同，函数声明是整体提升（包括函数体）
 *
 * @param {object} id - Identifier 节点（函数名）
 * @param {object[]} params - 形参 Identifier 节点数组
 * @param {object} body - BlockStatement 节点（函数体）
 * @returns {object} FunctionDeclaration 节点
 */
export function FunctionDeclaration(id, params, body) {
    return createNode(NODE_TYPE.FUNCTION_DECLARATION, { id, params, body });
}

/**
 * FunctionExpression（函数表达式）
 *
 * 对应 const f = function foo() {} 或 const f = function() {} 中的函数表达式。
 * id 可以为 null（匿名函数表达式）。
 *
 * @param {object|null} id - Identifier 节点或 null
 * @param {object[]} params - 形参列表
 * @param {object} body - BlockStatement 节点
 * @returns {object} FunctionExpression 节点
 */
export function FunctionExpression(id, params, body) {
    return createNode(NODE_TYPE.FUNCTION_EXPRESSION, { id, params, body });
}

/**
 * ArrowFunctionExpression（箭头函数表达式）
 *
 * 箭头函数与普通函数在 ES 规范中有本质区别：
 *   - 没有自己的 this（从外层词法作用域继承）
 *   - 没有 arguments 对象
 *   - 不能用作构造函数
 * 这些差异在 Evaluator 中处理，AST 节点本身只记录语法结构。
 *
 * @param {object[]} params - 形参列表
 * @param {object} body - 函数体（可能是 BlockStatement 或表达式）
 * @returns {object} ArrowFunctionExpression 节点
 */
export function ArrowFunctionExpression(params, body) {
    return createNode(NODE_TYPE.ARROW_FUNCTION_EXPRESSION, { params, body });
}

/**
 * BlockStatement（块语句）
 *
 * 对应大括号包裹的语句列表 { ... }，用于函数体、if 体、循环体等。
 * 块语句在 ES 中会创建新的词法作用域（let / const 的块级作用域）。
 *
 * @param {object[]} body - 语句节点数组
 * @returns {object} BlockStatement 节点
 */
export function BlockStatement(body) {
    return createNode(NODE_TYPE.BLOCK_STATEMENT, { body });
}

/**
 * ExpressionStatement（表达式语句）
 *
 * 将表达式包装成语句的容器。例如 `foo();` 被解析为
 * ExpressionStatement { expression: CallExpression { ... } }。
 * 这是 ES 语法中“任何表达式后加分号即为语句”的体现。
 *
 * @param {object} expression - 表达式节点
 * @returns {object} ExpressionStatement 节点
 */
export function ExpressionStatement(expression) {
    return createNode(NODE_TYPE.EXPRESSION_STATEMENT, { expression });
}

/**
 * ReturnStatement（return 语句）
 *
 * argument 为 null 时表示 return;（没有返回值，隐式返回 undefined）。
 *
 * @param {object|null} argument - 返回值表达式节点或 null
 * @returns {object} ReturnStatement 节点
 */
export function ReturnStatement(argument) {
    return createNode(NODE_TYPE.RETURN_STATEMENT, { argument });
}

/**
 * IfStatement（if 语句）
 *
 * alternate 为 null 时表示没有 else 分支。
 * 每个分支可能是一个 BlockStatement 或单个语句；
 * 解析器负责确保 consequent/alternate 是有效语句节点。
 *
 * @param {object} test - 条件表达式节点
 * @param {object} consequent - if 分支体
 * @param {object|null} alternate - else 分支体或 null
 * @returns {object} IfStatement 节点
 */
export function IfStatement(test, consequent, alternate) {
    return createNode(NODE_TYPE.IF_STATEMENT, { test, consequent, alternate });
}

/**
 * ForStatement（传统 for 循环）
 *
 * 对应 for (init; test; update) body。
 * init 可以是 VariableDeclaration 或表达式，也可以为 null（如 for (; i < 10; i++)）。
 * test 为 null 时表示无限循环条件（始终为 true）。
 * update 为 null 时表示没有更新表达式。
 *
 * @param {object|null} init - 初始化节点
 * @param {object|null} test - 条件表达式节点
 * @param {object|null} update - 更新表达式节点
 * @param {object} body - 循环体语句/块节点
 * @returns {object} ForStatement 节点
 */
export function ForStatement(init, test, update, body) {
    return createNode(NODE_TYPE.FOR_STATEMENT, { init, test, update, body });
}

/**
 * WhileStatement（while 循环）
 *
 * 对应 while (test) body。
 * 与 for 循环不同，while 没有内建的初始化/更新部分，
 * 这在求值时的循环控制逻辑中需要区别对待。
 *
 * @param {object} test - 条件表达式节点
 * @param {object} body - 循环体语句/块节点
 * @returns {object} WhileStatement 节点
 */
export function WhileStatement(test, body) {
    return createNode(NODE_TYPE.WHILE_STATEMENT, { test, body });
}

// ══════════════════════════════════════════════════════════════════════════════
// Expressions — 表达式节点工厂
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Literal（字面量）
 *
 * value 可以是数字、字符串、布尔值、null 等原始值。
 * 正则表达式字面量 /regex/ 也被归为 Literal 类型。
 * 注意：undefined 是 Identifier 而不是 Literal（在 ES 中 undefined 是可写的全局属性）。
 *
 * @param {*} value - 字面量的 JS 原始值
 * @returns {object} Literal 节点
 */
export function Literal(value) {
    return createNode(NODE_TYPE.LITERAL, { value });
}

/**
 * Identifier（标识符）
 *
 * 用于变量名、函数名、属性名等所有需要名称绑定的地方。
 * 在语义分析阶段，Identifier 节点会被“解析” —— 沿作用域链查找对应绑定。
 *
 * @param {string} name - 标识符名称
 * @returns {object} Identifier 节点
 */
export function Identifier(name) {
    return createNode(NODE_TYPE.IDENTIFIER, { name });
}

/**
 * BinaryExpression（二元表达式）
 *
 * 对应 +、-、*、/、>、<、=== 等二元运算符。
 * 参数 left 和 right 分别为左、右操作数节点。
 *
 * @param {string} operator - 运算符字符串（如 '+'、'*'、'==='）
 * @param {object} left - 左操作数节点
 * @param {object} right - 右操作数节点
 * @returns {object} BinaryExpression 节点
 */
export function BinaryExpression(operator, left, right) {
    return createNode(NODE_TYPE.BINARY_EXPRESSION, { operator, left, right });
}

/**
 * LogicalExpression（逻辑表达式）
 *
 * 对应 && 和 || 运算符。
 * 与 BinaryExpression 分开的原因：
 *   - 逻辑表达式有短路求值语义（&& 左边为 falsy 时跳过右边，
 *     || 左边为 truthy 时跳过右边）
 *   - 返回值不一定是布尔值（a && b 返回 a 或 b）
 * 这些语义差别在 Evaluator 中需要特殊处理，故单列一个节点类型。
 *
 * @param {string} operator - '&&' 或 '||'
 * @param {object} left - 左操作数节点
 * @param {object} right - 右操作数节点
 * @returns {object} LogicalExpression 节点
 */
export function LogicalExpression(operator, left, right) {
    return createNode(NODE_TYPE.LOGICAL_EXPRESSION, { operator, left, right });
}

/**
 * UnaryExpression（一元表达式）
 *
 * 对应 !、-、+、typeof、void、delete 等一元运算符。
 * argument 是被作用的表达式节点。
 *
 * @param {string} operator - 一元运算符
 * @param {object} argument - 操作数节点
 * @returns {object} UnaryExpression 节点
 */
export function UnaryExpression(operator, argument) {
    return createNode(NODE_TYPE.UNARY_EXPRESSION, { operator, argument });
}

/**
 * AssignmentExpression（赋值表达式）
 *
 * 对应 =、+=、-=、*= 等赋值运算符。
 * left 必须是合法的左值（Identifier 或 MemberExpression），
 * 赋值表达式本身也返回右操作数的值，因此可以链式赋值。
 *
 * @param {string} operator - 赋值运算符（如 '='、'+='）
 * @param {object} left - 左值节点（赋值目标）
 * @param {object} right - 右操作数节点（新值）
 * @returns {object} AssignmentExpression 节点
 */
export function AssignmentExpression(operator, left, right) {
    return createNode(NODE_TYPE.ASSIGNMENT_EXPRESSION, { operator, left, right });
}

/**
 * CallExpression（函数调用表达式）
 *
 * callee 可以是一个 Identifier（如 foo()）、MemberExpression（如 obj.method()）
 * 或任何求值结果是函数的表达式。
 * args 是实参节点数组。
 *
 * @param {object} callee - 被调用表达式节点
 * @param {object[]} args - 实参节点数组
 * @returns {object} CallExpression 节点
 */
export function CallExpression(callee, args) {
    return createNode(NODE_TYPE.CALL_EXPRESSION, { callee, args });
}

/**
 * MemberExpression（成员访问表达式）
 *
 * 对应点号访问 obj.prop 和方括号访问 obj[expr]。
 * computed 标志区分两种访问方式：
 *   - computed === false: obj.prop（点号访问，property 是 Identifier）
 *   - computed === true:  obj[expr]（方括号访问，property 是表达式）
 * 默认 computed = false，因为点号访问更常见，让调用方代码更简洁。
 *
 * @param {object} object - 被访问的对象表达式节点
 * @param {object} property - 属性名（Identifier 或 表达式节点）
 * @param {boolean} [computed=false] - 是否为计算属性（方括号语法）
 * @returns {object} MemberExpression 节点
 */
export function MemberExpression(object, property, computed = false) {
    return createNode(NODE_TYPE.MEMBER_EXPRESSION, { object, property, computed });
}

/**
 * ThisExpression（this 表达式）
 *
 * this 的求值规则在 ES 中非常复杂，取决于调用方式（普通调用、方法调用、
 * 构造函数调用、箭头函数等）。AST 节点本身不携带语义信息，
 * 真实的 this 绑定由 Evaluator 根据运行时上下文决定。
 *
 * @returns {object} ThisExpression 节点
 */
export function ThisExpression() {
    return createNode(NODE_TYPE.THIS_EXPRESSION);
}

/**
 * NewExpression（new 调用表达式）
 *
 * 对应 new Constructor(args) 表达式。
 * 与普通 CallExpression 的区别在于求值时会：
 *   1. 创建一个新的空对象
 *   2. 将 this 绑定到该对象
 *   3. 执行构造函数体
 *   4. 自动返回新对象（除非构造函数显式返回对象）
 *
 * @param {object} callee - 构造函数表达式节点
 * @param {object[]} args - 实参节点数组
 * @returns {object} NewExpression 节点
 */
export function NewExpression(callee, args) {
    return createNode(NODE_TYPE.NEW_EXPRESSION, { callee, args });
}

/**
 * ObjectExpression（对象字面量表达式）
 *
 * 对应 { key: value, ... } 语法。
 * properties 是 Property 子节点数组，每个包含 key 和 value。
 *
 * @param {object[]} properties - 属性节点数组
 * @returns {object} ObjectExpression 节点
 */
export function ObjectExpression(properties) {
    return createNode(NODE_TYPE.OBJECT_EXPRESSION, { properties });
}

/**
 * ArrayExpression（数组字面量表达式）
 *
 * 对应 [elem1, elem2, ...] 语法。
 * elements 中的元素可以是任何表达式节点；空位（[1, , 3]）用 null 表示。
 *
 * @param {object[]} elements - 元素节点数组（空位为 null）
 * @returns {object} ArrayExpression 节点
 */
export function ArrayExpression(elements) {
    return createNode(NODE_TYPE.ARRAY_EXPRESSION, { elements });
}

/**
 * UpdateExpression（自增/自减表达式）
 *
 * 对应 ++ 和 -- 运算符。
 * prefix 标志区分前缀和后缀形式：
 *   - prefix === true:  ++x（先加后返回）
 *   - prefix === false: x++（先返回后加）
 * 默认 prefix = false，因为后缀形式（x++）在 C-like 语言中更常见。
 *
 * @param {string} operator - '++' 或 '--'
 * @param {object} argument - 操作数节点（必须是合法的左值）
 * @param {boolean} [prefix=false] - 是否为前缀形式
 * @returns {object} UpdateExpression 节点
 */
export function UpdateExpression(operator, argument, prefix = false) {
    return createNode(NODE_TYPE.UPDATE_EXPRESSION, { operator, argument, prefix });
}

/**
 * ConditionalExpression（三元条件表达式）
 *
 * 对应 test ? consequent : alternate 语法。
 * ES 中唯一的“三元运算符”，求值时有短路语义：
 * 只对 test 为真时对应的分支求值，另一个分支不会被求值。
 * 这与 if 语句类似，但三元表达式可以出现在表达式期望的位置
 * （例如赋值右侧、函数实参、模板字符串插值等）。
 *
 * @param {object} test - 条件表达式节点
 * @param {object} consequent - 条件为真时的分支
 * @param {object} alternate - 条件为假时的分支
 * @returns {object} ConditionalExpression 节点
 */
export function ConditionalExpression(test, consequent, alternate) {
    return createNode(NODE_TYPE.CONDITIONAL_EXPRESSION, { test, consequent, alternate });
}
