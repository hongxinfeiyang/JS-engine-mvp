# JS Engine MVP 技术详设

## 1. Lexer（词法分析器）

### 1.1 输入输出

- **输入**：源代码字符串
- **输出**：Token 数组，末尾以 `EOF` Token 终结

### 1.2 扫描算法

```
tokenize():
  while pos < source.length:
    _skipWhitespaceAndComments()    // 跳过空白和注释
    if pos >= source.length: break
    token = _readToken()            // 分派到具体读取方法
    tokens.push(token)
  tokens.push(Token(EOF, '', pos))
  return tokens
```

### 1.3 分词分派逻辑 (_readToken)

```
当前字符:
  数字或 '.' + 数字  →  _readNumber()
  '"' 或 "'"         →  _readString(quote)
  字母、_、$          →  _readIdentifier()，再查关键字表
  '=' + '>'          →  Token(ARROW, '=>')
  两字符运算符        →  查 twoCharMap（==, !=, >=, <=, &&, ||, ++, --, +=, -=, *=）
  三字符运算符        →  查 === 和 !==
  单字符              →  查 singleMap（+ - * / % = > < ! ( ) { } [ ] ; , . : ?）
  其他                →  throw SyntaxError
```

### 1.4 注释处理

- `// ... \n`：单行注释，遇到换行停止
- `/* ... */`：多行注释，支持跨行（换行符号更新行列号）

两种注释在 `_skipWhitespaceAndComments` 中统一处理。

### 1.5 数字读取

```
_readNumber():
  整数部分: while isDigit(ch): accumulate
  可选小数: if ch == '.' and isDigit(next): consume '.' + 小数部分
  返回 Token(NUMBER, Number(value))
```

当前不支持：科学计数法 (`1e5`)、二进制 (`0b`)、八进制 (`0o`)、十六进制 (`0x`)。

### 1.6 字符串转义

支持 `\n`, `\t`, `\r`, `\\`, `\"`, `\'` 六种转义序列。

---

## 2. Parser（语法分析器）

### 2.1 整体结构

```
parse():
  body = []
  while not EOF:
    body.push(_parseStatement())
  return Program(body)
```

- **Statement 层**：递归下降，每个 `_parseXxxStatement` 方法对应一种语句
- **Expression 层**：Pratt Parsing，`_parseExpression(precedence)` 根据优先级驱动

### 2.2 Statement 分派

```
_parseStatement():
  check LBRACE    → _parseBlockStatement()
  match VAR       → _parseVariableDeclaration('var')
  match LET       → _parseVariableDeclaration('let')
  match CONST     → _parseVariableDeclaration('const')
  match FUNCTION  → _parseFunctionDeclaration()
  match RETURN    → _parseReturnStatement()
  match IF        → _parseIfStatement()
  match FOR       → _parseForStatement()
  match WHILE     → _parseWhileStatement()
  match SEMICOLON → ExpressionStatement(undefined)  // 空语句
  default         → _parseExpressionStatement()
```

**Why 使用 `_check(LBRACE)` 而非 `_match(LBRACE)`**：`_match` 会消耗 Token，导致后续 `_parseBlockStatement` 中的 `_consume(LBRACE)` 找不到。其余关键字使用 `_match` 是因为它们本身在对应方法中不再被消耗。

### 2.3 Pratt 表达式解析

```
_parseExpression(precedence = 0):
  left = _parsePrimary()          // 解析前缀（原子表达式或前缀运算符）
  while true:
    token = peek()
    if token is ARROW              → reparse as arrow function
    if token is QUESTION           → 三元表达式 (?:)
    if token is EOF or SEMICOLON   → break
    if PRECEDENCE[token] < prec    → break
    if token is ASSIGNMENT         → 右结合 (prec - 1)
    else                           → 左结合 (prec + 1)
    left = combine(left, op, right)
  return left
```

### 2.4 运算符优先级表

```js
const PRECEDENCE = {
    ASSIGN: 2, PLUS_ASSIGN: 2, MINUS_ASSIGN: 2, MULTIPLY_ASSIGN: 2,
    QUESTION: 3,            // 三元
    OR: 4,                  // ||
    AND: 5,                 // &&
    EQUAL: 6, NOT_EQUAL: 6, STRICT_EQUAL: 6, STRICT_NOT_EQUAL: 6,
    GREATER: 7, GREATER_EQUAL: 7, LESS: 7, LESS_EQUAL: 7,
    PLUS: 8, MINUS: 8,
    MULTIPLY: 9, DIVIDE: 9, MODULO: 9,
};
```

**Why 三元运算符优先级为 3**：使其低于赋值 (=2) 且高于逻辑运算符。`a = b ? c : d` 解析为 `a = (b ? c : d)` 而非 `(a = b) ? c : d`。

### 2.5 _parsePrimary 前缀解析

