# JS Engine MVP 设计文档

## 1. 概述

用纯 JavaScript 实现一个可追踪的 JavaScript 引擎 MVP。核心目标不是性能，而是**可观测性**：通过 hook 系统追踪 JS 代码执行的每一个关键步骤，包括词法分析、语法分析、内存分配、执行上下文切换、变量查找、作用域链遍历、闭包捕获、this 绑定等。

### 设计原则

- **可观测性优先**：27 种 hook 事件覆盖执行全流程，所有运行时状态可通过 API 查询
- **ECMAScript 语义对齐**：hoisting、TDZ、闭包、this 绑定等行为尽量符合规范
- **分层解耦**：Lexer → Parser → Evaluator 三层管道，Runtime 层独立可替换
- **最小实现**：MVP 覆盖核心机制，prototype chain / class / try-catch 等留后续迭代

---

## 2. 总体架构

```总体架构
┌──────────────────────────────────────────────────────┐
│                     JSEngine                         │
│                                                      │
│  source ──▶ ┌──────────┐   ┌──────────┐              │
│             │  Lexer   │──▶│  Parser  │              │
│             └──────────┘   └──────────┘              │
│                  │               │                   │
│                  ▼               ▼                   │
│             ┌──────────────────────────┐             │
│             │       HookSystem         │             │
│             │  (27 events, trace log)  │             │
│             └──────────────────────────┘             │
│                         │                            │
│                         ▼                            │
│             ┌──────────────────────┐                 │
│             │     Evaluator        │                 │
│             └──────────┬───────────┘                 │
│                        │                             │
│         ┌──────────────┼──────────────┐              │
│         ▼              ▼              ▼              │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐          │
│  │  Memory  │  │  ECStack   │  │  Realm   │          │
│  │  (Heap)  │  │  (栈)      │  │  (全局)   │          │
│  └──────────┘  └────────────┘  └──────────┘          │
│         │              │              │              │
│         └──────────────┼──────────────┘              │
│                        ▼                             │
│              ┌──────────────────┐                    │
│              │   Environment    │                    │
│              │   Record / LE    │                    │
│              └──────────────────┘                    │
└──────────────────────────────────────────────────────┘
```

### 目录结构（13 个源文件，~2500 行）

```目录结构
src/
├── index.js                          # JSEngine 入口
├── types.js                          # 共享枚举常量
├── hooks/
│   ├── HookSystem.js                 # 事件注册/分发 + trace 日志
│   └── HookEvents.js                 # 27 种事件名常量
├── lexer/
│   ├── TokenType.js                  # 50+ Token 类型
│   ├── Token.js                      # Token 数据结构
│   └── Lexer.js                      # 逐字符词法分析器
├── parser/
│   ├── ASTNode.js                    # 25 种 AST 节点工厂
│   └── Parser.js                     # 递归下降 + Pratt 表达式解析
├── runtime/
│   ├── Memory.js                     # 堆内存模拟 (Map<addr, entry>)
│   ├── Value.js                      # 值类型判断 / 引用包装
│   ├── EnvironmentRecord.js          # Declarative + Object 两种实现
│   ├── LexicalEnvironment.js         # ER + outer 引用链
│   ├── ExecutionContext.js           # EC (type, LE, VE, this)
│   ├── ExecutionContextStack.js      # 调用栈
│   └── Realm.js                      # 全局对象 / 内置对象 / 初始 EC
└── evaluator/
    └── Evaluator.js                  # AST 解释器 (835 行核心逻辑)
```

---

## 3. 执行流水线

