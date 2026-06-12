# JS Engine MVP 功能详设

## 1. 声明与变量提升 (Hoisting)

### 1.1 var 声明

**行为**：在进入作用域（函数/全局）时，var 声明的绑定被创建并初始化为 `undefined`。声明阶段描述明确展示 `var x = undefined（提升初始化）`。

**实现路径**：[Evaluator.js](../src/evaluator/Evaluator.js) → `_hoistOneDeclaration()` → `createMutableBinding()` + `initializeBinding(name, undefined)`

**示例**：
```js
console.log(x); // undefined（不报错）
var x = 10;
```

**Hook 触发顺序**：
1. `variable:declare { name: 'x', kind: 'var', initialized: true }` — 描述 `声明变量 — var x = undefined（提升初始化）`
2. `variable:assign { name: 'x', newValue: 10 }` — 执行赋值阶段（不再重复触发 `variable:declare`）

### 1.2 let / const 声明与 TDZ

**行为**：绑定在 hoisting 阶段被创建但**不初始化**（`initialized: false`），声明前访问触发 `ReferenceError`。

**Why**：`hasBinding()` 检查 `initialized` 标志，TDZ 期间的绑定被视为"不存在"（hasBinding 返回 false），但 `hasUninitializedBinding` 返回 true，从而触发错误路径。

**示例**：
```js
console.log(y); // ReferenceError: Cannot access 'y' before initialization
let y = 5;
```

**Hook 触发顺序**：
1. `variable:declare { name: 'y', kind: 'let', initialized: false }` — hoisting 阶段
2. `scope:lookup { name: 'y' }` → `scope:chain:resolve { found: true, depth: 0 }` → **throw ReferenceError**

### 1.3 函数声明提升

**行为**：函数声明在 hoisting 阶段被完整创建（包括函数对象分配在堆中），声明前即可调用。

**示例**：
```js
foo(); // 正常工作
function foo() { return 42; }
```

**Hook 触发顺序**：
1. `closure:create { funcName: 'foo', capturedVars: [...] }` — hoisting 阶段
2. `memory:allocate { address: N, type: 'function' }` — 函数对象入堆
3. `variable:declare { name: 'foo', kind: 'function', initialized: true }`

### 1.4 创建阶段 Hook 事件

`_evalProgram` 和 `_applyFunction` 在执行函数体之前，显式划分为两个阶段，并通过新增的 hook 事件标记边界：

- **Phase 1 (创建阶段)**：`context:creation:start` → hoist 声明、创建绑定 → `context:creation:end`
- **Phase 2 (执行阶段)**：`context:push` → 逐条执行 → `context:pop`

此分离对齐 ECMAScript 规范中 `FunctionDeclarationInstantiation` 与函数体执行相互独立的语义。外部观察者可通过 `context:creation:start` 和 `context:creation:end` 精确界定所有声明的 hoisting 时间窗口，以及 let/const 变量的 TDZ 区间。

---

## 2. 作用域链与标识符解析

### 2.1 作用域链构建

每个 `LexicalEnvironment` 通过 `outer` 引用链接到外部环境。链的起点始终是当前 EC 的 `lexicalEnvironment`。

**查找算法**（[Evaluator.js](../src/evaluator/Evaluator.js) `_resolveIdentifier`）：

```
1. 从 currentEC.lexicalEnvironment 开始
2. 检查 hasBinding(name)：绑定存在且 initialized=true → 返回
3. 检查 hasUninitializedBinding(name)：绑定存在但 initialized=false → throw TDZ Error
4. 二者都不满足 → env = env.outer，回到步骤 2
5. env 为 null → throw ReferenceError (not defined)
```

### 2.2 块级作用域

**行为**：`{}` 创建新的 `LexicalEnvironment`，`let`/`const` 声明进入块环境，`var` 声明穿透到外层函数/全局环境。

**实现**：
- `_evalBlockStatement` 创建 `blockEnv` (outer → 当前 LE)
- blockEC 的 `variableEnvironment` 指向外层函数的 VE（var 写入此处）

**示例**：
```js
var a = 1;
{
    let a = 2; // 块作用域内的 a
    var b = 3; // 提升到全局
}
console.log(a); // 1（块外访问全局 a）
console.log(b); // 3（var 穿透块）
```

### 2.3 for 循环作用域

**行为**：for 循环创建独立的 `loopEnv`，`var` init 特殊处理——不进入循环环境，直接进入外层函数/全局。

**示例**：
```js
for (var i = 0; i < 3; i++) { /* ... */ }
console.log(i); // 3（var 在循环外可见）

for (let j = 0; j < 3; j++) { /* ... */ }
// console.log(j); // ReferenceError（let 只在循环内可见）
```

---

## 3. 闭包

### 3.1 闭包创建

**时机**：函数对象创建时（FunctionDeclaration 的 hoisting、FunctionExpression 求值、ArrowFunction 求值）

**机制**：当前 `LexicalEnvironment` 被保存为 `funcObj.closure`

**实现路径**：[Evaluator.js](../src/evaluator/Evaluator.js) `_createFunctionObject()` / `_evalArrowFunction()`

**Hook**：`closure:create { funcName, capturedVars, isRealClosure, isNested }`

