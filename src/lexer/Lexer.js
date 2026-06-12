/**
 * @fileoverview 词法分析器（Lexer / Tokenizer）模块
 *
 * 职责：
 *   将 JavaScript 源代码字符串作为输入，按顺序扫描字符流，输出一个 Token（词法单元）数组。
 *   该 Lexer 同时承担了跳过空白字符与注释（单行 `//`、多行 `/* * /`）的任务，
 *   因为从语法分析器（Parser）的角度看，空白和注释不是有意义的词法单元。
 *
 * 设计决策：
 *   1. 采用“手工编写状态机”而非正则表达式驱动 —— 正则虽然简洁，但难以精确追踪行列号，
 *      并且无法方便地在扫描过程中插入 hook 事件。手工循环对位置追踪和错误报告更友好。
 *   2. Token 的 value 字段存储运行时可用的 JS 值（数字存 Number，字符串存转义后的内容），
 *      避免 Parser 侧重复做运行时转换。
 *   3. 关键字查找放在标识符读取完成之后（`_readIdentifier`），而不是在扫描过程中逐字符判断。
 *      因为关键字本身也是合法的标识符前缀（如 `undefined`、`instanceof`），
 *      读完完整标识符再去 `KEYWORDS` 表中查表，代码更简单且 O(1) 查表无性能损失。
 *   4. 三字符运算符（`===`、`!==`）和两字符运算符（`==`、`!=` 等）存在公共前缀（`==` 同时是
 *      `===` 的前缀）。这里采用“三字符优先匹配”策略：在 `_readToken` 中，两字符表里虽然
 *      也定义了 `===` / `!==`，但实际匹配到 `==` 时只消费 2 个字符就会返回；因此必须把
 *      `===` / `!==` 的检测放在两字符匹配之前，才能保证 3 字符运算符不会被错误截断。
 *   5. `_serializeToken` 的存在是为了 hook 数据的序列化安全 —— Token 对象可能包含循环引用
 *      或被 hook 回调意外修改，序列化为纯对象后传递给 hook，防止副作用扩散。
 *
 * @module Lexer
 */

import { Token } from './Token.js';
import { TokenType, KEYWORDS } from './TokenType.js';
import { HookEvents } from '../hooks/HookEvents.js';

/**
 * 词法分析器
 *
 * 读取源代码字符串，生成 Token 序列。
 * 支持 JavaScript 的核心词法规则：标识符、关键字、数字、字符串、运算符、分隔符，
 * 同时处理空白字符和注释的跳过逻辑。
 *
 * @example
 *   const lexer = new Lexer('let a = 1;', hooks);
 *   const tokens = lexer.tokenize();
 */
export class Lexer {
    // ─── 构造函数：初始化扫描状态 ───

    /**
     * 创建 Lexer 实例
     *
     * @param {string} source - 待分析的 JavaScript 源代码字符串
     * @param {object} hooks - 事件钩子系统，用于在扫描关键节点触发回调（开始/每个 token/结束）
     */
    constructor(source, hooks) {
        /** @type {string} 源代码全文 */
        this.source = source;
        /** @type {object} hook 事件发射器 */
        this.hooks = hooks;
        /** @type {number} 当前扫描位置（字符索引） */
        this.pos = 0;
        /** @type {number} 当前行号（从 1 开始，方便报错时直接对应用户看到的行数） */
        this.line = 1;
        /** @type {number} 当前列号（从 1 开始，同上） */
        this.col = 1;
        /** @type {Token[]} 已识别出的 Token 列表，按源码顺序排列 */
        this.tokens = [];
    }

    // ─── 主入口：tokenize() ───

    /**
     * 执行完整的词法分析，返回 Token 数组
     *
     * 扫描过程：
     *   1. 发射 TOKENIZE_START hook
     *   2. 循环：跳过空白/注释 -> 读取一个 Token -> 发射 TOKEN hook
     *   3. 在末尾追加 EOF（文件结束）Token
     *   4. 发射 TOKENIZE_END hook，将完整 Token 列表序列化后传出
     *
     * 为什么追加 EOF Token：
     *   语法分析器需要一个明确的结束信号。EOF 作为虚拟 Token 标志着输入流的结束，
     *   避免 Parser 在消费完最后一个 Token 后仍尝试读取，简化了 Parser 的终止判断。
     *
     * @returns {Token[]} 包含所有词法单元的数组，最后一项为 EOF
     */
    tokenize() {
        this.hooks.emit(HookEvents.TOKENIZE_START, { source: this.source });

        while (this.pos < this.source.length) {
            this._skipWhitespaceAndComments();
            // 跳过空白后可能已经到达文件末尾，需要再次检查
            if (this.pos >= this.source.length) break;

            const token = this._readToken();
            this.tokens.push(token);
            // 每个 Token 识别后立即通知 hook，支持实时观察 / 调试 / 插桩
            this.hooks.emit(HookEvents.TOKEN, { token: this._serializeToken(token) });
        }

        // EOF Token：告知 Parser 输入流结束
        const eof = new Token(TokenType.EOF, '', this.pos, this.line, this.col);
        this.tokens.push(eof);
        this.hooks.emit(HookEvents.TOKEN, { token: this._serializeToken(eof) });
        // TOKENIZE_END 传递完整 Token 数组的序列化副本，避免外部持有内部可变引用
        this.hooks.emit(HookEvents.TOKENIZE_END, { tokens: this.tokens.map(t => this._serializeToken(t)) });

        return this.tokens;
    }