```执行流水线
源代码 (string)
  │
  ▼
Lexer.tokenize()
  ├── 逐字符扫描，跳过空白/注释
  ├── 生成 Token 序列 (Number, String, Identifier, Keyword, Operator, Punctuation)
  ├── 触发: tokenize:start → token × N → tokenize:end
  └── 返回 Token[]
  │
  ▼
Parser.parse(tokens)
  ├── 递归下降解析 Statement
  ├── Pratt parsing 处理 Expression (带优先级)
  ├── 构造 AST 节点树
  ├── 触发: parse:start → parse:node × N → parse:end
  └── 返回 AST (Program 节点)
  │
  ▼
Evaluator.evaluate(ast)
  ├── 入口: _evalProgram
  │   ├── Phase 1: 创建阶段 (Creation Phase)
  │   │   ├── 触发: context:creation:start
  │   │   ├── _hoistDeclarations → 遍历声明、创建绑定、hoist 函数
  │   │   └── 触发: context:creation:end
  │   └── Phase 2: 执行阶段 (Execution Phase)
  │       ├── 触发: context:push
  │       └── 逐条执行 Statement
  ├── 每条语句/表达式递归求值
  ├── 触发: eval:node:enter/exit × N + 各类运行时事件
  └── 返回执行结果
```

---

## 4. 内存模型

### 4.1 设计

采用**堆地址映射**方案：原始值（number, string, boolean, null, undefined）直接在栈上传递；引用值（object, array, function）在堆中分配，通过 `{ address: number }` 引用传递。

```Memory
Memory (Heap)
┌──────────────────────────────────────┐
│ address 1: { type: 'object',         │
│              value: {                │
│                properties: Map {     │
│                  'x' → 10,           │
│                  'y' → ref(2)        │
│                }                     │
│              },                      │
│              refCount: 1 }           │
│                                      │
│ address 2: { type: 'function',       │
│              value: {                │
│                type: 'regular',      │
│                name: 'foo',          │
│                params: ['a'],        │
│                body: BlockStatement, │
│                closure: LE(addr?)    │
│              },                      │
│              refCount: 1 }           │
│                                      │
│ address 3: { type: 'array',          │
│              value: {                │
│                elements: [1,2,3]     │
│              },                      │
│              refCount: 1 }           │
└──────────────────────────────────────┘
```

### 4.2 API

```js
class Memory {
  allocate(type, value) → address   // 在堆中分配，触发 memory:allocate
  read(address) → entry             // 读取堆条目，触发 memory:read
  write(address, type, value)       // 覆写堆条目，触发 memory:write
  free(address)                     // 释放堆条目，触发 memory:free
  getEntry(address) → entry|null
  snapshot() → { [addr]: entry }    // 堆快照
}
```

### 4.3 值引用约定

```js
// 原始值：直接传递
10, "hello", true, null, undefined

// 引用值：通过地址包装传递
{ [Symbol('ref')]: true, address: 1 }   // makeRef(address)

// 工具函数（Value.js）
isReference(val) → boolean           // 判断是否为引用
makeRef(address) → { address }       // 创建引用
getRefAddress(ref) → number          // 获取地址
getType(val) → string                // 获取类型标签
isTruthy(val) → boolean              // 判断真值
```

---

## 5. 词法环境与作用域链

### 5.1 EnvironmentRecord（环境记录）

两种实现，存储变量的实际绑定：

**DeclarativeEnvironmentRecord** — 函数/块作用域

```
bindings: Map<name, {
  value: any,          // 绑定的值
  mutable: boolean,    // 是否可变 (const = false)
  deletable: boolean,  // 是否可删除
  initialized: boolean // 是否已初始化 (TDZ 的关键)
}>
```

**ObjectEnvironmentRecord** — 全局环境 / with 语句

```
bindingObject: { properties: Map }  // 绑定委托到对象的属性 Map
_meta: Map<name, { mutable, deletable, initialized }>  // 元信息（TDZ 支持）
```

### 5.2 LexicalEnvironment（词法环境）

```
LexicalEnvironment {
  environmentRecord: EnvironmentRecord  // 当前环境的绑定
  outer: LexicalEnvironment | null      // 指向外部环境（构建作用域链）
}
```

### 5.3 作用域链查找

标识符解析沿 `LexicalEnvironment.outer` 链逐级向外查找：

```
_resolveIdentifier(name):
  env = current EC.lexicalEnvironment
  depth = 0
  while env:
    if env.record.hasBinding(name):
      触发 scope:chain:resolve { found: true, depth }
      触发 variable:read { name, value }
      return value
    env = env.outer
    depth++
  触发 scope:chain:resolve { found: false }
  throw ReferenceError

TDZ 检查: hasBinding() 要求 initialized === true
如果 bindings 中存在但 uninitialized → hasBinding 返回 false
→ hasUninitializedBinding 返回 true → 进入 getBindingValue → 抛出 ReferenceError
```

