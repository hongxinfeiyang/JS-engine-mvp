/**
 * Hook 事件名常量定义
 *
 * 27 种事件覆盖引擎全流程：词法分析 → 语法分析 → 解释执行 → 内存管理
 * 命名约定：'模块:动作' 格式（例 memory:allocate、variable:declare）
 * 生命周期事件使用 '阶段:start' / '阶段:end' 配对
 */

export const HookEvents = {
    // ─── 词法分析阶段 ───
    // Lexer 事件：源码字符流 → Token 序列
    TOKENIZE_START: 'tokenize:start',
    TOKENIZE_END: 'tokenize:end',
    TOKEN: 'token',                  // 每个 Token 生成时触发（含行列号）

    // ─── 语法分析阶段 ───
    // Parser 事件：Token 序列 → AST 抽象语法树
    PARSE_START: 'parse:start',
    PARSE_END: 'parse:end',
    PARSE_NODE: 'parse:node',        // 每个 AST 节点创建时触发（含唯一 id）

    // ─── 引擎生命周期 ───
    // 一次 execute() 调用的始末
    EXECUTION_START: 'execution:start',
    EXECUTION_END: 'execution:end',

    // ─── 内存操作 ───
    // Memory 堆管理事件：所有引用类型（对象/数组/函数）在堆中分配
    MEMORY_ALLOCATE: 'memory:allocate',
    MEMORY_WRITE: 'memory:write',
    MEMORY_READ: 'memory:read',
    MEMORY_FREE: 'memory:free',

    // ─── 执行上下文 ───
    // EC 生命周期：创建阶段（绑定/hoisting/this）→ 入栈 → 执行 → 出栈
    // 创建阶段与执行阶段的分离是 ECMAScript 规范的核心概念：
    //   - 创建阶段：建立 LE/VE、hoisting、绑定参数、确定 this（尚未执行任何代码）
    //   - 执行阶段：逐条执行函数体中的语句
    // 这两个 hook 让外部可以精确区分"准备环境"和"执行代码"两个时刻
    CONTEXT_CREATION_START: 'context:creation:start',
    CONTEXT_CREATION_END: 'context:creation:end',
    CONTEXT_PUSH: 'context:push',
    CONTEXT_POP: 'context:pop',

    // ─── 变量生命周期 ───
    // 声明（hoisting 阶段或执行阶段）、赋值、读取
    VARIABLE_DECLARE: 'variable:declare',
    VARIABLE_ASSIGN: 'variable:assign',
    VARIABLE_READ: 'variable:read',

    // ─── 作用域查找 ───
    // 标识符解析时沿作用域链的查找过程
    SCOPE_LOOKUP: 'scope:lookup',             // 查找开始
    SCOPE_CHAIN_RESOLVE: 'scope:chain:resolve', // 查找完成（含深度和链快照）

    // ─── 闭包 ───
    // 函数对象创建时，捕获当前词法环境作为闭包
    CLOSURE_CREATE: 'closure:create',

    // ─── this 绑定 ───
    // 每次 this 值确定时触发，携带绑定模式（global/method-call/new/explicit/arrow）
    THIS_RESOLVE: 'this:resolve',

    // ─── 函数调用 ───
    // 函数进入和返回，携带参数和返回值
    FUNCTION_CALL: 'function:call',
    FUNCTION_RETURN: 'function:return',

    // ─── AST 节点求值 ───
    // 每个 AST 节点进入求值和退出求值时触发，id 字段关联 enter/exit 配对
    EVAL_NODE_ENTER: 'eval:node:enter',
    EVAL_NODE_EXIT: 'eval:node:exit',
};
