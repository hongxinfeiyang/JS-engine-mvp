# JS Engine MVP 开发手册

## 1. 项目概述

JS Engine MVP 使用纯 JavaScript 实现一个可追踪的 JS 引擎，包含词法分析、语法分析、解释执行三层管道，以及模拟的内存堆、调用栈和词法环境。

- **零外部依赖**：仅需 Node.js 原生功能
- **ES Module**：所有模块使用 `import/export`
- **~2500 行代码**：13 个源文件

## 2. 项目结构

```
src/
├── index.js                          # 对外 API 入口
├── types.js                          # 枚举常量定义
├── stepper.js                        # 步骤捕获器（captureSteps）
├── hooks/          → 可观测性基础设施
├── lexer/          → 词法分析（字符 → Token）
├── parser/         → 语法分析（Token → AST）
├── runtime/        → 运行时（内存、环境、EC）
└── evaluator/      → 解释器（AST → 结果）
interactive/
├── interactive.html                   # 交互式可视化页面
├── server.js                          # HTTP 服务（POST /api/execute）
└── res.md                             # 步骤追踪记录
```

### 2.1 模块依赖图

```
index.js
  ├── HookSystem.js ← HookEvents.js
  ├── Realm.js
  │     ├── Memory.js ← HookEvents.js
  │     ├── LexicalEnvironment.js
  │     │     └── EnvironmentRecord.js
  │     ├── ExecutionContext.js
  │     │     └── LexicalEnvironment.js
  │     ├── ExecutionContextStack.js
  │     └── Value.js
  │           └── types.js
  ├── Lexer.js → Token.js, TokenType.js ← HookEvents.js
  ├── Parser.js → ASTNode.js ← HookEvents.js, types.js
  └── Evaluator.js ← 所有 runtime/*, types.js, HookEvents.js
```

## 3. 如何添加新功能

### 3.1 添加新 Token 类型

1. 在 [TokenType.js](../src/lexer/TokenType.js) 添加新类型常量
2. 在 [Lexer.js](../src/lexer/Lexer.js) `_readSingleChar()` 或 `_readToken()` 中添加匹配逻辑
3. 如为关键字，在 `KEYWORDS` 表中注册

### 3.2 添加新 AST 节点

1. 在 [types.js](../src/types.js) 的 `NODE_TYPE` 添加新类型
2. 在 [ASTNode.js](../src/parser/ASTNode.js) 添加工厂函数
3. 在 [Parser.js](../src/parser/Parser.js) 添加解析方法并触发 `parse:node`
4. 在 [Evaluator.js](../src/evaluator/Evaluator.js) `evaluate()` 的 `switch` 中添加 case + 实现 `_evalXxx` 方法

### 3.3 添加新 Hook 事件

1. 在 [HookEvents.js](../src/hooks/HookEvents.js) 添加新事件名常量
2. 在相关模块中调用 `this.hooks.emit(HookEvents.NEW_EVENT, data)`
3. 后续事件会自动被 `HookSystem.getTrace()` 记录

### 3.4 扩展支持新的语句/表达式

以添加 `switch` 语句为例：

```
Step 1: types.js — 添加 SWITCH_STATEMENT 到 NODE_TYPE
Step 2: ASTNode.js — 添加 SwitchStatement(discriminant, cases) 工厂
Step 3: Parser.js — _parseStatement 中 match SWITCH → _parseSwitchStatement()
                   — 实现 _parseSwitchStatement() 解析 switch(expr) { case ... break; }
Step 4: Evaluator.js — evaluate() switch 添加 NODE_TYPE.SWITCH_STATEMENT
                      — 实现 _evalSwitchStatement(node) 求值逻辑
```

### 3.5 添加内置对象

在 [Realm.js](../src/runtime/Realm.js) 的 `_initGlobalObject()` 中：

```js
// 示例：添加 console.warn
consoleObj.properties.set('warn', (...args) => {
    console.warn(...args);
    return undefined; // console 方法返回 undefined
});
```

## 4. 调试指南

### 4.1 追踪单个表达式求值

```js
const engine = new JSEngine();
engine.on('eval:node:enter', (d) => console.log('▶', d.type, d.id));
engine.on('eval:node:exit', (d) => console.log('◀', d.type, d.id, '→', d.result));
engine.execute('40 + 2');
```

### 4.2 检查作用域链

```js
const engine = new JSEngine();
engine.execute('var a = 1; { let b = 2; var c = 3; }');

const scopeChain = engine.getScopeChain();
scopeChain.forEach((env, i) => {
    console.log(`Level ${i}:`, env.bindings);
});
```

### 4.3 检查堆内存状态

```js
const engine = new JSEngine();
engine.execute('var obj = { x: 10 };');
console.log('Heap:', engine.getMemorySnapshot());
```

### 4.4 获取完整解析信息

```js
const engine = new JSEngine();
const ast = engine.parse('var x = 10;');
console.dir(ast, { depth: 10 });
```

## 5. 常见问题

### 5.1 为什么箭头函数 this 表现异常

检查 `_evalArrowFunction` 中 `capturedThis` 是否正确。箭头函数的 this 在**定义时**从 `currentEC.thisBinding` 捕获，调用时不依赖 `.call()` 或对象方法调用模式。

### 5.2 变量找不到 (ReferenceError)

- 检查 `_resolveIdentifier` 是否在正确的 LE 链上查找
- 检查 `hasBinding` 是否因为 `initialized: false` 而返回 false（TDZ）
- 使用 `scope:chain:resolve` hook 追踪查找路径

### 5.3 Parser 报 "Expected X but got Y"

- 检查 `_match` vs `_check` 的使用：`_match` 会消耗 Token
- 使用 `parse:node` hook 观察哪些节点被成功解析

---

## 6. 代码规范

### 6.1 缩进

4 空格缩进。

### 6.2 注释

- **中文注释**：所有注释使用中文
- **JSDoc**：公开 API 标注 `@param`、`@returns`、`@example`
- **Why 注释**：核心算法解释**为什么**这么做，而非描述代码做了什么
- **分隔注释**：关键段落用 `// ─── 分隔注释 ───` 分块
- **禁止**：注释掉的废弃代码

### 6.3 命名

- 类名：PascalCase (`LexicalEnvironment`)
- 方法/变量：camelCase (`_evalProgram`)
- 私有方法：下划线前缀 (`_hoistOneDeclaration`)
- 常量：UPPER_SNAKE_CASE (`NODE_TYPE.PROGRAM`)

### 6.4 文件组织

每个文件：
1. import 语句
2. 常量/类型定义
3. 类定义
4. export 语句