### 5.4 环境层级示例

```js
var a = 1;        // globalEnv (Object ER)
let b = 2;        // globalEnv (Object ER)
function foo(x) { // fooEnv (Declarative ER), outer → globalEnv
  var c = 3;      // fooEnv (var → 函数作用域)
  let d = 4;      // fooEnv (let → 函数作用域)
  {               // blockEnv (Declarative ER), outer → fooEnv
    let e = 5;    // blockEnv (let → 块作用域)
    var f = 6;    // fooEnv (var 穿透块作用域)
  }
}
```

作用域链：
```
blockEnv.outer → fooEnv.outer → globalEnv.outer → null
```

---

## 6. 执行上下文与调用栈

### 6.1 ExecutionContext（执行上下文）

```js
{
  type: 'global' | 'function' | 'block',
  lexicalEnvironment: LexicalEnvironment,   // let/const 解析
  variableEnvironment: LexicalEnvironment,  // var 解析（函数中 === LE）
  thisBinding: any,                         // 当前 this 值
  meta: { name: string },                   // 元信息
}
```

### 6.2 关键规则

| 场景 | LE | VE | 解释 |
|------|-----|-----|------|
| 全局 | globalEnv | globalEnv | 同一环境 |
| 函数调用 | 新建 localEnv | = LE | 同一环境，var/let/const 都在这 |
| BlockStatement | 新建 blockEnv(outer→当前LE) | 外层函数的 VE | var 穿透，let/const 留在块内 |
| for 循环 | 新建 loopEnv(outer→当前LE) | 外层函数的 VE | 同 block |

### 6.3 EC 入栈/出栈

```
函数调用:
  EC push { type: 'function', name, LE snapshot }  → _applyFunction → 逐条执行 → EC pop

块语句:
  EC push { type: 'block' }  →  执行块体  →  EC pop

for 循环:
  EC push { type: 'block', name: 'for' }  →  init / test / body / update  →  EC pop
```

---

## 7. Hoisting（变量提升）

### 7.1 处理机制

入口方法 `_evalProgram` 和 `_applyFunction` 显式分为两个阶段，对齐 ECMAScript 规范的 `[[Construct]]` / `EvaluateCall` 语义：

**Phase 1: 创建阶段 (Creation Phase)**

```
_evalProgram(program):
  触发 context:creation:start
  _hoistDeclarations(program.body, globalEnv)
  触发 context:creation:end
  // 进入 Phase 2
```

```
_applyFunction(funcRef, args, thisValue):
  创建 localEnv、绑定参数
  触发 context:creation:start
  _hoistDeclarations(funcObj.body.body, localEnv)
  触发 context:creation:end
  // 进入 Phase 2
```

**Phase 2: 执行阶段 (Execution Phase)**

```
  触发 context:push
  逐条执行 Statement (eval:node:enter/exit × N)
  触发 context:pop → context:return
```

**为什么需要显式分离两个阶段？**

| 维度 | 说明 |
|------|------|
| **ECMAScript 规范对齐** | 规范中 `FunctionDeclarationInstantiation` 和函数体执行是独立的算法步骤。Phase 1 对应 instantiation（创建绑定、hoist 函数），Phase 2 对应 execution（逐条求值） |
| **可观测的 Hoisting** | 通过 `context:creation:start/end` 事件，外部观察者可以精确区分"声明注册"和"代码执行"两个时间窗口。在 creation 阶段结束时，所有 var/let/const/function 声明绑定已经存在于环境中，但 let/const 仍处于 TDZ |
| **TDZ 时序可追踪** | 在 `context:creation:end` 和变量赋值之间的时间窗口内，let/const 绑定处于 TDZ。通过 creation 阶段的边界事件，可以精确界定每个变量的 TDZ 区间 |
| **闭包捕获时机** | 函数对象在 creation 阶段被创建（function declaration hoist）或 execution 阶段被创建（function expression），两者的 `[[Environment]]` 捕获时机不同。Phase 边界让闭包捕获时刻可明确标记 |

