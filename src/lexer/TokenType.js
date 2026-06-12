/**
 * TokenType.js —— Token 类型枚举 与 关键字映射表
 *
 * 本模块定义了两大核心导出：
 *   1. TokenType  —— 枚举所有可能的 Token 种类
 *   2. KEYWORDS   —— 关键字字符串 → TokenType 的映射表
 *
 * TokenType 枚举的作用：
 * ──────────────────────
 * 通过为每种 Token 分配一个字符串常量（例如 'VAR'、'PLUS'），
 * 词法分析器和解析器在代码中可以直接使用可读的标识符（如 TokenType.VAR）
 * 而非魔法字符串，减少拼写错误，提升可维护性。
 *
 * KEYWORDS 映射表的作用：
 * ──────────────────────
 * 词法分析器在识别标识符后，用此映射表快速判断该标识符是否为关键字。
 * 将“关键字”用映射表定义而非硬编码在词法分析逻辑中，使得关键字列表
 * 的增删改只需修改此处一处即可生效。
 */

// ─── TokenType 枚举 ─────────────────────────────────────────────────────

/**
 * Token 类型的枚举常量。
 *
 * 按语义类别分为以下几个大组：
 *   1. 关键字（Keywords）       —— var / let / const / function 等
 *   2. 字面量（Literals）       —— 数字、字符串、布尔、null、undefined
 *   3. 标识符（Identifier）     —— 用户自定义的变量名/函数名
 *   4. 运算符（Operators）      —— 算术、赋值、比较、逻辑、自增/自减
 *   5. 标点符号（Punctuation）   —— 括号、花括号、分号、逗号等
 *   6. 特殊（Special）          —— EOF（输入结束标记）
 *
 * 为什么为每种运算符单独定义一个类型，而非使用通用的 'OPERATOR'？
 * 解析器的语义分析（尤其是优先级和结合性）需要区分具体运算符，
 * 因此这里的类型粒度较细。例如 TokenType.PLUS 和 TokenType.MINUS
 * 都需要独立类型以参与后续的表达式解析。
 *
 * @enum {string}
 */