```
_parsePrimary():
  前缀运算符: ++, --, !, -, typeof, delete, +
  LPAREN:
    空括号 ()           → ArrowFunction([])
    含箭头参数 (a,b)=>  → ArrowFunction([a,b])
    普通括号 (expr)     → 分组表达式
  FUNCTION              → _parseFunctionExpression()
  THIS                  → ThisExpression()
  NEW                   → NewExpression(callee, args)
  LBRACKET              → _parseArrayExpression()
  LBRACE                → _parseObjectExpression()
  NUMBER/STRING/BOOL    → _parseLiteral()
  IDENTIFIER            → Identifier(name)
  
  后缀: LPAREN → Call, LBRACKET → Member[computed], DOT → Member, INCREMENT/DECREMENT → Update
```

### 2.6 箭头函数检测（前瞻）

```js
// 在 LPAREN 分支中前瞻判断是否为箭头函数参数
// 算法: 从当前 pos 扫描，维护 parenDepth，直到找到匹配的 RPAREN
// 检查 RPAREN 后的 token 是否为 ARROW (=>)
// 是 → 按箭头函数参数解析
// 否 → 按分组表达式解析，从保存的 pos 重新开始
```

### 2.7 AST 节点 ID

每个 AST 节点有唯一自增 ID（`nodeIdCounter`），用于 hook 输出中关联 enter/exit 事件。

---

## 3. Runtime 层

### 3.1 Memory（堆管理）

**数据结构**：
```js
heap: Map<address, { type: string, value: any, refCount: number }>
```

**地址分配**：自增整数，从 1 开始。原始值不进入堆。

**refCount 字段**：为 GC 预留的引用计数占位。当前无实际增减逻辑。

**safeValue 序列化**：在 hook 输出时，将内部引用转为可读字符串。例如 `{ address: 3 }` → `<ref:3>`，函数对象 → `<function:name>`。

### 3.2 EnvironmentRecord

**DeclarativeEnvironmentRecord（声明式 ER）**：

内部数据结构：
```
bindings: Map<name, {
    value: any,          // 当前值
    mutable: boolean,    // 是否可变
    deletable: boolean,  // 是否可删除
    initialized: boolean // TDZ 标志
}>
```

**TDZ 实现原理**：
- `hasBinding(name)` → `binding !== undefined && binding.initialized`
- `hasUninitializedBinding(name)` → `binding !== undefined`（不管 initialized）
- `getBindingValue(name)` → 检查 `initialized`，false 则抛错

**ObjectEnvironmentRecord（对象式 ER）**：

额外维护 `_meta: Map<name, { mutable, deletable, initialized }>` 记录每个绑定的元信息。`hasBinding`/`getBindingValue` 通过查询 `_meta` 实现 TDZ。

用于全局环境——全局 var 声明通过 `setMutableBinding` 写入 `globalObject.properties`。这样 `var x = 1; this.x` 返回相同值。

**Why 全局环境用 Object ER**：
1. ECMAScript 规范要求全局环境是 Object ER（绑定到全局对象）
2. 实现 `this.x === x` 的语义
3. `console`、`undefined` 等内置对象作为全局对象属性自然可用

### 3.3 ExecutionContext

```js
{
    type: 'global' | 'function' | 'block',
    lexicalEnvironment: LexicalEnvironment,   // let/const 解析起点
    variableEnvironment: LexicalEnvironment,  // var 写入目标
    thisBinding: any,                         // 当前 this
    meta: { name: string },                   // 调试信息
}
```

**LE 与 VE 的关系**：
| EC Type | LE | VE | 原因 |
|---------|-----|-----|------|
| global | globalEnv | = LE | 同一环境 |
| function | 新建 localEnv | = LE | 同一环境，var/let/const 都在这 |
| block | 新建 blockEnv | 外层函数/全局的 VE | var 穿透到外层 |

### 3.4 Realm 初始化

```
Realm.constructor(hooks):
  memory = new Memory(hooks)        // 堆内存
  ecStack = new ECStack()
  
  // 1. 创建全局对象
  globalObjAddr = memory.allocate('object', {})
  props = new Map()
  props.set('console', createConsoleObject())  // console.log 直接桥接宿主 console
  props.set('Object', createBuiltinFunc())      // 占位构造函数
  props.set('Array', createBuiltinFunc())
  props.set('Function', createBuiltinFunc())
  props.set('undefined', undefined)
  props.set('NaN', NaN)
  props.set('Infinity', Infinity)
  
  // 2. 创建全局 LE
  globalRecord = new ObjectEnvironmentRecord({ properties: props })
  globalEnv = new LexicalEnvironment(null, globalRecord)
  
  // 3. 创建全局 EC 并入栈
  globalEC = new ExecutionContext('global', globalEnv, globalEnv, globalObject)
  ecStack.push(globalEC)
```

---

## 4. Evaluator（解释器）

### 4.1 调度器

`evaluate(node)` 是唯一的入口，通过 `switch(node.type)` 分派到对应方法。进入/退出时触发 `eval:node:enter` 和 `eval:node:exit`。

### 4.2 _evalProgram