`_hoistDeclarations` 内部逻辑：

```js
_hoistDeclarations(body, targetEnv):
  for each stmt in body:
    if stmt is VariableDeclaration:
      _hoistOneDeclaration(stmt, targetEnv)
    if stmt is FunctionDeclaration:
      _hoistFunctionDeclaration(stmt, targetEnv)
```

### 7.2 三种声明行为的区别

```
var x = 1:
  1. createMutableBinding('x')           // initialized = false
  2. initializeBinding('x', undefined)   // initialized = true, value = undefined
  → 之后赋值: setMutableBinding('x', 1)

let y = 2:
  1. createMutableBinding('y')           // initialized = false (TDZ!)
  // 不调用 initializeBinding
  → 之后执行到声明语句时才 initializeBinding('y', 2)

const z = 3:
  1. createImmutableBinding('z')         // initialized = false, mutable = false
  // 不调用 initializeBinding
  → 之后执行时才 initializeBinding('z', 3)

function foo() {}:
  1. createMutableBinding('foo')
  2. createFunctionObject → 分配在堆中
  3. initializeBinding('foo', funcRef)   // 立即可用
```

### 7.3 for 循环中的 var 特殊处理

```js
for (var i = 0; i < 5; i++) { ... }
```

`var i` 不会进入 for 循环的块作用域，而是提升到外层函数/全局作用域：

```js
if (init.kind === 'var'):
  targetEnv = _getEnvForKind('var')  // 找到最近的函数/全局 EC 的 VE
  _hoistOneDeclaration(init, targetEnv)
else:
  _hoistOneDeclaration(init, loopEnv)  // let/const 进入循环块环境
```

---

## 8. 闭包

### 8.1 实现原理

函数对象创建时，捕获当前 LexicalEnvironment 作为 `[[Environment]]`：

```js
_createFunctionObject(node, closureEnv):
  funcObj = {
    type: 'regular',
    name: node.id.name,
    params: [...],
    body: node.body,
    closure: closureEnv,  // ← [[Environment]]，这就是闭包
  }
  addr = memory.allocate('function', funcObj)
  return makeRef(addr)
```

### 8.2 调用时行为

函数调用时，新创建的 LexicalEnvironment 的 `outer` 指向闭包中保存的 `[[Environment]]`：

```js
_applyFunction(funcRef, args, thisValue):
  funcObj = heap.get(funcRef).value
  localEnv = new LexicalEnvironment(funcObj.closure)  // outer = [[Environment]]
  // 绑定参数到 localEnv
  // hoist 函数体内的声明到 localEnv
  // 创建 EC 并入栈
  // 逐条执行函数体
```

### 8.3 Hook 追踪链路

```
function outer() {
  var x = 10;                           // VAR DECL x (var) → VAR SET x: 10
  return function inner() {
    return x + 1;
  };
}
var fn = outer();                        // FUNC CALL outer() → EC PUSH outer
                                         // CLOSURE inner captures [x]
                                         // EC POP outer → FUNC RET outer
fn();                                    // FUNC CALL inner() → EC PUSH inner
                                         // SCOPE LOOKUP "x" → SCOPE RES depth=1
                                         // VAR READ x = 10 → EC POP → FUNC RET 11
```

---

## 9. this 绑定

### 9.1 绑定规则（优先级从高到低）

| 优先级 | 模式 | 触发条件 | this 值 |
|--------|------|----------|---------|
| 1 (最高) | `new` | `new Constructor()` | 新创建的空对象 |
| 2 | 显式绑定 | `fn.call(obj)` / `fn.apply(obj)` / `fn.bind(obj)` | 传入的第一个参数 |
| 3 | 隐式绑定 | `obj.method()` (MemberExpression 调用) | `obj` |
| 4 | 箭头函数 | `() => {}` 定义时 | 从外层词法作用域继承 (capturedThis) |
| 5 (最低) | 默认绑定 | 独立函数调用 `fn()` | globalObject（非严格模式） |

