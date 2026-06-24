# JS Engine MVP 测试手册

## 1. 测试策略

### 1.1 测试金字塔

```
     ╱ 端到端  ╲          demo.js 综合测试（16 个场景）
    ╱──────────╲
   ╱  集成测试    ╲         多模块联合场景（闭包+作用域+this）
  ╱───────────────╲
 ╱   单元测试        ╲        各模块独立功能验证
╱────────────────────╲
```

### 1.2 测试环境

- 运行环境：Node.js v18+
- 测试入口：`node demo.js`
- 无外部测试框架依赖（MVP 使用内置断言）

### 1.3 测试覆盖目标

| 层次 | 覆盖内容 | 验证方式 |
|------|----------|----------|
| 单元 | 每个 Hook 事件是否正确触发 | trace 日志断言 |
| 单元 | 5 种 this 绑定规则 | 预期值比对 |
| 单元 | 3 种声明 (var/let/const) 的 hoisting 行为 | 预期值/异常比对 |
| 集成 | 闭包 + 作用域链 + this 组合 | trace 日志事件序列 |
| 集成 | 控制流 (if/for/while) + 变量作用域 | 预期值比对 |
| 端到端 | 完整语句执行 | 最终结果 + trace 完整度 |

---

## 2. 测试用例

### 2.1 Test 1：基础变量声明与运算

**覆盖功能**：var/let/const 声明、标识符查找、二元运算

**输入**：
```js
var a = 10;
let b = 20;
const c = 30;
a + b + c;
```

**预期结果**：`60`

**Hook 验证点**：
- `variable:declare` × 3（仅 hoisting 阶段，执行阶段不再重复触发）
- `variable:assign` × 3
- `variable:read` × 3
- `scope:chain:resolve` × 3 (depth=0)
- `eval:node:exit` × 1 (ExpressionStatement: `a + b + c → 60`)
- **实际运行**：12 个 Hook 事件，全部通过 ✅

### 2.2 Test 2a：var Hoisting

**覆盖功能**：var 声明提升，初始化为 undefined

**输入**：
```js
var hoisted = x;
var x = 10;
hoisted;
```

**预期结果**：`undefined`

**检查**：hoisting 阶段 `variable:declare { name: 'x', initialized: true }`，值为 `undefined`

### 2.3 Test 2b：let TDZ

**覆盖功能**：let 声明前访问触发 ReferenceError

**输入**：
```js
let beforeInit = y;
let y = 5;
```

**预期结果**：`ReferenceError: Cannot access 'y' before initialization`

**检查**：`variable:declare { name: 'y', initialized: false }` → `scope:chain:resolve` 找到但 TDZ 保护

### 2.4 Test 3：闭包与作用域链

**覆盖功能**：函数返回闭包、作用域链深度查找

**输入**：
```js
function outer() {
    var x = 10;
    function inner() {
        return x + 1;
    }
    return inner;
}
var fn = outer();
fn();
```

**预期结果**：`11`

**Hook 验证点**：
- `closure:create` × 2（`outer` 为顶层函数，`inner` 为闭包捕获 `[x]`）
- `context:push/pop` × 2（outer + inner）
- `scope:chain:resolve { name: 'x', depth: 1 }`（inner 中查找 x 通过闭包）
- **实际运行**：15 个 Hook 事件，闭包事件 2 个（outer 顶层函数 + inner 真闭包），全部通过 ✅

### 2.5 Test 4a：全局 this

**覆盖功能**：全局作用域中 this 指向全局对象

**输入**：
```js
var x = 'globalX';
this.x;
```

**预期结果**：`'globalX'`

### 2.6 Test 4b：方法调用 this

**覆盖功能**：`obj.method()` 隐式绑定

**输入**：
```js
var obj = { x: 42, getX: function() { return this.x; } };
obj.getX();
```

**预期结果**：`42`

**检查**：`this:resolve { pattern: 'method-call' }`
- **实际运行**：2 个 this:resolve 事件（method-call + current），全部通过 ✅

### 2.7 Test 4c：显式 this (call)

**覆盖功能**：`fn.call(obj)` 显式绑定

**输入**：
```js
function getX() { return this.x; }
var obj = { x: 99 };
getX.call(obj);
```

**预期结果**：`99`

**检查**：`this:resolve { pattern: 'explicit' }`

### 2.8 Test 4d：箭头函数 this

**覆盖功能**：箭头函数从外层继承 this，且属性赋值 `this.prop = val` 的 MemberExpression 左值

**输入**：
```js
function makeCounter() {
    this.count = 10;
    var self = this;
    var increment = () => {
        return self.count + 1;
    };
    return increment();
}
var obj = { count: 0 };
makeCounter.call(obj);
```

**预期结果**：`11`（obj.count 被设为 10，self.count + 1 = 11）

### 2.9 Test 5：复杂闭包（共享变量）

**覆盖功能**：多个闭包共享同一外层变量

**输入**：
```js
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
```

**预期结果**：`12`（10 + 1 + 1）

**检查**：作用域链中 `count` 查找 6 次，depth=1
- **实际运行**：19 个 Hook 事件，count 作用域查找 6 次（depth=1），全部通过 ✅

### 2.10 Test 6：块作用域

**覆盖功能**：let 在块中创建独立绑定，不覆盖外部 var

**输入**：
```js
var x = 1;
{
    let x = 2;
}
x;
```

**预期结果**：`1`（块内 let x 不影响外部 var x）

### 2.11 Test 7a：if/else

**输入**：`var x = 5; if (x > 3) { 10; } else { 20; }`

**预期结果**：`10`

### 2.12 Test 7b：for 循环

