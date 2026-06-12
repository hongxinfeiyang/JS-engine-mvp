/**
 * 共享类型枚举常量
 *
 * 本文件定义了引擎所有模块共用的枚举值，包括：
 * - AST 节点类型 (NODE_TYPE)
 * - 变量声明种类 (VARIABLE_KIND)
 * - 运行时值类型 (VALUE_TYPE)
 * - 执行上下文类型 (EC_TYPE)
 * - this 绑定模式 (THIS_PATTERN)
 *
 * 使用字符串枚举而非数字，便于 hook 输出和调试时直接阅读。
 */

// ─── AST 节点类型 ───
// 对应 Parser 生成的 25 种 AST 节点，Evaluator 据此分派求值逻辑
export const NODE_TYPE = {
    // 语句类 (9 种)
    PROGRAM: 'Program',
    VARIABLE_DECLARATION: 'VariableDeclaration',
    FUNCTION_DECLARATION: 'FunctionDeclaration',
    FUNCTION_EXPRESSION: 'FunctionExpression',
    ARROW_FUNCTION_EXPRESSION: 'ArrowFunctionExpression',
    BLOCK_STATEMENT: 'BlockStatement',
    EXPRESSION_STATEMENT: 'ExpressionStatement',
    RETURN_STATEMENT: 'ReturnStatement',
    IF_STATEMENT: 'IfStatement',
    FOR_STATEMENT: 'ForStatement',
    WHILE_STATEMENT: 'WhileStatement',

    // 表达式类 (14 种)
    LITERAL: 'Literal',
    IDENTIFIER: 'Identifier',
    BINARY_EXPRESSION: 'BinaryExpression',
    LOGICAL_EXPRESSION: 'LogicalExpression',
    UNARY_EXPRESSION: 'UnaryExpression',
    ASSIGNMENT_EXPRESSION: 'AssignmentExpression',
    CALL_EXPRESSION: 'CallExpression',
    MEMBER_EXPRESSION: 'MemberExpression',
    THIS_EXPRESSION: 'ThisExpression',
    NEW_EXPRESSION: 'NewExpression',
    OBJECT_EXPRESSION: 'ObjectExpression',
    ARRAY_EXPRESSION: 'ArrayExpression',
    UPDATE_EXPRESSION: 'UpdateExpression',
    CONDITIONAL_EXPRESSION: 'ConditionalExpression',
};

// ─── 变量声明类型 ───
// 对应 var / let / const 三种声明，决定 hoisting 行为和绑定可变性
export const VARIABLE_KIND = {
    VAR: 'var',       // 函数/全局作用域，初始化为 undefined
    LET: 'let',       // 块作用域，未初始化（TDZ）
    CONST: 'const',   // 块作用域，不可重新赋值
};

// ─── 运行时值类型标签 ───
// 模拟 ECMAScript 语言类型，用于 Memory 堆中的类型标注
export const VALUE_TYPE = {
    NUMBER: 'number',
    STRING: 'string',
    BOOLEAN: 'boolean',
    NULL: 'null',
    UNDEFINED: 'undefined',
    OBJECT: 'object',     // 普通对象（含 Map 属性）
    FUNCTION: 'function', // 函数对象（含 closure 引用）
    ARRAY: 'array',       // 数组对象（含 elements 列表）
};

// ─── 执行上下文类型 ───
// 决定变量声明的目标环境（var → 函数/全局 EC，let/const → 当前 block EC）
export const EC_TYPE = {
    GLOBAL: 'global',
    FUNCTION: 'function',
    BLOCK: 'block',
};

// ─── this 绑定模式 ───
// 标识 this 值是通过哪种规则确定的，用于 hook 输出的 pattern 字段
export const THIS_PATTERN = {
    GLOBAL: 'global',         // 全局作用域（或独立函数调用）
    METHOD_CALL: 'method-call', // obj.method() 隐式绑定
    NEW: 'new',               // new Fn() 构造调用
    EXPLICIT: 'explicit',     // fn.call/apply/bind 显式绑定
    ARROW: 'arrow',           // 箭头函数词法捕获
    DEFAULT: 'default',       // 默认绑定（非严格模式 → globalObject）
};