### 9.2 实现细节

```js
// 隐式绑定识别（核心逻辑）
_resolveThisForCall(calleeNode, calleeResult):
  if calleeNode.type === 'MemberExpression':
    if propName not in ['call', 'apply', 'bind']:
      return evaluate(calleeNode.object)  // this = obj

// 显式绑定处理（call/apply/bind 特殊路径）
_evalCallExpression(node):
  if callee is MemberExpression and propName in ['call','apply','bind']:
    return _handleCallApplyBind(node, method)

// 箭头函数 — this 在定义时捕获
_evalArrowFunction(node):
  capturedThis = currentEC.thisBinding  // 从外层继承
  funcObj = { ...closure, capturedThis }
  
// 调用箭头函数时
_applyFunction:
  if funcObj.type === 'arrow':
    effectiveThis = funcObj.capturedThis  // 忽略传入的 thisValue

// bound 函数
_applyFunction:
  if funcObj.type === 'bound':
    mergedArgs = [...boundArgs, ...args]
    return _applyFunction(targetFunc, mergedArgs, boundThis)
```

### 9.3 触发 Hook

每次 this 确定时触发 `this:resolve`，携带 `pattern` (method-call / new / explicit / arrow / default) 和 `value`。

---

## 10. Hook 系统

### 10.1 HookSystem 设计

```js
class HookSystem {
  _listeners: Map<event, callback[]>  // 事件监听器
  _traceLog: TraceEntry[]             // 完整追踪日志
  _enabled: boolean                   // 开关

  on(event, callback)          // 注册监听器
  off(event, callback)         // 取消监听器
  emit(event, data)            // 触发事件 → 写入 traceLog + 调用监听器
  getTrace() → TraceEntry[]    // 获取完整追踪日志
  clearTrace()                 // 清空日志
}
```

### 10.2 全部 27 种 Hook 事件

| 阶段 | 事件名 | 触发时机 | data 载荷 |
|------|--------|----------|-----------|
| **Lexer** | `tokenize:start` | 开始词法分析 | `{ source }` |
| | `tokenize:end` | 词法分析结束 | `{ tokens }` |
| | `token` | 每个 token 生成 | `{ token: { type, value, pos, line, col } }` |
| **Parser** | `parse:start` | 开始语法分析 | `{ tokenCount }` |
| | `parse:end` | 语法分析结束 | `{ nodeCount }` |
| | `parse:node` | 每个 AST 节点创建 | `{ type, id, node }` |
| **Memory** | `memory:allocate` | 堆内存分配 | `{ address, type, value }` |
| | `memory:write` | 堆内存写入 | `{ address, type, oldValue, newValue }` |
| | `memory:read` | 堆内存读取 | `{ address, type, value }` |
| | `memory:free` | 堆内存释放 | `{ address }` |
| **Context** | `context:creation:start` | 创建阶段开始 (Phase 1: hoist) | `{ contextType, name }` |
| | `context:creation:end` | 创建阶段结束 | `{ contextType, name }` |
| | `context:push` | EC 入栈 | EC.snapshot() |
| | `context:pop` | EC 出栈 | `{ type, name }` |
| **Variable** | `variable:declare` | 声明创建 (hoisting) | `{ name, kind, initialized }` |
| | `variable:assign` | 赋值 | `{ name, oldValue, newValue }` |
| | `variable:read` | 读取 | `{ name, value }` |
| **Scope** | `scope:lookup` | 标识符解析开始 | `{ name }` |
| | `scope:chain:resolve` | 作用域链查找完成 | `{ name, found, depth, envChain }` |
| **Closure** | `closure:create` | 闭包创建 | `{ funcName, capturedVars }` |
| **this** | `this:resolve` | this 值确定 | `{ pattern, value }` |
| **Function** | `function:call` | 函数进入 | `{ name, args, thisValue }` |
| | `function:return` | 函数返回 | `{ name, value }` |
| **Eval** | `eval:node:enter` | AST 节点求值前 | `{ type, id }` |
| | `eval:node:exit` | AST 节点求值后 | `{ type, id, result }` |
| **Engine** | `execution:start` | 执行开始 | `{}` |
| | `execution:end` | 执行结束 | `{ result }` |

