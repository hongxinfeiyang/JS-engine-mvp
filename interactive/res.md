#0
创建阶段开始 — 全局环境
context:creation:start
💡 创建阶段：扫描声明并提升，var → undefined，let/const → TDZ
创建
#1
闭包创建 — outer 捕获变量 [console, Object, Array, Function, undefined, NaN, Infinity, outer]
closure:create
💡 函数创建时捕获当前词法环境作为 [[Environment]]，形成闭包
创建
#2
声明函数 — function outer（提升并完整初始化）
variable:declare
💡 函数声明完整提升，可在声明前调用
创建
#3
闭包创建 — outer2 捕获变量 [console, Object, Array, Function, undefined, NaN, Infinity, outer, outer2]
closure:create
💡 函数创建时捕获当前词法环境作为 [[Environment]]，形成闭包
创建
#4
声明函数 — function outer2（提升并完整初始化）
variable:declare
💡 函数声明完整提升，可在声明前调用
创建
#5
声明变量 — var fn = undefined（提升初始化）
variable:declare
💡 var 提升至函数/全局作用域顶部，初始值 undefined
创建
#6
创建阶段完成 — 全局环境（环境就绪，即将执行代码）
context:creation:end
💡 创建阶段完成，进入执行阶段逐条执行代码
创建
#7
作用域查找 — 开始查找 "outer"
scope:lookup
💡 沿作用域链从内向外查找标识符 "outer"
执行
#8
作用域查找结果 — "outer" 找到（深度=0）
scope:chain:resolve
💡 标识符 "outer" 在深度 0 处找到
执行
#9
读取变量 — outer → "<function:outer>"
variable:read
执行
#10
this 绑定 — 模式: default, 值: "global"
this:resolve
执行
#11
创建阶段开始 — 函数 outer
context:creation:start
💡 创建阶段：扫描声明并提升，var → undefined，let/const → TDZ
创建
#12
声明变量 — var x = undefined（提升初始化）
variable:declare
💡 var 提升至函数/全局作用域顶部，初始值 undefined
创建
#13
创建阶段完成 — 函数 outer（环境就绪，即将执行代码）
context:creation:end
💡 创建阶段完成，进入执行阶段逐条执行代码
创建
#14
函数调用 — outer()
function:call
执行
#15
执行上下文入栈 — function outer
context:push
执行
#16
变量赋值 — x = 10
variable:assign
执行
#17
闭包创建 — inner 捕获变量 [x]
closure:create
💡 函数创建时捕获当前词法环境作为 [[Environment]]，形成闭包
创建
#18
return 语句值 → "{\"value\":{\"address\":9}}"
eval:node:exit
执行
#19
执行上下文出栈 — function outer
context:pop
执行
#20
函数返回 — outer → "<function:inner>"
function:return
执行
#21
变量赋值 — fn = "<function:inner>"
variable:assign
执行
#22
作用域查找 — 开始查找 "fn"
scope:lookup
💡 沿作用域链从内向外查找标识符 "fn"
执行
#23
作用域查找结果 — "fn" 找到（深度=0）
scope:chain:resolve
💡 标识符 "fn" 在深度 0 处找到
执行
#24
读取变量 — fn → "<function:inner>"
variable:read
执行
#25
this 绑定 — 模式: default, 值: "global"
this:resolve
执行
#26
创建阶段开始 — 函数 inner
context:creation:start
💡 创建阶段：扫描声明并提升，var → undefined，let/const → TDZ
创建
#27
创建阶段完成 — 函数 inner（环境就绪，即将执行代码）
context:creation:end
💡 创建阶段完成，进入执行阶段逐条执行代码
创建
#28
函数调用 — inner()
function:call
执行
#29
执行上下文入栈 — function inner
context:push
执行
#30
作用域查找 — 开始查找 "x"
scope:lookup
💡 沿作用域链从内向外查找标识符 "x"
执行
#31
作用域查找结果 — "x" 找到（深度=1）
scope:chain:resolve
💡 标识符 "x" 在深度 1 处找到
执行
#32
读取变量 — x → 10
variable:read
执行
#33
return 语句值 → "{\"value\":11}"
eval:node:exit
执行
#34
执行上下文出栈 — function inner
context:pop
执行
#35
函数返回 — inner → 11
function:return
执行
#36
表达式计算结果 → 11
eval:node:exit
执行
#37
作用域查找 — 开始查找 "outer2"
scope:lookup
💡 沿作用域链从内向外查找标识符 "outer2"
执行
#38
作用域查找结果 — "outer2" 找到（深度=0）
scope:chain:resolve
💡 标识符 "outer2" 在深度 0 处找到
执行
#39
读取变量 — outer2 → "<function:outer2>"
variable:read
执行
#40
this 绑定 — 模式: default, 值: "global"
this:resolve
执行
#41
创建阶段开始 — 函数 outer2
context:creation:start
💡 创建阶段：扫描声明并提升，var → undefined，let/const → TDZ
创建
#42
声明变量 — var x = undefined（提升初始化）
variable:declare
💡 var 提升至函数/全局作用域顶部，初始值 undefined
创建
#43
创建阶段完成 — 函数 outer2（环境就绪，即将执行代码）
context:creation:end
💡 创建阶段完成，进入执行阶段逐条执行代码
创建
#44
函数调用 — outer2()
function:call
执行
#45
执行上下文入栈 — function outer2
context:push
执行
#46
变量赋值 — x = 10
variable:assign
执行
#47
return 语句值 → "{\"value\":22}"
eval:node:exit
执行
#48
执行上下文出栈 — function outer2
context:pop
执行
#49
函数返回 — outer2 → 22
function:return
执行
#50
表达式计算结果 → 22
eval:node:exit
执行