    // ─── 空白与注释跳过 ───

    /**
     * 跳过当前位置开始的所有空白字符和注释，直到遇到有效代码字符
     *
     * 支持的空白类型：
     *   - 空格、水平制表符、回车符（老式 Mac 行尾）
     *   - 换行符 `\n`（同时更新行列号）
     *   - 单行注释 `// ...`
     *   - 多行注释 `/* ... *‍/`
     *
     * 为什么空白/注释跳过放在同一个方法里：
     *   它们的共同特征是“对语法分析无意义”，合并处理可以统一向前推进 pos，
     *   避免 `tokenize()` 主循环中出现多个分散的跳过调用。
     *
     * 为什么把 `\r` 当普通空白而不是换行：
     *   `\r` 在现代系统中几乎只出现在 `\r\n` 组合或极老的 Mac 格式里。
     *   这里不把 `\r` 视作换行，保持行号语义与 `\n` 一致，简化行列追踪。
     *
     * @private
     */
    _skipWhitespaceAndComments() {
        while (this.pos < this.source.length) {
            const ch = this.source[this.pos];

            // 普通空白：空格、Tab、回车
            if (ch === ' ' || ch === '\t' || ch === '\r') {
                this._advance();
                continue;
            }

            // 换行：需更新行列号
            if (ch === '\n') {
                this.line++;
                this.col = 1;   // 列号回到行首
                this.pos++;
                continue;
            }

            // 单行注释：跳过直到行尾（不消费 `\n`，留给下一轮处理以正确更新行号）
            if (ch === '/' && this.source[this.pos + 1] === '/') {
                // 注意：不消费换行符，让换行分支在下一轮迭代中处理行号更新
                while (this.pos < this.source.length && this.source[this.pos] !== '\n') {
                    this.pos++;
                    this.col++;
                }
                continue;
            }

            // 多行注释：需处理内部换行以保持行号正确
            if (ch === '/' && this.source[this.pos + 1] === '*') {
                this.pos += 2;
                this.col += 2;
                while (this.pos < this.source.length) {
                    if (this.source[this.pos] === '*' && this.source[this.pos + 1] === '/') {
                        this.pos += 2;
                        this.col += 2;
                        break;
                    }
                    // 多行注释内部可能包含换行，需同步更新行号
                    if (this.source[this.pos] === '\n') {
                        this.line++;
                        this.col = 1;
                    } else {
                        this.col++;
                    }
                    this.pos++;
                }
                continue;
            }

            // 当前字符不是任何可跳过的内容，退出循环
            break;
        }
    }

    // ─── Token 识别（分发） ───