### 10.3 运行时状态查询 API

```js
engine.getCurrentContext()     // 当前 EC snapshot
engine.getCallStack()          // EC 栈快照
engine.getScopeChain()         // 当前作用域链 (LE 列表)
engine.getMemorySnapshot()     // 堆内存快照 { [addr]: { type, value, refCount } }
```

---

## 11. 词法分析器（Lexer）

### 11.1 Token 类型 (50+)

| 类别 | Token | 示例 |
|------|-------|------|
| 关键字 | VAR, LET, CONST, FUNCTION, RETURN, IF, ELSE, FOR, WHILE, THIS, NEW, TYPEOF, DELETE | `var`, `function`... |
| 字面量 | NUMBER, STRING, TRUE, FALSE, NULL, UNDEFINED | `42`, `"hi"`, `true` |
| 标识符 | IDENTIFIER | `foo`, `$x`, `_private` |
| 运算符 | PLUS, MINUS, MULTIPLY, DIVIDE, MODULO, ASSIGN, EQUAL, NOT_EQUAL, STRICT_EQUAL, GREATER, LESS, AND, OR, NOT, INCREMENT, DECREMENT, PLUS_ASSIGN... | `+`, `===`, `&&`, `++`... |
| 分隔符 | LPAREN, RPAREN, LBRACE, RBRACE, LBRACKET, RBRACKET, SEMICOLON, COMMA, DOT, COLON, QUESTION | `(`, `{`, `;`... |
| 特殊 | ARROW, EOF | `=>` |

### 11.2 扫描规则

- 空白字符（空格、\t、\r）跳过
- 换行 `\n` 更新行列号
- 单行注释 `//` 和多行注释 `/* */` 跳过
- 数字：整数 + 可选小数部分
- 字符串：`"..."` 或 `'...'`，支持 `\n` `\t` `\\` 等转义
- 标识符/关键字：`[a-zA-Z_$][a-zA-Z0-9_$]*`，关键字优先匹配
- 运算符：先尝试 3 字符 (`===`)，再 2 字符 (`==`)，最后单字符 (`=`)

### 11.3 输出

```js
// 输入: var x = 10;
// 输出:
[
  Token { type: 'VAR', value: 'var', pos: 0, line: 1, col: 1 },
  Token { type: 'IDENTIFIER', value: 'x', pos: 4, line: 1, col: 5 },
  Token { type: 'ASSIGN', value: '=', pos: 6, line: 1, col: 7 },
  Token { type: 'NUMBER', value: 10, pos: 8, line: 1, col: 9 },
  Token { type: 'SEMICOLON', value: ';', pos: 10, line: 1, col: 11 },
  Token { type: 'EOF', value: '', pos: 11, line: 1, col: 12 },
]
```

---

## 12. 语法分析器（Parser）

### 12.1 设计

**递归下降**解析 Statement，**Pratt Parsing** 处理 Expression（基于算符优先级）。

### 12.2 算符优先级表

| 优先级 | 运算符 |
|--------|--------|
| 2 | `=`, `+=`, `-=`, `*=` |
| 3 | `? :` (三元) |
| 4 | `\|\|` |
| 5 | `&&` |
| 6 | `==`, `!=`, `===`, `!==` |
| 7 | `>`, `>=`, `<`, `<=` |
| 8 | `+`, `-` |
| 9 | `*`, `/`, `%` |

二元运算符左结合（`tokenPrec + 1`），赋值运算符右结合（`tokenPrec - 1`），三元运算符特殊处理。

### 12.3 支持的 AST 节点类型 (25 种)

**语句 (9)**：Program, VariableDeclaration, FunctionDeclaration, BlockStatement, ExpressionStatement, ReturnStatement, IfStatement, ForStatement, WhileStatement

**表达式 (16)**：FunctionExpression, ArrowFunctionExpression, Literal, Identifier, BinaryExpression, LogicalExpression, UnaryExpression, AssignmentExpression, CallExpression, MemberExpression, ThisExpression, NewExpression, ObjectExpression, ArrayExpression, UpdateExpression, ConditionalExpression