```
_evalProgram(node):
  // Phase 1: 创建阶段
  触发 context:creation:start { type: 'global', name: 'program' }
  _hoistDeclarations(node.body, currentEC.variableEnvironment)
  触发 context:creation:end { type: 'global', name: 'program', envSnapshot }
  // Phase 2: 执行阶段
  触发 function:call { name: '<program>', args: [] }
  触发 context:push (EC.snapshot())
  result = _evalStatements(node.body)
  触发 context:pop { type: 'global', name: 'program' }
  触发 function:return { name: '<program>', value: result }
  return result
```

### 4.3 _applyFunction（函数调用核心）

```
_applyFunction(funcRef, args, thisValue):
  1. 校验: funcRef 必须是指向 FUNCTION 类型的引用
  2. 处理 bound function: 合并 boundArgs + args，递归 _applyFunction
  3. 处理 builtin function: 直接调用 funcObj.call(...args)

  // === Phase 1: 创建阶段 ===
  4. 触发 context:creation:start { type: 'function', name: funcName }
  5. 创建 localEnv = new LexicalEnvironment(funcObj.closure)  // outer = [[Environment]]
  6. 绑定参数到 localEnv（createMutableBinding + initializeBinding）
  7. _hoistDeclarations(bodyStatements, localEnv)  // var/let/const/function 提升
  8. 箭头函数: effectiveThis = funcObj.capturedThis（覆盖传入的 thisValue）
  9. 触发 context:creation:end { type: 'function', name: funcName, envSnapshot }

  // === Phase 2: 执行阶段 ===
  10. 触发 function:call { name: funcName, args, thisValue }
  11. 创建 funcEC(type='function', LE=localEnv, VE=localEnv, this=effectiveThis)
  12. ecStack.push(funcEC) → 触发 context:push
  13. 逐条执行函数体语句
  14. ecStack.pop() → 触发 context:pop
  15. 触发 function:return { name: funcName, value: result }
  16. return result
```

**Hook 时序总览**：`context:creation:start` → hoist/参数绑定 → `context:creation:end` → `function:call` + `context:push` → 逐条执行函数体 → `context:pop` + `function:return`

### 4.4 _resolveIdentifier（标识符解析）

```
_resolveIdentifier(name):
  env = currentEC.lexicalEnvironment
  depth = 0
  while env != null:
    if env.record.hasBinding(name):       // binding 存在且已初始化
      value = env.record.getBindingValue(name)
      触发 scope:chain:resolve { found: true, depth }
      触发 variable:read { name, value }
      return value
    if env.record.hasUninitializedBinding(name):  // binding 存在但 TDZ
      触发 scope:chain:resolve { found: true, depth }
      触发 ReferenceError (TDZ)
    env = env.outer
    depth++
  触发 scope:chain:resolve { found: false }
  throw ReferenceError (not defined)
```

### 4.5 属性赋值路径

`_evalAssignmentExpression` 支持两类左值：

```
Identifier 左值 (x = val):
  { environment } = _resolveIdentifierWithEnv(name)
  oldValue = environment.getBindingValue(name)
  newValue = compute(node.operator, oldValue, right)
  environment.setMutableBinding(name, newValue)
  → 触发 variable:assign

MemberExpression 左值 (obj.prop = val):
  obj = evaluate(node.left.object)
  prop = computed ? evaluate(property) : property.name
  heap[obj.address].value.properties.set(prop, newValue)
  → 触发 variable:assign
```

**Why 两条路径**：Identifier 赋值影响作用域中的绑定（可能是 TDZ 初始化），MemberExpression 赋值影响堆中对象的属性。二者的存储介质和副作用不同。

---

## 5. call/apply/bind 实现

### 5.1 检测点

`_evalCallExpression` 中检测 `callee.type === 'MemberExpression'` 且 `property` 为 `call/apply/bind`。

### 5.2 call 实现

```js
// fn.call(thisArg, arg1, arg2)
targetFunc = evaluate(node.callee.object)  // fn
thisArg = args[0] ?? globalObject
callArgs = args.slice(1)                   // [arg1, arg2]
_applyFunction(targetFunc, callArgs, thisArg)
```

### 5.3 apply 实现

```js
// fn.apply(thisArg, [arg1, arg2])
targetFunc = evaluate(node.callee.object)
thisArg = args[0] ?? globalObject
applyArgs = args[1] 是 ARRAY 引用 → heap[addr].value.elements
_applyFunction(targetFunc, applyArgs, thisArg)
```

### 5.4 bind 实现

```js
// fn.bind(thisArg, arg1, arg2)
boundFunc = {
    type: 'bound',
    targetFunc,
    boundThis: args[0] ?? globalObject,
    boundArgs: args.slice(1),
}
memory.allocate('function', boundFunc) → return makeRef(addr)
```

调用 bound 函数时，`_applyFunction` 检测 `type === 'bound'`，合并参数后递归调用 `_applyFunction(targetFunc, mergedArgs, boundThis)`。
