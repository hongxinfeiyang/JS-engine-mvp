#0
创建阶段开始 — 全局环境
context:creation:start
💡 创建阶段：扫描声明并提升，var → undefined，let/const → TDZ
创建
#1
函数创建 — getX（顶层函数）
closure:create
💡 getX 是顶层函数，无外层变量可捕获
创建
#2
声明函数 — function getX（提升并完整初始化）
variable:declare
💡 函数声明完整提升，可在声明前调用
创建
#3
声明变量 — var obj = undefined（提升初始化）
variable:declare
💡 var 提升至函数/全局作用域顶部，初始值 undefined
创建
#4
创建阶段完成 — 全局环境（环境就绪，即将执行代码）
context:creation:end
💡 创建阶段完成，进入执行阶段逐条执行代码
创建
#5
变量赋值 — obj = "<object>"
variable:assign
执行
#6
"getX" 执行上下文创建阶段开始 — this绑定阶段 — 作用域查找 — 开始查找
scope:lookup
💡 沿作用域链从内向外查找标识符 "getX"
创建
#7
作用域查找结果 — "getX" 找到（深度=0）
scope:chain:resolve
💡 标识符 "getX" 在深度 0 处找到
创建
#8
读取变量 — getX → "<function:getX>"
variable:read
创建
#9
"obj" 执行上下文创建阶段开始 — this绑定阶段 — 作用域查找 — 开始查找
scope:lookup
💡 沿作用域链从内向外查找标识符 "obj"
创建
#10
作用域查找结果 — "obj" 找到（深度=0）
scope:chain:resolve
💡 标识符 "obj" 在深度 0 处找到
创建
#11
读取变量 — obj → "<object>"
variable:read
创建
#12
this指向 — 模式: explicit, 值: "<object>"
this:resolve
💡 通过 call/apply/bind 显式指定 this
创建
#13
环境变量声明阶段开始 — 函数 getX
context:creation:start
💡 创建阶段：扫描声明并提升，var → undefined，let/const → TDZ
创建
#14
执行上下文创建完成 — 函数 getX
context:creation:end
💡 创建阶段完成，进入执行阶段逐条执行代码
创建
#15
函数调用 — getX()
function:call
执行
#16
执行上下文入栈 — function getX
context:push
执行
#17
this指向 — 模式: current, 值: "<object>"
this:resolve
创建
#18
return 语句值 → "{\"value\":42}"
eval:node:exit
执行
#19
执行上下文出栈 — function getX
context:pop
执行
#20
函数返回 — getX → 42
function:return
执行
#21
表达式计算结果 → 42
eval:node:exit
执行