### 12.4 自动分号插入 (ASI)

最小实现：允许在 `}` 和 EOF 前省略分号。

---

## 13. 解释器（Evaluator）

### 13.1 核心流程

```
evaluate(node):
  触发 eval:node:enter
  switch node.type:
    Program           → _evalProgram        (hoist + 逐条执行)
    BlockStatement    → _evalBlockStatement  (创建 blockEnv, EC push/pop)
    VariableDeclaration → _evalVariableDeclaration (根据 kind 选择环境)
    FunctionDeclaration → _evalFunctionDeclaration (fallback 处理)
    FunctionExpression  → _evalFunctionExpression  (创建闭包)
    ReturnStatement   → _evalReturnStatement (RETURN_SENTINEL 传播)
    IfStatement       → _evalIfStatement
    ForStatement      → _evalForStatement    (创建 loopEnv, var 特殊 hoist)
    WhileStatement    → _evalWhileStatement
    Identifier        → _resolveIdentifier   (作用域链查找)
    AssignmentExpression → _evalAssignmentExpression (支持 Identifier 和 MemberExpression 左值)
    CallExpression    → _evalCallExpression  (检测 call/apply/bind, 解析 this, _applyFunction)
    MemberExpression  → _evalMemberExpression (obj.prop / obj[expr] / arr.length)
    ThisExpression    → 返回 currentEC.thisBinding
    ArrowFunction     → _evalArrowFunction   (捕获 this)
    NewExpression     → _evalNewExpression   (创建对象, this=newObj)
    ...
  触发 eval:node:exit
  return result
```

### 13.2 Return 传播机制

```js
const RETURN_SENTINEL = Symbol('return');

// return 语句创建 sentinel
{ [RETURN_SENTINEL]: true, value: result }

// 在 _evalStatements 和 _applyFunction 中检测
if (result && result[RETURN_SENTINEL]) {
  result = result.value;
  break;
}
```

### 13.3 属性赋值支持

```js
_evalAssignmentExpression 同时处理两种左值:
  1. Identifier: x = 10 → 走环境记录 setMutableBinding
  2. MemberExpression: obj.prop = 10 / this.prop = 10 → 走堆对象 properties.set
```

### 13.4 安全值序列化

为防止 hook 输出中的循环引用和过大对象，使用 `_safeHookValue` 将堆引用转为可读字符串：`<function:name>`, `<object>`, `<array>`, `<ref:address>`。

---

## 14. 全局领域（Realm）

初始化时创建：

1. **全局对象**（在堆中分配）：内含 `console.log`、`Object/Array/Function` 占位构造函数、`undefined/NaN/Infinity` 常量
2. **全局词法环境**：使用 `ObjectEnvironmentRecord` 包装全局对象的属性 Map，outer = null
3. **全局执行上下文**：type=global, LE=VE=globalEnv, thisBinding=globalObject
4. 全局 EC 入栈

```js
Realm
├── memory: Memory
├── ecStack: ExecutionContextStack
│   └── [0]: ExecutionContext { type: 'global', LE: globalEnv, VE: globalEnv, this: globalObject }
├── globalObject: ref(addr_1)
│   └── heap[addr_1]: { type: 'object', value: { properties: Map {
│         'console' → ref(addr_2),
│         'Object' → ref(addr_3),
│         'undefined' → undefined,
│         ...
│       }}}
└── globalEnv: LexicalEnvironment { record: ObjectEnvironmentRecord, outer: null }
```

---

## 15. 块级作用域

### 15.1 BlockStatement

```js
{
  var a = 1;   // → 外层函数的 VE
  let b = 2;   // → 块自己的 LE (blockEnv)
  const c = 3; // → 块自己的 LE (blockEnv)
}
```

实现：
1. 创建新的 `blockEnv`（outer = 当前 LE）
2. 创建 block EC（LE = blockEnv, VE = 外层函数的 VE）
3. Hoist 块内的 let/const/function 声明到 blockEnv
4. EC push → 执行块体 → EC pop