export const TokenType = {
    // ─── 关键字（Keywords） ──────────────────────────────────────────
    //
    // 对应 ECMA-262 中的保留字。它们具有特殊语义，不能作为
    // 标识符使用。词法分析器识别到这些字符串后，返回对应的
    // TokenType 而非 IDENTIFIER。

    VAR: 'VAR',                 // var —— 函数作用域变量声明（可提升）
    LET: 'LET',                 // let —— 块级作用域变量声明（TDZ 约束）
    CONST: 'CONST',             // const —— 常量声明，不可重新赋值
    FUNCTION: 'FUNCTION',       // function —— 函数声明 / 函数表达式关键字
    RETURN: 'RETURN',           // return —— 函数返回值语句
    IF: 'IF',                   // if —— 条件分支
    ELSE: 'ELSE',               // else —— 条件分支的备选路径
    FOR: 'FOR',                 // for —— 循环语句
    WHILE: 'WHILE',             // while —— 循环语句
    THIS: 'THIS',               // this —— 当前执行上下文绑定
    NEW: 'NEW',                 // new —— 构造函数调用
    TYPEOF: 'TYPEOF',           // typeof —— 类型查询运算符
    INSTANCEOF: 'INSTANCEOF',   // instanceof —— 原型链检测运算符
    DELETE: 'DELETE',           // delete —— 属性删除运算符

    // ─── 字面量（Literals） ──────────────────────────────────────────
    //
    // 表示程序中的“具体值”。TRUE/FALSE/NULL/UNDEFINED 虽然语法上
    // 像关键字，但在 AST 构建层面更接近字面量——它们代表的是“值”。

    NUMBER: 'NUMBER',           // 数字字面量，例如 42、3.14、1e5
    STRING: 'STRING',           // 字符串字面量，例如 "hello"、'world'
    TRUE: 'TRUE',               // 布尔字面量 true
    FALSE: 'FALSE',             // 布尔字面量 false
    NULL: 'NULL',               // null 字面量
    UNDEFINED: 'UNDEFINED',     // undefined 字面量（ES6+ 虽不是保留字，但作为字面量处理）

    // ─── 标识符（Identifier） ────────────────────────────────────────

    IDENTIFIER: 'IDENTIFIER',   // 用户定义的变量名/函数名/属性名

    // ─── 运算符（Operators） ─────────────────────────────────────────
    //
    // 每个运算符都有独立的 TokenType，原因：
    // 解析器在做表达式解析时需要精确区分不同运算符的优先级与结合性。
    // 例如 + 和 - 虽然优先级相同（都由加法表达式处理），但语义不同。

    // 算术运算符
    PLUS: 'PLUS',               // + 加法 / 字符串连接
    MINUS: 'MINUS',             // - 减法 / 一元取负
    MULTIPLY: 'MULTIPLY',       // * 乘法
    DIVIDE: 'DIVIDE',           // / 除法
    MODULO: 'MODULO',           // % 取模（求余）

    // 赋值运算符
    ASSIGN: 'ASSIGN',           // = 简单赋值
    PLUS_ASSIGN: 'PLUS_ASSIGN',         // += 加后赋值
    MINUS_ASSIGN: 'MINUS_ASSIGN',       // -= 减后赋值
    MULTIPLY_ASSIGN: 'MULTIPLY_ASSIGN', // *= 乘后赋值

    // 比较运算符
    EQUAL: 'EQUAL',                     // == 宽松相等
    NOT_EQUAL: 'NOT_EQUAL',             // != 宽松不等
    STRICT_EQUAL: 'STRICT_EQUAL',       // === 严格相等
    STRICT_NOT_EQUAL: 'STRICT_NOT_EQUAL', // !== 严格不等
    GREATER: 'GREATER',                 // > 大于
    GREATER_EQUAL: 'GREATER_EQUAL',     // >= 大于等于
    LESS: 'LESS',                       // < 小于
    LESS_EQUAL: 'LESS_EQUAL',           // <= 小于等于

    // 逻辑运算符
    AND: 'AND',                 // && 逻辑与（短路求值）
    OR: 'OR',                   // || 逻辑或（短路求值）
    NOT: 'NOT',                 // ! 逻辑非

    // 自增 / 自减运算符
    INCREMENT: 'INCREMENT',     // ++ 自增
    DECREMENT: 'DECREMENT',     // -- 自减

    // ─── 标点符号（Punctuation） ─────────────────────────────────────
    //
    // 这些 Token 用于构造代码的结构（语句边界、参数列表、对象字面量等）。
    // 尽管有些符号同时也是运算符的一部分（例如 + 和 ++），
    // 此处仅列出独立的标点符号。

    LPAREN: 'LPAREN',           // ( 左圆括号（用于表达式分组 / 函数调用 / 参数列表）
    RPAREN: 'RPAREN',           // ) 右圆括号
    LBRACE: 'LBRACE',           // { 左花括号（用于代码块 / 对象字面量）
    RBRACE: 'RBRACE',           // } 右花括号
    LBRACKET: 'LBRACKET',       // [ 左方括号（用于数组字面量 / 属性访问）
    RBRACKET: 'RBRACKET',       // ] 右方括号
    SEMICOLON: 'SEMICOLON',     // ; 分号（语句终止符；JS 中可自动插入）
    COMMA: 'COMMA',             // , 逗号（表达式列表分隔符）
    DOT: 'DOT',                 // . 点号（成员访问运算符）
    COLON: 'COLON',             // : 冒号（用于对象属性 / 三元运算符 / 标签语句）
    QUESTION: 'QUESTION',       // ? 问号（用于三元运算符 / 可选链）
    ARROW: 'ARROW',             // => 箭头函数（胖箭头）

    // ─── 特殊（Special） ─────────────────────────────────────────────

    EOF: 'EOF',                 // End Of File —— 源码输入结束标记。
                                // 解析器遇到此 Token 时停止解析。
                                // 为什么需要 EOF？
                                // 统一处理所有 Token 的边界条件，
                                // 避免解析器在未预期的位置处理 null/undefined。
};

// ─── 关键字映射表 ───────────────────────────────────────────────────────

/**
 * 关键字字符串 → TokenType 的双向快速查找表。
 *
 * 词法分析器的工作流程：
 *   1. 扫描到一个标识符（连续的字母/下划线/数字字符）
 *   2. 在 KEYWORDS 映射表中查找该字符串
 *   3. 如果命中 → 返回对应的关键字 TokenType（例如 TokenType.VAR）
 *   4. 如果未命中 → 它就是普通标识符，返回 TokenType.IDENTIFIER
 *
 * 为什么用对象字面量而不用 Map？
 * - 关键字列表在编译时已确定，运行时不会变化
 * - 对象字面量在 V8 中会被优化为“形状固定”的隐藏类，查找比 Map 更快
 * - 代码更简洁，不需要 .get() / .has() 的调用开销
 *
 * @type {{ [keyword: string]: string }}
 */
export const KEYWORDS = {
    var: TokenType.VAR,
    let: TokenType.LET,
    const: TokenType.CONST,
    function: TokenType.FUNCTION,
    return: TokenType.RETURN,
    if: TokenType.IF,
    else: TokenType.ELSE,
    for: TokenType.FOR,
    while: TokenType.WHILE,
    this: TokenType.THIS,
    new: TokenType.NEW,
    typeof: TokenType.TYPEOF,
    instanceof: TokenType.INSTANCEOF,
    delete: TokenType.DELETE,
    true: TokenType.TRUE,
    false: TokenType.FALSE,
    null: TokenType.NULL,
    undefined: TokenType.UNDEFINED,
};