**函数分类**（三级）：
| 分类 | 条件 | 示例 |
|------|------|------|
| **闭包** | 嵌套函数 + 实际引用外层变量（非自身声明遮蔽）| `inner` 引用 `outer` 的 `x` |
| **嵌套函数** | 在父函数内但无实际捕获变量（被自身 var/let 遮蔽或未引用外层）| `outer22` 在 `outer2` 内但声明了同名 `var x` |
| **顶层函数** | 直接在全局作用域声明 | `function outer() {}` |

**实现**：`_createFunctionObject` 收集函数自身的局部声明（形参 + 函数名 + var/let/const/function），从 `capturedVars` 中过滤掉被自身遮蔽的变量。`isRealClosure = isNested && capturedVars.length > 0`。

### 3.2 闭包调用

**机制**：调用时新建 LE，`outer` 指向闭包保存的 `funcObj.closure`

**示例**：
```js
function createCounter(initial) {
    var count = initial;
    return {
        increment: function() { count = count + 1; return count; },
        decrement: function() { count = count - 1; return count; }
    };
}
var counter = createCounter(10);
counter.increment(); // 11
counter.increment(); // 12
```

**Hook 追踪**：
1. `function:call createCounter(10)` → `context:push { type: 'function', name: 'createCounter' }`
2. `variable:declare count (var)` → `variable:assign count: 10`
3. `closure:create (anonymous) captures [initial, count]` — increment 和 decrement 都捕获
4. `function:return createCounter` → `context:pop`
5. `function:call (anonymous)` → 在 `closure` 链 depth=1 处找到 `count`
6. `scope:chain:resolve { name: 'count', depth: 1 }`

---

## 4. this 绑定

### 4.1 绑定规则优先级

| 规则 | 触发条件 | this 值 | Hook pattern |
|------|----------|---------|--------------|
| **new** | `new Fn()` | 新创建的空对象 | `new` |
| **显式** | `fn.call(obj)`, `fn.apply(obj)`, `fn.bind(obj)` | 传入的第一个参数 | `explicit` |
| **隐式** | `obj.method()` | `obj` | `method-call` |
| **箭头** | `() => {}` | 从外层作用域继承 | `arrow` |
| **默认** | `fn()` | globalObject | `default` |

### 4.2 隐式绑定检测

```js
// callee.type === 'MemberExpression' → 隐式绑定
obj.getX(); // this = obj

// 排除 call / apply / bind
fn.call(obj); // 不触发隐式绑定，走显式绑定路径
```

### 4.3 箭头函数 this

**行为**：this 在**定义时**从外层 EC 捕获，调用时忽略传入的 thisValue。

```js
function Counter() {
    this.count = 0;
    this.increment = () => {
        return this.count + 1; // this 从 Counter 构造函数继承
    };
}
```

**实现**：`_evalArrowFunction` 在创建函数对象时，将 `currentEC.thisBinding` 保存到 `funcObj.capturedThis`，调用时覆盖传入的 thisValue。

### 4.4 bound 函数

**行为**：`fn.bind(thisArg, ...args)` 返回一个新函数，其 `this` 被固定，参数被预填充。

**实现**：创建 `type: 'bound'` 的函数对象，包含 `targetFunc`、`boundThis`、`boundArgs`。调用时展开参数：`mergedArgs = [...boundArgs, ...callArgs]`。

---

## 5. 表达式与控制流

### 5.1 短路求值

- `&&`：left 为 falsy → 返回 left，不计算 right
- `||`：left 为 truthy → 返回 left，不计算 right
- `? :`：test 为 truthy → 只计算 consequent

### 5.2 属性访问

- `obj.prop` → `_evalMemberExpression`，computed=false
- `obj[expr]` → `_evalMemberExpression`，computed=true
- `arr.length` → 从 `heap[addr].value.elements` 数组取 `length`
- `arr[0]` → `elements[Number(prop)]`

### 5.3 属性赋值

- `obj.prop = val` / `this.prop = val` → `_evalAssignmentExpression` 的 MemberExpression 分支
- `x = val` → `_evalAssignmentExpression` 的 Identifier 分支（沿作用域链查找环境+更新绑定）

### 5.4 复合赋值

支持 `+=`、`-=`、`*=` 三种复合赋值运算符。在 MemberExpression 和 Identifier 两种左值上都生效。

---

## 6. 内存管理

### 6.1 分配策略

- **原始值**：不进入堆，直接在 JS 栈上传递
- **对象/数组/函数**：调用 `Memory.allocate(type, value)` 获取地址，以 `{ address }` 包装传递
- 每次分配触发 `memory:allocate` hook

### 6.2 当前限制

- 仅有 `refCount` 占位字段，**无实际 GC 回收**
- 内存只增不减（`free` 方法存在但无调用方）
- 后续可扩展为引用计数或标记-清除

---

## 7. 错误处理

### 7.1 引擎内部

按语义抛出标准错误类型：
- `ReferenceError`：变量未定义 / TDZ 访问
- `TypeError`：非函数调用 / const 重新赋值 / 非对象属性访问
- `SyntaxError`：词法/语法错误（Token/Parser 层）

### 7.2 MVP 限制

- 不支持用户代码中的 `try-catch`（后续迭代）
- 引擎内部异常直接冒泡到 `engine.execute()` 调用方
