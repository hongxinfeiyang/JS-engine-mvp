# JS Engine MVP 系统架构文档

## 1. 架构概览

JS Engine MVP 是一个在 Node.js 环境下运行的 JavaScript 引擎实现，采用**经典的三段式编译管道 + 运行时环境**架构。核心设计目标不是执行性能，而是**完整的执行过程可观测性**。

### 1.1 架构全景图

```架构全景图
                        ┌──────────────┐
                        │   用户代码    │
                        │  (JS 源码)   │
                        └──────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              │           JSEngine              │
              │                                 │
              │  ┌──────────────────────┐       │
              │  │      (管道阶段)       │       │
              │  │                      │       │
              │  │  Lexer ──▶ Parser    │       │
              │  │    │          │      │       │
              │  │    ▼          ▼      │       │
              │  │  Token[]    AST      │       │
              │  └──────────────────────┘       │
              │              │                  │
              │              ▼                  │
              │  ┌──────────────────────┐       │
              │  │     Evaluator        │       │
              │  │  (AST 解释执行)       │       │
              │  └─────────┬────────────┘       │
              │            │                    │
              │  ┌─────────┴────────────┐       │
              │  │      Runtime 层       │      │
              │  │                      │      │
              │  │  ┌──────────────┐    │      │
              │  │  │ Memory (堆)  │    │      │
              │  │  └──────────────┘    │      │
              │  │  ┌──────────────┐    │      │
              │  │  │  EC Stack    │    │      │
              │  │  └──────────────┘    │      │
              │  │  ┌──────────────┐    │      │
              │  │  │ Environment  │    │      │
              │  │  │ Record / LE  │    │      │
              │  │  └──────────────┘    │      │
              │  └──────────────────────┘      │
              │                                │
              │  ┌──────────────────────┐      │
              │  │    HookSystem        │      │
              │  │  (27 事件 + Trace)    │      │
              │  └──────────────────────┘      │
              └────────────────────────────────┘
```

### 1.2 分层职责

| 层 | 模块 | 职责 | 输入 | 输出 |
| ---- | ------ | ------ | ------ | ------ |
| **前端** | Lexer | 词法分析：字符流 → Token 流 | `string` | `Token[]` |
| **前端** | Parser | 语法分析：Token 流 → AST | `Token[]` | `AST (Program)` |
| **后端** | Evaluator | 语义求值：遍历 AST 并解释执行 | `AST` | 执行结果 |
| **运行时** | Memory | 堆内存管理：分配/读写/释放 | — | — |
| **运行时** | Environment | 词法环境：变量绑定 + 作用域链 | — | — |
| **运行时** | ECStack | 执行上下文栈：函数调用栈管理 | — | — |
| **运行时** | Realm | 全局领域：全局对象 + 内置对象 | — | — |
| **横切** | HookSystem | 贯穿所有层的可观测性事件系统 | — | `TraceEntry[]` |

### 1.3 数据流

```数据流
源代码 (字符串)
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ Lexer                                               │
│ 逐字符扫描 → 跳过空白/注释 → 分词                       │
│ 触发: tokenize:start, token × N, tokenize:end        │
└────────────────────────┬────────────────────────────┘
                         │ Token[]
                         ▼
┌─────────────────────────────────────────────────────┐
│ Parser                                              │
│ 递归下降 (Statement) + Pratt (Expression)            │
│ 触发: parse:start, parse:node × N, parse:end         │
└────────────────────────┬────────────────────────────┘
                         │ AST (Program 节点)
                         ▼
┌─────────────────────────────────────────────────────┐
│ Evaluator                                           │
│ switch(node.type) → 对应 eval 方法                   │
│ 触发: eval:node:enter/exit × N + 20+ 运行时事件       │
│                                                     │
│ 运行时交互:                                           │
│  · Memory.allocate/read/write      (堆操作)          │
│  · ECStack.push/pop/current        (调用栈)          │
│  · Environment.createBinding/setBinding/getBinding  │
│  · Environment.outer 链遍历        (作用域查找)        │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │ Stepper (步骤捕获器)   │
              │ captureSteps(code)   │
              │ 过滤 15 种关键事件      │
              │ 生成步骤轨迹 + 快照     │
              └──────────┬───────────┘
                         │ { steps, error, result }
                         ▼
              ┌──────────────────────────┐
              │ Interactive HTML         │
              │ 三栏布局 + 步进控制         │
              │ 源码选中 + 锁定态 + 面板联动 │
              └──────────────────────────┘
                         │
                         ▼
                     执行结果 + Trace 日志
```

## 2. 关键技术决策

### 2.1 堆内存：地址映射 vs 直接引用

**选择**：地址映射方案（`Map<address, entry>`）

**Why**：

