#0
创建阶段开始 — 全局环境
context:creation:start
💡 创建阶段：扫描声明并提升，var → undefined，let/const → TDZ
创建
#1
函数创建 — outer（顶层函数）
closure:create
💡 outer 是顶层函数，无外层变量可捕获
创建
#2
声明函数 — function outer（提升并完整初始化）
variable:declare
💡 函数声明完整提升，可在声明前调用
创建
#3
声明变量 — var fn = undefined（提升初始化）
variable:declare
💡 var 提升至函数/全局作用域顶部，初始值 undefined
创建
#4
创建阶段完成 — 全局环境（环境就绪，即将执行代码）
context:creation:end
💡 创建阶段完成，进入执行阶段逐条执行代码
创建
#5
"outer" 执行上下文创建阶段开始 — this绑定阶段 — 作用域查找 — 开始查找
scope:lookup
💡 沿作用域链从内向外查找标识符 "outer"
创建
#6
作用域查找结果 — "outer" 找到（深度=0）
scope:chain:resolve
💡 标识符 "outer" 在深度 0 处找到
创建
#7
读取变量 — outer → "<function:outer>"
variable:read
创建
#8
this指向 — 模式: default, 值: "global"
this:resolve
创建
#9
环境变量声明阶段开始 — 函数 outer
context:creation:start
💡 创建阶段：扫描声明并提升，var → undefined，let/const → TDZ
创建
#10
声明变量 — var x = undefined（提升初始化）
variable:declare
💡 var 提升至函数/全局作用域顶部，初始值 undefined
创建
#11
闭包创建 — inner 捕获变量 [x]
closure:create
💡 闭包：inner 捕获了外层变量 [x]，形成闭包
创建
#12
声明函数 — function inner（提升并完整初始化）
variable:declare
💡 函数声明完整提升，可在声明前调用
创建
#13
执行上下文创建完成 — 函数 outer
context:creation:end
💡 创建阶段完成，进入执行阶段逐条执行代码
创建
#14
执行上下文入栈 — function outer
context:push
执行
#15
函数调用 — outer()
function:call
执行
#16
变量赋值 — x = 10
variable:assign
执行
#17
"inner" 作用域查找 — 开始查找
scope:lookup
💡 沿作用域链从内向外查找标识符 "inner"
执行
#18
作用域查找结果 — "inner" 找到（深度=0）
scope:chain:resolve
💡 标识符 "inner" 在深度 0 处找到
执行
#19
读取变量 — inner → "<function:inner>"
variable:read
执行
#20
return 语句值 → "{\"value\":{\"address\":8}}"
eval:node:exit
执行
#21
执行上下文出栈 — function outer
context:pop
执行
#22
函数返回 — outer → "<function:inner>"
function:return
执行
#23
变量赋值 — fn = "<function:inner>"
variable:assign
执行
#24
"fn" 执行上下文创建阶段开始 — this绑定阶段 — 作用域查找 — 开始查找
scope:lookup
💡 沿作用域链从内向外查找标识符 "fn"
创建
#25
作用域查找结果 — "fn" 找到（深度=0）
scope:chain:resolve
💡 标识符 "fn" 在深度 0 处找到
创建
#26
读取变量 — fn → "<function:inner>"
variable:read
创建
#27
this指向 — 模式: default, 值: "global"
this:resolve
创建
#28
环境变量声明阶段开始 — 函数 inner
context:creation:start
💡 创建阶段：扫描声明并提升，var → undefined，let/const → TDZ
创建
#29
执行上下文创建完成 — 函数 inner
context:creation:end
💡 创建阶段完成，进入执行阶段逐条执行代码
创建
#30
执行上下文入栈 — function inner
context:push
执行
#31
函数调用 — inner()
function:call
执行
#32
"x" 作用域查找 — 开始查找
scope:lookup
💡 沿作用域链从内向外查找标识符 "x"
执行
#33
作用域查找结果 — "x" 找到（深度=1）
scope:chain:resolve
💡 标识符 "x" 在深度 1 处找到
执行
#34
读取变量 — x → 10
variable:read
执行
#35
return 语句值 → "{\"value\":11}"
eval:node:exit
执行
#36
执行上下文出栈 — function inner
context:pop
执行
#37
函数返回 — inner → 11
function:return
执行
#38
表达式计算结果 → 11
eval:node:exit
执行