    /**
     * 从当前位置读取一个完整的 Token
     *
     * 匹配顺序非常重要（按优先级从高到低）：
     *   1. 数字 —— 以数字或 `.` 后跟数字开头
     *   2. 字符串 —— 以引号开头
     *   3. 标识符 / 关键字 —— 以字母、`_`、`$` 开头
     *   4. 箭头 `=>` —— 两字符特殊符号，需在普通 `=` 之前匹配
     *   5. 两字符运算符 —— 如 `==`、`<=`、`&&` 等
     *   6. 三字符运算符 —— `===`、`!==`，必须在两字符匹配之后、单字符之前检测
     *      （因为 `==` 是 `===` 的前缀，先匹配两字符会把 `===` 错切成 `==` + `=`）
     *   7. 单字符 Token —— 兜底，所有未匹配的单字符运算符/分隔符
     *
     * 为什么箭头 `=>` 需要单独提前匹配：
     *   `=` 在单字符表中映射为 `ASSIGN` 类型，如果不在两字符扫描前拦截 `=>`，
     *   会先被 `=` 独立消费，导致后面孤立的 `>` 触发 `Unexpected character` 错误。
     *
     * @returns {Token} 识别出的 Token
     * @private
     */
    _readToken() {
        const ch = this.source[this.pos];

        // ── 数字 ──
        // 为什么前缀 `.` 也算数字：JavaScript 允许 .5 这样的写法（省略整数部分的 0.5）
        if (this._isDigit(ch) || (ch === '.' && this._isDigit(this.source[this.pos + 1]))) {
            return this._readNumber();
        }

        // ── 字符串 ──
        if (ch === '"' || ch === "'") {
            return this._readString(ch);
        }

        // ── 标识符或关键字 ──
        if (this._isIdentifierStart(ch)) {
            return this._readIdentifier();
        }

        // ── 箭头函数 => ──
        // 必须放在两字符运算符匹配之前检测，否则 `=` 会被单字符匹配消费
        if (ch === '=' && this.source[this.pos + 1] === '>') {
            const start = this.pos;
            const startCol = this.col;
            this.pos += 2;
            this.col += 2;
            return new Token(TokenType.ARROW, '=>', start, this.line, startCol);
        }

        // ── 两字符运算符 ──
        // 注意：`===` 和 `!==` 不在此表中优先匹配，而是在下方单独处理
        const twoChar = ch + this.source[this.pos + 1];
        const twoCharMap = {
            '==': TokenType.EQUAL,
            '!=': TokenType.NOT_EQUAL,
            '===': TokenType.STRICT_EQUAL,     // 兜底：如果下方三字符检测漏掉，这里也能命中
            '!==': TokenType.STRICT_NOT_EQUAL, // 同上
            '>=': TokenType.GREATER_EQUAL,
            '<=': TokenType.LESS_EQUAL,
            '&&': TokenType.AND,
            '||': TokenType.OR,
            '++': TokenType.INCREMENT,
            '--': TokenType.DECREMENT,
            '+=': TokenType.PLUS_ASSIGN,
            '-=': TokenType.MINUS_ASSIGN,
            '*=': TokenType.MULTIPLY_ASSIGN,
        };

        if (twoCharMap[twoChar]) {
            const start = this.pos;
            const startCol = this.col;
            this.pos += 2;
            this.col += 2;
            return new Token(twoCharMap[twoChar], twoChar, start, this.line, startCol);
        }

        // ── 三字符运算符 === 和 !== ──
        // 为什么必须在这里检测而不仅仅是放在 twoCharMap 中：
        //   twoCharMap 对 `==` 取子串时只消费 2 个字符，`===` 的第三个 `=` 会残留，
        //   导致下一轮错误地生成一个单独的 `=`（ASSIGN）Token。
        //   所以三字符运算符必须明确消费 3 个字符。
        if ((ch === '=' && this.source[this.pos + 1] === '=' && this.source[this.pos + 2] === '=') ||
                (ch === '!' && this.source[this.pos + 1] === '=' && this.source[this.pos + 2] === '=')) {
            const threeChar = ch + this.source[this.pos + 1] + this.source[this.pos + 2];
            const type = ch === '=' ? TokenType.STRICT_EQUAL : TokenType.STRICT_NOT_EQUAL;
            const start = this.pos;
            const startCol = this.col;
            this.pos += 3;
            this.col += 3;
            return new Token(type, threeChar, start, this.line, startCol);
        }

        // ── 单字符 Token ──
        return this._readSingleChar();
    }

    // ─── 数字读取 ───

    /**
     * 读取一个数字 Token
     *
     * 实现说明：
     *   - 目前仅支持十进制整数和小数（如 42、3.14、.5）
     *   - 不支持：十六进制（0xFF）、八进制（0o77）、二进制（0b11）、指数（1e5）、
     *     大整数（42n）、数字分隔符（1_000）
     *
     * 为什么分开处理整数部分和小数部分：
     *   `.` 既可以作为小数点（3.14），也可以是成员访问操作符（obj.prop）。
     *   `_readToken` 调用处已经通过看 `.` 后面是否跟数字来判断该进入数字读取还是单字符分支，
     *   进入 `_readNumber` 后，`'.'` 是确定的小数点，可以直接消费。
     *
     * value 为什么存 Number 而非字符串：
     *   Parser 后续需要做常量折叠、类型检查等操作，Number 形式可以直接参与运算，
     *   避免 Parser 侧再做一次 `parseFloat` / `Number()` 转换。
     *
     * @returns {Token} 类型为 NUMBER 的 Token，其 value 为 JavaScript Number 值
     * @private
     */
    _readNumber() {
        const start = this.pos;
        const startCol = this.col;
        let value = '';

        // 整数部分
        while (this.pos < this.source.length && this._isDigit(this.source[this.pos])) {
            value += this.source[this.pos];
            this._advance();
        }

        // 小数部分（仅当 `.` 后确实跟数字时才是小数）
        if (this.source[this.pos] === '.' && this._isDigit(this.source[this.pos + 1])) {
            value += '.';
            this._advance(); // 跳过 '.'
            while (this.pos < this.source.length && this._isDigit(this.source[this.pos])) {
                value += this.source[this.pos];
                this._advance();
            }
        }

        return new Token(TokenType.NUMBER, Number(value), start, this.line, startCol);
    }