### 15.2 ForStatement

与 BlockStatement 类似，但 `var` 声明的 init 特殊处理：在进入 for 的 block EC 之前，将 var 声明 hoist 到最近函数/全局作用域。

---

## 16. API 参考

### 16.1 JSEngine

```js
import { JSEngine, HookEvents } from './src/index.js';

const engine = new JSEngine({ strict: false });

// 执行代码
const result = engine.execute('var x = 10; x + 1;'); // 11

// 分步操作
const ast = engine.parse('1 + 2');
const value = engine.evaluate(ast); // 3

// 注册 hook
engine.on(HookEvents.CONTEXT_PUSH, (data) => {
  console.log('EC push:', data.type, data.name);
});

engine.on(HookEvents.SCOPE_CHAIN_RESOLVE, (data) => {
  console.log(`Resolved "${data.name}" at depth ${data.depth}`);
});

// 获取追踪日志
const trace = engine.getTrace();
// [
//   { timestamp, event: 'tokenize:start', data: { source: '...' } },
//   { timestamp, event: 'token', data: { token: { type: 'VAR', ... } } },
//   ...
// ]

// 运行时状态查询
engine.getCurrentContext()    // 当前 EC
engine.getCallStack()         // 调用栈
engine.getScopeChain()        // 作用域链
engine.getMemorySnapshot()    // 堆快照
```

### 16.2 使用示例

```js
const engine = new JSEngine();

// 注册多个 hook 追踪闭包执行全过程
engine.on('context:push', (d) => console.log('→', d.type, d.name));
engine.on('context:pop', (d) => console.log('←', d.type, d.name));
engine.on('closure:create', (d) => console.log('闭包:', d.funcName, '捕获:', d.capturedVars));
engine.on('scope:chain:resolve', (d) => console.log('查找:', d.name, '深度:', d.depth));
engine.on('this:resolve', (d) => console.log('this:', d.pattern, d.value));

const result = engine.execute(`
  function createCounter(initial) {
    var count = initial;
    return {
      increment: function() { count = count + 1; return count; },
      decrement: function() { count = count - 1; return count; }
    };
  }
  var counter = createCounter(10);
  counter.increment();
  counter.increment();
`);

console.log('result:', result); // 12

// 输出追踪日志表
console.table(engine.getTrace().map(t => ({
  event: t.event,
  ...t.data,
})));
```

---

## 17. MVP 范围

### 已实现

- `var` / `let` / `const` 声明，含 hoisting 语义
- TDZ（Temporal Dead Zone）— let/const 声明前访问抛错
- 原始类型：number, string, boolean, null, undefined
- 函数声明 + 函数表达式 + 箭头函数
- 闭包（通过 `[[Environment]]` 捕获）
- this 四种绑定规则 + call/apply/bind 显式绑定
- 作用域链查找（从当前 LE 沿 outer 链向上）
- 块级作用域（let/const 在 `{}` 和 `for` 中）
- 基础运算符 (`+`, `-`, `*`, `/`, `%`, `==`, `===`, `!=`, `!==`, `>`, `<`, `>=`, `<=`, `&&`, `||`, `!`)
- 复合赋值 (`+=`, `-=`, `*=`)
- 自增/自减 (`++`, `--`)
- `typeof` 运算符
- 三元运算符 `? :`
- `if/else` 控制流
- `for (;;)` / `while` 循环
- `return` 语句
- 对象字面量 `{ key: value }`
- 数组字面量 `[1, 2, 3]`
- 属性访问 `obj.prop` / `obj[expr]`
- `new` 构造函数调用
- 27 种 hook 事件追踪全流程
- 运行时状态查询 API

### 后续迭代

- 原型链 / `class` / `extends`
- `try-catch` / `throw`
- `switch` / `do-while` / `for...in` / `for...of`
- 解构赋值
- 模板字符串
- Rest/Spread 参数
- `with` 语句
- `eval`
- `async/await` / Generator
- 模块 (`import`/`export`)
- 严格模式完整实现
- GC（引用计数 / 标记清除）
- `RegExp`, `Date`, `Map`, `Set` 等内置对象