- 直接引用会导致 hook 输出中包含循环引用，难以序列化
- 地址映射使得每次堆操作都可以被 hook 拦截（`memory:allocate/read/write/free`）
- 为后续实现 GC 留下扩展点（当前仅有 refCount 占位）
- 模拟真实 JS 引擎的指针/地址概念，利于教学

**代价**：每次对象属性访问需要多一次 `memory.getEntry(address)` 查找。

### 2.2 EnvironmentRecord：两种实现并存

**选择**：`DeclarativeEnvironmentRecord` + `ObjectEnvironmentRecord`

**Why**：

- Declarative ER：用于函数/块作用域，bindings 直接由引擎管理，配合 TDZ 的 `initialized` 标志
- Object ER：用于全局环境，bindings 委托到全局对象的属性 Map，使得 `var x = 1; this.x` 返回相同值
- 符合 ECMAScript 规范 §8.1.1 的定义

### 2.3 表达式解析：Pratt Parsing

**选择**：Pratt 解析器（自顶向下算符优先级）

**Why**：

- 比纯递归下降更适合处理复杂表达式（多级运算符优先级、结合性）
- 一行配置即可添加新运算符：`PRECEDENCE[TokenType.X] = N`
- 比 Parser Generator（如 jison/peg.js）更轻量，且能逐节点触发 `parse:node` hook

### 2.4 Return 传播：Sentinel Object

**选择**：`{ [Symbol('return')]: true, value }` 作为返回值标记

**Why**：

- JavaScript 本身不支持跨函数边界的非局部跳转（没有 call/cc 或 goto）
- Sentinel 允许在 `_evalStatements` 和 `_applyFunction` 中检测 return 并逐层传播
- 使用 Symbol 确保不会与正常的对象返回值混淆

### 2.5 this 绑定：Call-site 检测

**选择**：在 `_evalCallExpression` 中检查 `callee.type === 'MemberExpression'` 判断隐式绑定

**Why**：

- 不需要额外标注或元信息，直接从 AST 节点类型推断
- 与 ECMAScript 规范中 `CallExpression : MemberExpression Arguments` 的求值规则一致
- call/apply/bind 作为特殊路径处理，不经过常规隐式绑定逻辑

## 3. 目录结构

```目录结构
js-engine-mvp/
├── .claude/
│   ├── CLAUDE.md                      # 项目约束（代码规范、文档要求）
│   └── skills/                        # 项目级/模块级/功能级 Skill
│       ├── js-engine-project.md       # 项目级：整体架构和开发流程
│       ├── js-engine-lexer.md         # 模块级：词法分析器
│       ├── js-engine-parser.md        # 模块级：语法分析器
│       ├── js-engine-runtime.md       # 模块级：运行时环境
│       ├── js-engine-evaluator.md     # 模块级：解释器
│       └── js-engine-hooks.md         # 功能级：Hook 系统
├── docs/
│   ├── design-arch.md                 # 系统架构文档（本文档）
│   ├── tech-spec.md                   # 技术详设
│   ├── functional-spec.md            # 功能详设
│   ├── user-guide.md                  # 用户手册
│   ├── dev-guide.md                   # 开发手册
│   ├── test-plan.md                   # 测试手册
│   └── review-report.md              # 文档评审报告
├── src/
│   ├── index.js                       # 引擎入口
│   ├── types.js                       # 类型/枚举常量
│   ├── hooks/
│   │   ├── HookSystem.js             # 事件系统
│   │   └── HookEvents.js             # 事件名常量
│   ├── lexer/
│   │   ├── TokenType.js              # Token 类型
│   │   ├── Token.js                  # Token 类
│   │   └── Lexer.js                  # 词法分析器
│   ├── parser/
│   │   ├── ASTNode.js                # AST 节点工厂
│   │   └── Parser.js                 # 语法分析器
│   ├── runtime/
│   │   ├── Memory.js                 # 堆内存
│   │   ├── Value.js                  # 值工具
│   │   ├── EnvironmentRecord.js      # 环境记录
│   │   ├── LexicalEnvironment.js     # 词法环境
│   │   ├── ExecutionContext.js       # 执行上下文
│   │   ├── ExecutionContextStack.js  # EC 栈
│   │   └── Realm.js                  # 全局领域
│   └── evaluator/
│       └── Evaluator.js              # 解释器
├── demo.js                            # 功能演示 / 集成测试
└── package.json
```

## 4. 部署视图

```部署视图
┌─────────────────────────────────────┐
│         Node.js v18+ (ESM)          │
│                                     │
│  import { JSEngine } from './src    │
│                                     │
│  const engine = new JSEngine()      │
│  engine.on(event, callback)         │
│  engine.execute(sourceCode)         │
│  engine.getTrace()                  │
│                                     │
│  无外部依赖，纯 JS 实现                │
└─────────────────────────────────────┘
```