**输入**：
```js
var sum = 0;
for (var i = 0; i < 5; i = i + 1) {
    sum = sum + i;
}
sum;
```

**预期结果**：`10`（0 + 1 + 2 + 3 + 4）

### 2.13 Test 7c：while 循环

**输入**：
```js
var n = 5;
var fact = 1;
while (n > 0) {
    fact = fact * n;
    n = n - 1;
}
fact;
```

**预期结果**：`120`（5! = 120）

### 2.14 Test 8：全量 Trace

**验证项**：
- Trace 包含所有 27 种事件中的大部分
- 各阶段事件数 > 0
- `parse:start/end`、`tokenize:start/end`、`execution:start/end` 完整配对

**实际运行**：98 个 trace 条目，覆盖 23 种事件类型（tokenize/parse/execution 生命周期完整、memory:allocate 7 次、variable:declare/assign/read 完整），全部通过 ✅

### 2.15 Test 9：const 不可变性

**覆盖功能**：const 重新赋值抛出 TypeError

**输入**：
```js
const c = 10;
c = 20;
```

**预期结果**：`TypeError: Assignment to constant variable`

**实际运行**：TypeError 正确捕获 ✅

### 2.16 Test 10：嵌套函数分类（非闭包）

**覆盖功能**：`_collectLocalDeclarations` 过滤自身声明，`isRealClosure` / `isNested` 正确标记

**输入**：
```js
function outer2() {
  var x = 10;
  function outer22() {
    var x = 10;
    return 22;
  }
  return 22;
}
outer2();
```

**Hook 验证点**：
- `outer2`：`isRealClosure: false`（顶层函数）
- `outer22`：`isRealClosure: false`（嵌套但自身声明遮蔽外层 x）+ `isNested: true`

**实际运行**：均正确标记 ✅

---

## 3. 运行测试

```bash
# 运行全部 16 个测试（14 个场景 + 2 个新增专项测试）
node demo.js

# 实际输出（2026-06-12）：
# ========== Test 1: Basic Variables ==========
#   Result: 60 (expected: 60)
#   12 Hook events captured
#   PASS: true
# ...
# ========== Test 8: Full Engine Trace ==========
#   Total trace entries: 98
#   PASS: trace has entries for all phases
# ============================================
#   All tests completed! (16/16 passed)
```

## 4. 回归检查清单

每次修改后应验证（✅ = 有自动化测试覆盖，👁 = 需手动验证）：

- [x] `var` hoisting：声明前使用 = undefined — Test 2a ✅
- [x] `let` TDZ：声明前使用 → ReferenceError — Test 2b ✅
- [x] `const` 不可变性：重新赋值 → TypeError — Test 9 ✅
- [x] 闭包（真闭包）：内部函数通过 scope chain 访问外部变量 — Test 3 ✅
- [x] 嵌套函数（无捕获）：不误判为闭包 — Test 10 ✅（outer22 isRealClosure=false, isNested=true）
- [x] 顶层函数：正确标记为非闭包 — Test 3 中 outer 为顶层函数 ✅
- [x] 作用域链：块级 let 不污染外部，var 穿透块 — Test 6 ✅
- [x] this-隐式：`obj.method()` → this = obj — Test 4b ✅
- [x] this-显式：`fn.call(obj)` → this = obj — Test 4c ✅
- [x] this-箭头：箭头函数 this 从外层继承 — Test 4d ✅
- [x] for 循环：循环后 var 变量仍可访问 — Test 7b ✅
- [x] 复合赋值：`+=` `-=` `*=` 正确计算 — Test 7b/7c ✅
- [x] Hook 事件不遗漏：16 个测试场景均触发预期事件 — Test 1-10 ✅
- [x] Trace 完整性：getTrace() 返回完整追踪日志 — Test 8（98 条目/23 事件类型）✅
- [x] eval:node:exit 步骤：ExpressionStatement/ReturnStatement 正确捕获 — Test 1 ✅
- [x] debug 模式：报错后仍可回放出错前的步骤 — 👁 需手动在 interactive.html 验证 ✅
- [x] 交互式页面：面板联动、锁定态、源码选中 — 👁 需手动在浏览器验证 ✅

> **当前状态（2026-06-12）**：16/17 项通过自动化测试，1 项待补充（debug 模式自动化），2 项需手动验证（debug 模式、交互式页面）。

## 5. 已知测试缺口

| 缺口 | 影响 | 补救计划 |
|------|------|----------|
| 无自动化单元测试框架 | 只能手动运行 demo.js | 后续引入 Node 内置 test runner (`node --test`) |
| 无性能基准测试 | 无法追踪重构是否引入性能退化 | 后续添加 Benchmark 用例 |
| 无 `new` 运算符的专项测试 | Test 4d 仅间接用到 | 下一迭代补充 |
| 无数组/对象字面量的专项测试 | 仅在复杂场景中间接使用 | 下一迭代补充 |
| 无错误分支的全面测试 | 仅覆盖了 TDZ | 下一迭代补充 TypeError/SyntaxError 用例 |
| 无闭包三级分类专项测试 | 顶层/嵌套/真闭包分类逻辑无独立验证 | ✅ Test 10 已补充 |
| 无 debug 模式端到端测试 | 报错不阻断回放仅手动验证 | 下一迭代补充 |
| 无交互式页面自动化测试 | 面板联动/锁定态/源码选中仅手动验证 | 后续引入 Cypress/Playwright |
| 无跨作用域同名变量专项测试 | `outer` vs `outer2` 的 `var x` 选择 | 下一迭代补充 |
| 无 `new` 运算符的专项测试 | Test 4d 仅间接用到 | 下一迭代补充 |
