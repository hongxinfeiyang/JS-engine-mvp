/**
 * Token.js —— 词法单元（Token）
 *
 * 词法分析器（Lexer / Scanner）将源代码字符串切分为一系列 Token，
 * 每个 Token 是“最小的有语义的单元”。Token 序列随后交给解析器（Parser）
 * 构建 AST。
 *
 * 举例：源码 `var x = 42;` 会被切分成 5 个 Token：
 *   VAR( keyword ) → IDENTIFIER("x") → ASSIGN → NUMBER(42) → SEMICOLON
 *
 * 设计思路：
 *   Token 被设计为不可变（immutable）的数据对象——构造函数一次性设置
 *   所有属性，之后不会再改变。这样做的好处：
 *   - 解析器向前“看”（lookahead）时不会意外修改 Token。
 *   - 便于生成调试信息（堆栈追踪中可精确指回出错位置）。
 */

// ─── Token 类 ───────────────────────────────────────────────────────────

/**
 * 表示源码中的一个词法单元（Token）。
 *
 * 每个 Token 携带两类信息：
 *   - 语义信息：类型（TokenType 枚举）、值（字面量/标识符名）
 *   - 位置信息：pos（字节偏移）、line（行号）、col（列号）
 *     位置信息用于错误报告与调试——在抛出 SyntaxError 时能精确
 *     指出“哪一行、哪一列”出现了问题。
 */
export class Token {
    /**
     * 创建一个 Token。
     *
     * @param {string} type - Token 的类型，必须是 TokenType 枚举中的值。
     *   （例如 TokenType.VAR = 'VAR'）
     * @param {*} value - Token 的“值”：
     *   - 对于字面量 Token（NUMBER/STRING），value 是实际值（例如 42、"hello"）
     *   - 对于标识符 Token（IDENTIFIER），value 是变量名字符串
     *   - 对于关键字 Token（VAR/IF 等），value 是关键字字符串
     *   - 对于运算符/标点 Token，value 通常是该符号本身（例如 '+'、'('）
     * @param {number} pos - 该 Token 在源码中的字节/字符偏移量（0-based）
     * @param {number} line - 行号（1-based，方便人类阅读）
     * @param {number} col - 列号（1-based，方便人类阅读）
     */
    constructor(type, value, pos, line, col) {
        /**
         * Token 类型，来自 TokenType 枚举。
         * @type {string}
         */
        this.type = type;

        /**
         * Token 的值（字面量或标识符名）。
         * @type {*}
         */
        this.value = value;

        /**
         * 在源码中的字节/字符偏移量（0-based）。
         * @type {number}
         */
        this.pos = pos;

        /**
         * 行号（1-based）。与 col 配合可定位到源码中的具体字符。
         * @type {number}
         */
        this.line = line;

        /**
         * 列号（1-based）。
         * @type {number}
         */
        this.col = col;
    }
}