    // ─── 字符串读取 ───

    /**
     * 读取一个由 `quote` 字符包裹的字符串 Token
     *
     * 支持的转义序列：
     *   `\n` → 换行, `\t` → Tab, `\r` → 回车, `\\` → 反斜杠,
     *   `\"` → 双引号, `\'` → 单引号
     *
     * 为什么用 escapeMap 映射表而不是 switch：
     *   escapeMap 是 O(1) 查表，比 switch/case 更紧凑且容易扩展（新增转义字符只需在表中增一项）。
     *   对于不在表中的转义字符，回退到原字符（如 `\a` 映射为 `a`），这与 JS 的宽松转义行为兼容。
     *
     * 为什么不支持模板字符串（`\``）：
     *   模板字符串涉及 `${}` 插值表达式，需要在 Parser 层面处理（表达式 vs 字符串的交替），
     *   Lexer 层面单独处理会使架构复杂化。此处暂时不实现模板字符串。
     *
     * @param {string} quote - 起始引号字符（`"` 或 `'`）
     * @returns {Token} 类型为 STRING 的 Token，value 为已转义的 JavaScript 字符串
     * @private
     */
    _readString(quote) {
        const start = this.pos;
        const startCol = this.col;
        this._advance(); // 跳过起始引号

        let value = '';
        while (this.pos < this.source.length && this.source[this.pos] !== quote) {
            if (this.source[this.pos] === '\\') {
                this._advance(); // 跳过反斜杠，下一字符是被转义的字符
                // 查表做转义映射，不在表内的原样保留（兼容未知转义序列）
                const escapeMap = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };
                value += escapeMap[this.source[this.pos]] || this.source[this.pos];
            } else {
                value += this.source[this.pos];
            }
            this._advance();
        }

        // 跳过闭合引号（如果在输入范围内）
        if (this.pos < this.source.length) {
            this._advance(); // 跳过闭合引号
        }

