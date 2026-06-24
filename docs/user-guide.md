# JS Engine MVP 用户手册

## 1. 快速开始

### 1.1 环境要求

- Node.js v18 或更高版本
- 支持 ES Module（项目使用 `"type": "module"`）

### 1.2 安装与导入

```js
import { JSEngine, HookEvents } from './src/index.js';
```

无需 `npm install`，项目零外部依赖。

### 1.3 执行第一段代码

```js
const engine = new JSEngine();
const result = engine.execute('var x = 10; x + 1;');
console.log(result); // 11
```

---

## 2. 核心 API

### 2.1 构造函数

```js
new JSEngine(options?: {
    strict?: boolean,  // 严格模式（MVP 中仅占位）
    hooks?: {          // 批量注册 hook
        [event: string]: (data: any) => void
    }
})
```

### 2.2 执行方法

```js
// 一步执行（parse + evaluate）
engine.execute(code: string): any

// 分步操作
const ast = engine.parse(code: string): AST
const result = engine.evaluate(ast: AST): any
```

### 2.3 Hook API

```js
// 注册 hook 监听器
engine.on(event: string, callback: (data: any) => void): void

// 取消注册
engine.off(event: string, callback: Function): void

// 获取完整追踪日志
const trace = engine.getTrace(): TraceEntry[]

// 清空追踪日志
engine.clearTrace(): void
```

### 2.4 运行时状态查询

```js
// 当前执行上下文
engine.getCurrentContext(): object | null
// 返回: { type, name, thisBinding, lexicalEnv, variableEnv, scopeChain }

// 调用栈
engine.getCallStack(): object[]
// 返回: 从栈底到栈顶的 EC 快照数组

// 作用域链
engine.getScopeChain(): object[]
// 返回: 从当前 LE 到全局的每层 bindings

// 堆快照
engine.getMemorySnapshot(): object
// 返回: { [address]: { type, value, refCount } }
```

---

## 3. Hook 事件参考

### 3.1 事件总览 (27 种)

**词法分析阶段：**
| 事件名 | 触发时机 | data 关键字段 |
|--------|----------|--------------|
| `tokenize:start` | 开始分词 | `{ source }` |
| `token` | 每个 token | `{ token: { type, value, pos, line, col } }` |
| `tokenize:end` | 分词完成 | `{ tokens }` |

**语法分析阶段：**
| 事件名 | 触发时机 | data 关键字段 |
|--------|----------|--------------|
| `parse:start` | 开始解析 | `{ tokenCount }` |
| `parse:node` | 每个 AST 节点 | `{ type, id, node }` |
| `parse:end` | 解析完成 | `{ nodeCount }` |

**内存操作：**
| 事件名 | 触发时机 | data 关键字段 |
|--------|----------|--------------|
| `memory:allocate` | 堆分配 | `{ address, type, value }` |
| `memory:write` | 堆写入 | `{ address, type, oldValue, newValue }` |
| `memory:read` | 堆读取 | `{ address, type, value }` |
| `memory:free` | 堆释放 | `{ address }` |

**执行上下文：**
| 事件名 | 触发时机 | data 关键字段 |
|--------|----------|--------------|
| `context:push` | EC 入栈 | EC.snapshot() |
| `context:pop` | EC 出栈 | `{ type, name }` |
| `context:creation:start` | 创建阶段开始 | `{ type, name }` |
| `context:creation:end` | 创建阶段结束 | `{ type, name, envSnapshot }` |

**变量操作：**
| 事件名 | 触发时机 | data 关键字段 |
|--------|----------|--------------|
| `variable:declare` | 声明创建 | `{ name, kind, initialized }` |
| `variable:assign` | 赋值 | `{ name, oldValue, newValue }` |
| `variable:read` | 读取 | `{ name, value }` |

**作用域：**
| 事件名 | 触发时机 | data 关键字段 |
|--------|----------|--------------|
| `scope:lookup` | 标识符解析 | `{ name }` |
| `scope:chain:resolve` | 链查找完成 | `{ name, found, depth, envChain }` |

**闭包与 this：**
| 事件名 | 触发时机 | data 关键字段 |
|--------|----------|--------------|
| `closure:create` | 函数对象创建 | `{ funcName, capturedVars, isRealClosure, isNested }` |
| `this:resolve` | this 确定 | `{ pattern, value }` |

> `isRealClosure`: 嵌套函数 + 实际捕获外层变量（非自身声明遮蔽）→ 真闭包；`isNested`: 嵌套在父函数中但无捕获变量 → 嵌套函数；都不满足 → 顶层函数。`capturedVars` 仅包含被函数体实际引用的外层变量。

**函数调用：**
| 事件名 | 触发时机 | data 关键字段 |
|--------|----------|--------------|
| `function:call` | 函数进入（创建阶段完成后） | `{ name, args, thisValue }` |
| `function:return` | 函数返回 | `{ name, value }` |