        return new Token(TokenType.STRING, value, start, this.line, startCol);
    }

    // ─── 标识符与关键字读取 ───

    /**
     * 读取一个标识符或关键字 Token
     *
     * 策略（两种常见做法的对比与选择）：
     *   方案 A：边读边查关键字表 —— 读入每个字符后检查当前前缀是否已无法匹配任何关键字，
     *          此时直接切换到 IDENTIFIER 模式快速读完剩余部分。
     *          优点：某些情况下可提前退出节省几轮循环。缺点：代码复杂度显著增加。
     *   方案 B（当前实现）：完整读取标识符后，查一次 KEYWORDS 表。
     *          优点：逻辑清晰，只需一次查表。缺点：理论上多读几个字符，但 JS 标识符通常很短，
     *          额外的循环开销可忽略不计。
     *
     * 为什么选择方案 B：
     *   可读性优先。词法分析器维护成本高于几纳秒的性能差异，方案 B 更便于后续添加新关键字。
     *
     * @returns {Token} 类型为对应关键字类型（如果匹配）或 IDENTIFIER 的 Token
     * @private
     */
    _readIdentifier() {
        const start = this.pos;
        const startCol = this.col;
        let value = '';

        while (this.pos < this.source.length && this._isIdentifierPart(this.source[this.pos])) {
            value += this.source[this.pos];
            this._advance();
        }

        // 查关键字表：关键字是标识符的真子集，读完后再判断身份
        const type = KEYWORDS[value] || TokenType.IDENTIFIER;
        return new Token(type, value, start, this.line, startCol);
    }

    // ─── 单字符 Token 读取 ───

    /**
     * 读取一个单字符的运算符或分隔符 Token
     *
     * 为什么遇到未识别的字符直接抛错而不是跳过：
     *   Lexer 不能“猜测”程序员的意图。遇到非法字符时抛出明确错误（含行列号），
     *   比静默跳过更能帮助定位问题。对于 `@`、`#`、反引号等 JS 中未定义的单字符场景，
     *   这是正确的报错行为。
     *
     * @returns {Token} 单字符运算符或分隔符 Token
     * @throws {Error} 当遇到无法识别的字符时抛出异常，包含行列信息
     * @private
     */
    _readSingleChar() {
        const ch = this.source[this.pos];
        const start = this.pos;
        const startCol = this.col;

        const singleMap = {
            '+': TokenType.PLUS,
            '-': TokenType.MINUS,
            '*': TokenType.MULTIPLY,
            '/': TokenType.DIVIDE,
            '%': TokenType.MODULO,
            '=': TokenType.ASSIGN,
            '>': TokenType.GREATER,
            '<': TokenType.LESS,
            '!': TokenType.NOT,
            '(': TokenType.LPAREN,
            ')': TokenType.RPAREN,
            '{': TokenType.LBRACE,
            '}': TokenType.RBRACE,
            '[': TokenType.LBRACKET,
            ']': TokenType.RBRACKET,
            ';': TokenType.SEMICOLON,
            ',': TokenType.COMMA,
            '.': TokenType.DOT,
            ':': TokenType.COLON,
            '?': TokenType.QUESTION,
        };

        const type = singleMap[ch];
        if (!type) {
            // 带行列号的错误消息，方便快速定位源码中的非法字符
            throw new Error(`Unexpected character '${ch}' at ${this.line}:${this.col}`);
        }

        this._advance();
        return new Token(type, ch, start, this.line, startCol);
    }

    // ─── 位置追踪辅助方法 ───

    /**
     * 前进一个字符，同时更新列号
     *
     * 为什么单独抽取为方法：
     *   位置追踪是 Lexer 中最容易出错的部分。将所有 pos++ 和 col++ 集中在一个方法中，
     *   确保每次字符消费时行列号同步更新，避免分散在多处的自增操作导致不一致。
     *
     * @private
     */
    _advance() {
        this.pos++;
        this.col++;
    }

    /**
     * 判断字符是否为十进制数字（0-9）
     *
     * @param {string} ch - 单个字符
     * @returns {boolean}
     * @private
     */
    _isDigit(ch) {
        return ch >= '0' && ch <= '9';
    }

    /**
     * 判断字符是否可以作为标识符的起始字符
     *
     * JS 规范允许的标识符首字符：
     *   字母（a-z, A-Z）、下划线 `_`、美元符号 `$`
     *
     * 为什么包含 `$`：
     *   这是 ECMAScript 规范要求，`$` 是合法标识符字符，广泛用于 jQuery、
     *   框架生成的变量名（如 Angular 的 `$scope`）等场景。
     *
     * @param {string} ch - 单个字符
     * @returns {boolean}
     * @private
     */
    _isIdentifierStart(ch) {
        return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
    }

    /**
     * 判断字符是否可以作为标识符的非首字符
     *
     * 标识符体中除了起始字符外，还允许数字。
     * 注意：此实现未涵盖规范中的 Unicode 字母（如中文、阿拉伯文等），
     * 如需支持完整 Unicode 标识符，应使用正则 `\p{ID_Start}` / `\p{ID_Continue}`。
     *
     * @param {string} ch - 单个字符
     * @returns {boolean}
     * @private
     */
    _isIdentifierPart(ch) {
        return this._isIdentifierStart(ch) || this._isDigit(ch);
    }

    // ─── Hook 辅助：Token 序列化 ───

    /**
     * 将 Token 对象序列化为纯数据对象，用于 hook 事件数据
     *
     * 为什么需要这个方法而不是直接传递 Token 实例：
     *   1. 防止循环引用 —— Token 对象在 hook 回调中可能被用户代码意外修改或扩展属性，
     *      序列化为纯对象后切断与内部状态的引用链条，避免内存泄漏和序列化死循环。
     *   2. 数据隔离 —— hook 回调拿到的是 Token 数据的快照（副本），即使回调中修改了
     *      该对象，也不会影响 Lexer 内部存储的原始 Token。
     *   3. 可序列化 —— 纯对象可以安全地通过 `JSON.stringify` 或结构化克隆传递，
     *      方便调试日志持久化和跨上下文传输。
     *
     * @param {Token} token - 内部 Token 实例
     * @returns {{type: string, value: *, pos: number, line: number, col: number}} 纯数据对象
     * @private
     */
    _serializeToken(token) {
        return { type: token.type, value: token.value, pos: token.pos, line: token.line, col: token.col };
    }
}