> **时序说明**：对于 `_evalProgram` 和 `_applyFunction`，执行分为两个阶段——Phase 1: 创建阶段（`context:creation:start` → hoisting/参数绑定 → `context:creation:end`）和 Phase 2: 执行阶段（`function:call` + `context:push` → 逐条执行函数体 → `context:pop` + `function:return`）。`function:call` 始终在 `context:creation:end` 之后触发。

**求值：**
| 事件名 | 触发时机 | data 关键字段 |
|--------|----------|--------------|
| `eval:node:enter` | AST 节点开始 | `{ type, id }` |
| `eval:node:exit` | AST 节点完成 | `{ type, id, result }` |

**引擎生命周期：**
| 事件名 | 触发时机 | data 关键字段 |
|--------|----------|--------------|
| `execution:start` | 执行开始 | `{}` |
| `execution:end` | 执行结束 | `{ result }` |

### 3.2 事件通配符注意事项

当前版本**不支持通配符**（如 `context:*`）。每个事件需要独立注册。如需监听多个事件，可逐个注册或批量传入构造参数 `options.hooks`。

---

## 4. 使用场景

### 4.1 追踪闭包执行

```js
const engine = new JSEngine();

engine.on('context:push', (d) => console.log('→ EC push:', d.type, d.name));
engine.on('context:pop', (d) => console.log('← EC pop:', d.type, d.name));
engine.on('closure:create', (d) => console.log('闭包:', d.funcName, '捕获:', d.capturedVars));
engine.on('scope:chain:resolve', (d) => console.log('查找:', d.name, '深度:', d.depth));

engine.execute(`
    function outer() {
        var x = 10;
        function inner() {
            return x + 1;
        }
        return inner;
    }
    var fn = outer();
    fn();
`);
```

### 4.2 追踪 this 绑定

```js
engine.on('this:resolve', (d) => {
    console.log(`this 绑定: ${d.pattern} → ${d.value}`);
});

engine.execute(`
    function getX() { return this.x; }
    var obj = { x: 99 };
    getX.call(obj);
`);
// 输出: this 绑定: explicit → <object>
```

### 4.3 调试 TDZ 错误

```js
engine.on('variable:declare', (d) => {
    console.log(`声明: ${d.name} (${d.kind}), 已初始化=${d.initialized}`);
});
engine.on('scope:chain:resolve', (d) => {
    console.log(`标识符查找: ${d.name} → ${d.found ? '找到 depth=' + d.depth : '未找到'}`);
});

try {
    engine.execute('let y = x; let x = 5;');
} catch (e) {
    console.log('错误:', e.message);
    // 错误: Cannot access 'x' before initialization
}

// 追踪日志显示:
// 声明: y (let), 已初始化=false
// 声明: x (let), 已初始化=false
// 标识符查找: x → 找到(但 TDZ) → ReferenceError
```

### 4.4 可视化调用栈

```js
const engine = new JSEngine();

engine.on('context:push', () => {
    const stack = engine.getCallStack();
    console.log('调用栈深度:', stack.length);
    stack.forEach((ec, i) => {
        console.log(`  [${i}] ${ec.type} ${ec.name || ''}`);
    });
});

engine.execute(`
    function a() { return b() + 1; }
    function b() { return c() + 1; }
    function c() { return 42; }
    a();
`);
```

### 4.5 导出完整追踪日志

```js
const engine = new JSEngine();
engine.execute('var x = 42;');

const trace = engine.getTrace();
console.table(trace.map(t => ({
    event: t.event,
    time: new Date(t.timestamp).toISOString(),
    ...t.data,
})));
```

---

## 5. 支持的 JavaScript 子集

### ✅ 支持

- 变量声明：`var` / `let` / `const`
- 原始类型：number, string, boolean, null, undefined
- 函数：声明、表达式、箭头函数
- 闭包、作用域链
- this 绑定（4 种模式 + call/apply/bind）
- 块级作用域（let/const）
- 控制流：if/else、for(;;)、while
- 对象字面量 `{}`、数组字面量 `[]`
- 属性访问：`obj.prop`、`obj[expr]`
- 运算符：`+`, `-`, `*`, `/`, `%`, `==`, `===`, `!=`, `!==`, `>`, `<`, `>=`, `<=`, `&&`, `||`, `!`, `typeof`, `++`, `--`, `? :`
- 复合赋值：`+=`, `-=`, `*=`
- `new` 构造函数
- 注释：`//` 和 `/* */`

### ❌ 不支持

- 原型链 / class / extends
- try-catch / throw
- async-await / Generator
- 模块 (import/export)
- 解构赋值 / 模板字符串 / Rest/Spread
- for...in / for...of / switch / do-while
- with / eval
- RegExp / Date / Map / Set

---

## 6. 注意事项

1. **内存不回收**：引擎内部堆只增不减，长时间运行大循环可能导致内存增长
2. **非沙箱**：代码在宿主 Node.js 进程中执行，`console.log` 等直接访问宿主环境
3. **全局共享**：同一个 `JSEngine` 实例的多次 `execute()` 调用共享同一个全局 Realm
4. **Trace 积累**：`getTrace()` 不会自动清空，多次执行前记得 `clearTrace()`
5. **错误处理**：引擎内部错误直接抛出，调用方需自行 try-catch
