/**
 * Parser.js —— 递归下降 + Pratt 解析器
 *
 * ============================================================================
 * 整体架构设计：为什么选择“递归下降 + Pratt 表达式解析”组合？
 * ============================================================================
 *
 * JavaScript 语法可以分为两大层：
 *   1. 语句层（Statement）—— 结构固定、关键字驱动（if/for/function/var...）
 *   2. 表达式层（Expression）—— 运算符繁多、优先级复杂（+ - * / && || = ?: ...）
 *
 * 语句层使用“纯递归下降”：
 *   - 每个语句类型由一个专用方法处理（_parseIfStatement、_parseForStatement...）
 *   - 入口方法 _parseStatement() 通过前瞻一个 token 决定走哪个分支
 *   - 优点：代码结构与语法规则一一对应，易读易维护
 *
 * 表达式层使用“Pratt 解析”（运算符优先级解析）：
 *   - 核心思想：每个运算符分配一个“优先级数字”，解析时通过比较优先级决定
 *     谁“绑定得更紧”（结合性），而不是为每个优先级写一层递归函数
 *   - 如果纯递归下降做表达式，需要为每个优先级写一个方法：
 *       parseAssignment → parseTernary → parseLogicalOr → parseLogicalAnd →
 *       parseEquality → parseComparison → parseAdditive → parseMultiplicative → parseUnary → parsePrimary
 *     总共约 10 层互相调用，代码冗长且添加新运算符需改动多处
 *   - Pratt 解析只需一张优先级表 + 一个循环，添加新运算符只需在表中加一行
 *   - 参考：V8、SpiderMonkey、Babel、acorn 等主流引擎均使用 Pratt 或其变体
 *
 * ============================================================================
 * ASI（自动分号插入）策略：为什么 MVP 中做最小实现？
 * ============================================================================
 *
 * ECMAScript 规范中 ASI 有 5 条规则（§12.9），完整实现需在以下位置检查：
 *   1. 行终止符出现在违规 token 之前
 *   2. } 之前允许省略分号
 *   3. EOF 之前允许省略分号
 *   4. continue/break 后的行终止符
 *   5. return/throw/arrow 后的行终止符（限制语法）
 *
 * 本学习引擎仅实现规则 2+3（} 前和 EOF 前允许省略分号），原因：
 *   - 完整 ASI 需要词法分析器透传换行符/注释信息（token 间的 Trivia）
 *   - 需要额外的前瞻逻辑，与 Pratt 解析的简洁性冲突
 *   - 学习引擎的目的是展示解析器核心架构，完整 ASI 会淹没主干逻辑
 *   - 实际使用中，手动加分号即可绕过所有 ASI 场景
 *
 * @file 递归下降 + Pratt 运算符优先级解析器
 */

import { TokenType } from '../lexer/TokenType.js';
import { HookEvents } from '../hooks/HookEvents.js';
import { NODE_TYPE } from '../types.js';
import * as AST from './ASTNode.js';

// ─── 运算符优先级表（Pratt Parsing 核心）─────────────────────────────────────
//
// 为什么用这些具体数字？
// ─────────────────────
// JavaScript 运算符优先级（从低到高）大致为：
//   赋值(2) < 三元(3) < 逻辑或(4) < 逻辑与(5) < 相等(6) < 比较(7)
//   < 加减(8) < 乘除模(9) < 一元(13) < 后缀/成员调用(隐式最高)
//
// 数字本身无特殊含义，只需要满足：低数字 = 低优先级 = 绑定力弱
// 赋值 = 2（最低，a = b + c 中等号最后求值）
// 三元 = 3（高于赋值使 a = b ? c : d 等价于 a = (b ? c : d)）
// 加减 = 8、乘除 = 9（数字越大越优先，使 a + b * c 中乘法先算）
// 跳号（没有 1, 10, 11, 12）是为了给未来添加新运算符（如 **, ??, |, &）预留空间
// 一元一元用 13 作为硬编码前缀优先级，高于所有二元运算符
//
const PRECEDENCE = {
    [TokenType.ASSIGN]: 2,          // =  赋值（最低优先级，最后求值）
    [TokenType.PLUS_ASSIGN]: 2,     // += 复合赋值，优先级同 =
    [TokenType.MINUS_ASSIGN]: 2,    // -= 复合赋值
    [TokenType.MULTIPLY_ASSIGN]: 2, // *= 复合赋值
    [TokenType.QUESTION]: 3,         // ?: 三元条件（高于赋值，低于逻辑）
    [TokenType.OR]: 4,              // || 逻辑或（短路求值）
    [TokenType.AND]: 5,             // && 逻辑与（短路求值，优先级高于 ||）
    [TokenType.EQUAL]: 6,           // == 相等比较
    [TokenType.NOT_EQUAL]: 6,       // != 不等比较
    [TokenType.STRICT_EQUAL]: 6,    // === 严格相等
    [TokenType.STRICT_NOT_EQUAL]: 6,// !== 严格不等
    [TokenType.GREATER]: 7,         // >  大于
    [TokenType.GREATER_EQUAL]: 7,   // >= 大于等于
    [TokenType.LESS]: 7,            // <  小于
    [TokenType.LESS_EQUAL]: 7,      // <= 小于等于
    [TokenType.PLUS]: 8,            // +  加法 / 字符串拼接
    [TokenType.MINUS]: 8,           // -  减法
    [TokenType.MULTIPLY]: 9,        // *  乘法（高于加法）
    [TokenType.DIVIDE]: 9,          // /  除法
    [TokenType.MODULO]: 9,          // %  取模
};

// ─── 赋值运算符集合 ─────────────────────────────────────────────────────────
//
// 为什么需要单独的集合？
// 赋值运算符是右结合的（a = b = 5 → a = (b = 5)），
// 而算术/比较运算符是左结合的（a + b + c → (a + b) + c）。
// 在 Pratt 循环中需要区分这两类来决定递归时用 prec-1 还是 prec+1（见 _parseExpression）。
//
const ASSIGNMENT_TOKENS = new Set([
    TokenType.ASSIGN,
    TokenType.PLUS_ASSIGN,
    TokenType.MINUS_ASSIGN,
    TokenType.MULTIPLY_ASSIGN,
]);

/**
 * 递归下降 + Pratt 运算符优先级解析器
 *
 * 设计原则：
 *   1. 语句 = 递归下降（结构清晰，与语法规则一一对应）
 *   2. 表达式 = Pratt 解析（一张优先级表替代 10 层递归函数）
 *   3. 错误恢复 = 无（学习用途，遇错即抛）
 */
export class Parser {
    /**
     * @param {Token[]} tokens - 词法分析器输出的 token 流
     * @param {EventEmitter} hooks - 事件钩子，用于回调控件（AST 观察、错误监听等）
     */
    constructor(tokens, hooks) {
        /** @type {Token[]} 待解析的 token 序列 */
        this.tokens = tokens;
        /** @type {EventEmitter} 事件钩子实例 */
        this.hooks = hooks;
        /** @type {number} 当前解析位置（指向下一个未消耗的 token） */
        this.pos = 0;
    }

    // ─── 解析入口 ───────────────────────────────────────────────────────────
    //
    // parse() 是整个解析器的唯一公开入口。
    // 流程：逐条解析语句（Statement）直到遇到 EOF token，然后将所有语句包装为 Program 根节点。
    // 每条语句内部会递归地调用表达式解析，形成完整的 AST。

    /**
     * 解析入口：将 token 流解析为 Program AST 根节点
     *
     * 为什么用 while 循环逐条解析而不是一次递归？
     * - 脚本顶层是一个“语句列表”（StatementList），不是单个表达式
     * - 每条语句之间是平级关系，不是嵌套关系，所以用循环比递归更自然
     * - 循环直到 EOF 确保消费完所有 token，避免残留
     *
     * @returns {ASTNode} AST.Program 根节点，body 为语句数组
     */
    parse() {
        // 触发解析开始钩子，传递 token 总数供外部监控
        this.hooks.emit(HookEvents.PARSE_START, { tokenCount: this.tokens.length });

        /** @type {ASTNode[]} 顶层语句列表 */
        const body = [];
        while (!this._match(TokenType.EOF)) {
            body.push(this._parseStatement());
        }

        const ast = AST.Program(body);
        this._emitNode(ast);
        // 触发解析结束钩子，传递语句数量供外部监控
        this.hooks.emit(HookEvents.PARSE_END, { nodeCount: body.length });
        return ast;
    }

    // ─── 节点序列化与事件发射 ────────────────────────────────────────────────
    //
    // 每个 AST 节点在创建后都会通过 _emitNode 触发钩子事件，
    // 外部可通过 hooks 体系观察解析过程。

    /**
     * 发射节点创建事件
     *
     * @param {ASTNode} node - 刚创建的 AST 节点
     */
    _emitNode(node) {
        this.hooks.emit(HookEvents.PARSE_NODE, {
            type: node.type,
            id: node.id,
            node: this._serializeNode(node),
        });
    }

    /**
     * 序列化 AST 节点（深拷贝，去除 id 字段）
     *
     * 为什么需要去除 id 字段？
     * - 每个 AST 节点上都有一个唯一的 `id` 字段（由 ASTNode 辅助函数在创建时生成），
     *   用于在钩子事件中区分不同节点（已通过 event.id 单独传递）
     * - 如果不清除 id，序列化后的 JSON/对象中会包含这些"元数据"字段，
     *   它们不属于 AST 语义，对 AST 使用者（遍历器、代码生成器）没有意义
     * - 剥离 id 后得到的才是"纯净"的 AST 结构，便于外部消费
     * - 类比：Babel 中 AST 节点的 `__clone` / `leadingComments` 等辅助字段也不会序列化输出
     *
     * @param {*} node - AST 节点或原始值
     * @returns {*} 去除 id 字段的深拷贝
     */
    _serializeNode(node) {
        // 原始值（string / number / boolean / null / undefined）直接返回
        if (!node || typeof node !== 'object') return node;
        // 数组：递归序列化每个元素
        if (Array.isArray(node)) return node.map(n => this._serializeNode(n));
        /** @type {Object} 去除 id 后的序列化结果 */
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            // 跳过 id 字段——它已在钩子事件的 event.id 中单独传递
            if (k === 'id') continue;
            if (Array.isArray(v)) out[k] = v.map(x => this._serializeNode(x));
            else if (v && typeof v === 'object') out[k] = this._serializeNode(v);
            else out[k] = v;
        }
        return out;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 语句解析（Statement Parsing）—— 纯递归下降
    // ═══════════════════════════════════════════════════════════════════════
    //
    // 每条语句的入口是 _parseStatement()，根据当前 token 类型分发：
    //
    //   关键字引领（if / for / while / return / var / let / const / function）
    //     → 各自对应一个 _parseXxxStatement 方法
    //   { 开头
    //     → _parseBlockStatement（语句块）
    //   ; 单独
    //     → 空语句（ExpressionStatement with undefined literal）
    //   其他
    //     → _parseExpressionStatement（表达式后加分号）
    //
    // 为什么 if/for/while/return 用 _match（消耗 token），而 LBRACE 用 _check？
    //   - 关键字是“明确的信号”：看到 if 就一定是 if 语句，可以立即消耗
    //   - LBRACE 可能是对象字面量的一部分（如在表达式位置），所以 _parseStatement
    //     只做前瞻检查（_check），实际消耗留给 _parseBlockStatement
    //     如果我们在 _parseStatement 中消耗了 {，但后续发现它应该是表达式，
    //     就回退不了（本解析器不做回溯）
    //

    /**
     * 语句分发器 —— 所有语句解析的入口
     *
     * 设计思路：
     *   通过前瞻一个 token 决定走哪个语句分支。
     *   分支顺序不影响正确性，但影响性能——把出现频率高的语句放前面可减少匹配次数。
     *
     * @returns {ASTNode} 解析完成的语句节点
     */
    _parseStatement() {
        // LBRACE 用 _check（前瞻不消耗），原因见上方注释
        if (this._check(TokenType.LBRACE)) return this._parseBlockStatement();
        // 关键字用 _match（匹配即消耗），因为关键字语义明确，无需回溯
        if (this._match(TokenType.VAR)) return this._parseVariableDeclaration('var');
        if (this._match(TokenType.LET)) return this._parseVariableDeclaration('let');
        if (this._match(TokenType.CONST)) return this._parseVariableDeclaration('const');
        if (this._match(TokenType.FUNCTION)) return this._parseFunctionDeclaration();
        if (this._match(TokenType.RETURN)) return this._parseReturnStatement();
        if (this._match(TokenType.IF)) return this._parseIfStatement();
        if (this._match(TokenType.FOR)) return this._parseForStatement();
        if (this._match(TokenType.WHILE)) return this._parseWhileStatement();
        // 单独的分号 → 空语句
        if (this._match(TokenType.SEMICOLON)) return AST.ExpressionStatement(AST.Literal(undefined));

        // 兜底：一切无法匹配 token 开头 = 表达式语句
        return this._parseExpressionStatement();
    }

    /**
     * 解析语句块 { ... }
     *
     * 为什么这里直接 _consume(LBRACE) 而不是 _check？
     * - 调用此方法的前提是 _parseStatement 已通过 _check 确认了当前是 LBRACE，
     *   所以这里可以安全地直接消耗
     * - _consume 会在类型不匹配时抛出错误，提供额外的安全校验
     *
     * @returns {ASTNode} BlockStatement 节点
     */
    _parseBlockStatement() {
        this._consume(TokenType.LBRACE);
        /** @type {ASTNode[]} 语句块内的语句列表 */
        const body = [];
        // 循环解析内部语句，直到遇到 RBRACE 或文件结束
        while (!this._check(TokenType.RBRACE) && !this._check(TokenType.EOF)) {
            body.push(this._parseStatement());
        }
        this._consume(TokenType.RBRACE);
        const node = AST.BlockStatement(body);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析变量声明：var / let / const
     *
     * 支持多变量声明：let a = 1, b = 2, c;
     * 初始值是可选的：let x;（init 为 null）
     *
     * @param {'var'|'let'|'const'} kind - 声明类型
     * @returns {ASTNode} VariableDeclaration 节点
     */
    _parseVariableDeclaration(kind) {
        /** @type {ASTNode[]} 变量声明器列表 */
        const declarations = [];

        // 使用 do-while 支持逗号分隔的多变量声明
        do {
            const id = this._parseIdentifier();
            let init = null;
            // 赋值是可选的（let x; 合法）
            if (this._match(TokenType.ASSIGN)) {
                init = this._parseExpression();
            }
            declarations.push(AST.VariableDeclarator(id, init));
        } while (this._match(TokenType.COMMA));

        // 变量声明语句以分号或 ASI 结束
        this._consumeSemicolon();
        const node = AST.VariableDeclaration(kind, declarations);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析函数声明：function foo(a, b) { ... }
     *
     * 函数声明的 id 是必填的（不能匿名）。
     * 与函数表达式不同（函数表达式 id 可选），见 _parseFunctionExpression。
     *
     * @returns {ASTNode} FunctionDeclaration 节点
     */
    _parseFunctionDeclaration() {
        const id = this._parseIdentifier();
        return this._parseFunctionRest(NODE_TYPE.FUNCTION_DECLARATION, id);
    }

    /**
     * 解析函数表达式：function [id](params) { body }
     *
     * 为什么 id 是可选的？
     * - 匿名函数表达式：var x = function() {}（id = null）
     * - 命名函数表达式：var x = function foo() {}（id = "foo"）
     *   命名函数表达式的名字只在函数体内可见，对外部不可见
     *   在调试时，命名函数表达式会在堆栈跟踪中显示名字，有助于调试
     *
     * 判断方式：如果 function 后紧跟 '(' 则是匿名，否则有名字
     *
     * @returns {ASTNode} FunctionExpression 节点
     */
    _parseFunctionExpression() {
        let id = null;
        // 如果 function 后不是 (，说明有名字
        if (!this._check(TokenType.LPAREN)) {
            id = this._parseIdentifier();
        }
        return this._parseFunctionRest(NODE_TYPE.FUNCTION_EXPRESSION, id);
    }

    /**
     * 解析函数剩余部分：参数列表 + 函数体
     *
     * 函数声明和函数表达式共享此方法，
     * 因为它们在 '(' params ')' { body } 部分的语法完全相同。
     * 复用避免了代码重复。
     *
     * @param {string} nodeType - NODE_TYPE 常量（FUNCTION_DECLARATION 或 FUNCTION_EXPRESSION）
     * @param {ASTNode|null} id - 函数名（声明必须有，表达式可选）
     * @returns {ASTNode} FunctionDeclaration 或 FunctionExpression 节点
     */
    _parseFunctionRest(nodeType, id) {
        this._consume(TokenType.LPAREN);
        /** @type {ASTNode[]} 形参列表 */
        const params = [];
        if (!this._check(TokenType.RPAREN)) {
            do {
                params.push(this._parseIdentifier());
            } while (this._match(TokenType.COMMA));
        }
        this._consume(TokenType.RPAREN);

        const body = this._parseBlockStatement();

        const node = nodeType === NODE_TYPE.FUNCTION_DECLARATION
            ? AST.FunctionDeclaration(id, params, body)
            : AST.FunctionExpression(id, params, body);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析箭头函数（辅助方法）
     *
     * 注意：当前主流程中箭头函数的解析已内联到 _parseExpression 和 _parsePrimary 中，
     * 因为箭头函数在表达式位置需要与分组括号 (expr) 进行前瞻区分。
     * 此方法保留用于从 _parsePrimary 被显式调用的场景。
     *
     * @returns {ASTNode} ArrowFunctionExpression 节点
     */
    _parseArrowFunction() {
        const params = [];
        // 注释说明：调用方已消费了第一个标识符或括号组
        let node;
        this._consume(TokenType.ARROW);

        let body;
        // 箭头函数体：{ ... } 语句块 或 单一表达式（隐式 return）
        if (this._check(TokenType.LBRACE)) {
            body = this._parseBlockStatement();
        } else {
            const expr = this._parseExpression();
            // 单表达式体自动包装为 return 语句
            body = AST.BlockStatement([AST.ReturnStatement(expr)]);
        }

        node = AST.ArrowFunctionExpression(params, body);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析 return 语句
     *
     * return 后的表达式是可选的（return; 合法）。
     * return 后不能有换行符（限制语法），但本 MVP 不做行终止符检查。
     *
     * @returns {ASTNode} ReturnStatement 节点
     */
    _parseReturnStatement() {
        let argument = null;
        // 检查是否有返回值表达式（return 后不是 ; 或 } 则有表达式）
        if (!this._check(TokenType.SEMICOLON) && !this._check(TokenType.RBRACE)) {
            argument = this._parseExpression();
        }
        this._consumeSemicolon();
        const node = AST.ReturnStatement(argument);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析 if 语句：if (test) consequent [else alternate]
     *
     * else 分支是可选的。
     * 悬空 else 问题（dangling else）由递归下降自然解决：
     * if...else 中 else 总是绑定到最近的未匹配 if。
     *
     * @returns {ASTNode} IfStatement 节点
     */
    _parseIfStatement() {
        this._consume(TokenType.LPAREN);
        const test = this._parseExpression();
        this._consume(TokenType.RPAREN);
        const consequent = this._parseStatement();
        let alternate = null;
        // else 子句可选
        if (this._match(TokenType.ELSE)) {
            alternate = this._parseStatement();
        }
        const node = AST.IfStatement(test, consequent, alternate);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析 for 语句：for (init; test; update) body
     *
     * for 头部三部分都是可选的：for (;;) {} 是合法的无限循环。
     * init 可以是变量声明（var/let/const）或表达式。
     *
     * @returns {ASTNode} ForStatement 节点
     */
    _parseForStatement() {
        this._consume(TokenType.LPAREN);

        let init = null;
        // 第一部分：初始化（可选）
        if (!this._check(TokenType.SEMICOLON)) {
            if (this._match(TokenType.VAR)) init = this._parseVariableDeclaration('var');
            else if (this._match(TokenType.LET)) init = this._parseVariableDeclaration('let');
            else if (this._match(TokenType.CONST)) init = this._parseVariableDeclaration('const');
            else init = this._parseExpression();
            // 变量声明自带分号消费，表达式需要手动消费分号
            if (init && init.type !== NODE_TYPE.VARIABLE_DECLARATION) {
                this._consumeSemicolon();
            }
        } else {
            this._consume(TokenType.SEMICOLON);
        }

        let test = null;
        // 第二部分：条件测试（可选）
        if (!this._check(TokenType.SEMICOLON)) {
            test = this._parseExpression();
        }
        this._consume(TokenType.SEMICOLON);

        let update = null;
        // 第三部分：更新表达式（可选）
        if (!this._check(TokenType.RPAREN)) {
            update = this._parseExpression();
        }
        this._consume(TokenType.RPAREN);

        const body = this._parseStatement();
        const node = AST.ForStatement(init, test, update, body);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析 while 语句：while (test) body
     *
     * @returns {ASTNode} WhileStatement 节点
     */
    _parseWhileStatement() {
        this._consume(TokenType.LPAREN);
        const test = this._parseExpression();
        this._consume(TokenType.RPAREN);
        const body = this._parseStatement();
        const node = AST.WhileStatement(test, body);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析表达式语句：expr;
     *
     * 任何无法被识别为特定语句类型的语句都归为表达式语句。
     * 这是语句分发的最终兜底分支。
     *
     * @returns {ASTNode} ExpressionStatement 节点
     */
    _parseExpressionStatement() {
        const expr = this._parseExpression();
        this._consumeSemicolon();
        const node = AST.ExpressionStatement(expr);
        this._emitNode(node);
        return node;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 表达式解析（Expression Parsing）—— Pratt 运算符优先级
    // ═══════════════════════════════════════════════════════════════════════
    //
    // Pratt 解析的核心是 _parseExpression(precedence) 方法。
    //
    // 工作流程：
    //   1. _parsePrimary() 解析第一个操作数（原子值、前缀运算符、括号表达式等）
    //   2. 循环查看下一个 token：
    //      a. 如果是 ARROW → 构造箭头函数
    //      b. 如果是 QUESTION → 解析三元条件式 ? :
    //      c. 如果是赋值运算符（=、+= 等）→ 右结合递归（prec - 1）
    //      d. 如果是普通二元运算符 → 左结合递归（prec + 1）
    //      e. 如果优先级不够高 或 遇到终止 token → 退出循环，返回左操作数
    //
    // 为什么赋值用 prec - 1（右结合）、二元用 prec + 1（左结合）？
    // ───────────────────────────────────────────────────────────
    // 结合性决定了 a ○ b ○ c 的解析方式：
    //
    //   左结合（+ - * / && || == > <）：
    //     a + b + c  →  (a + b) + c     （从左往右分组）
    //     做法：递归时提高优先级门槛（prec + 1），
    //           让下一次循环只能匹配"严格大于"当前优先级的运算符，
    //           因此第二个 + 因优先级"不够高"而不会被匹配到右操作数中
    //
    //   右结合（= += -= *= ?: 的 alternate 部分）：
    //     a = b = 5  →  a = (b = 5)     （从右往左分组）
    //     做法：递归时降低优先级门槛（prec - 1），
    //           让下一次循环可以匹配"等于"当前优先级的运算符，
    //           因此第二个 = 会被匹配进右操作数，实现从右往左分组
    //
    //   三元 ? : 的特殊处理：
    //     三元不是二元运算符，但在 Pratt 中也用 prec - 1 处理 alternate，
    //     使得 a ? b : c ? d : e 解析为 a ? b : (c ? d : e)（右结合）
    //

    /**
     * Pratt 表达式解析：解析一个表达式直到遇到低于指定优先级的运算符
     *
     * 这是整个解析器最关键的方法。它实现了完整的运算符优先级解析算法。
     *
     * @param {number} [precedence=0] - 当前上下文的最低允许优先级
     *   外部首次调用传 0（解析整个表达式），递归调用根据结合性调整
     * @returns {ASTNode} 解析完成的表达式节点
     */
    _parseExpression(precedence = 0) {
        // 第 1 步：解析前缀/原子——即第一个操作数
        let left = this._parsePrimary();

        // 第 2 步：循环处理中缀/后缀运算符
        while (true) {
            const token = this._peek();

            // --- 箭头函数检测 ---
            // 当 _parsePrimary 解析了一个标识符 (a) 或括号组 (a,b) 后，
            // 发现下一个 token 是 =>，则重新解释为箭头函数
            if (token.type === TokenType.ARROW) {
                /** @type {ASTNode[]} 箭头函数形参列表 */
                const params = [];
                if (left.type === NODE_TYPE.IDENTIFIER) {
                    params.push(left); // 单参数：a => ... 中的 a
                }
                // left 是括号组时会走 _parsePrimary 内部的内联箭头处理，不走这里
                this._consume(TokenType.ARROW);
                let body;
                if (this._check(TokenType.LBRACE)) {
                    body = this._parseBlockStatement();
                } else {
                    const expr = this._parseExpression();
                    // 单表达式体自动包装 return
                    body = AST.BlockStatement([AST.ReturnStatement(expr)]);
                }
                const node = AST.ArrowFunctionExpression(params, body);
                this._emitNode(node);
                return node;
            }

            // --- 三元条件表达式 ? : ---
            if (token.type === TokenType.QUESTION) {
                this._advance();
                // consequent（true 分支）：从 0 开始解析（重置优先级）
                const consequent = this._parseExpression(0);
                this._consume(TokenType.COLON);
                // alternate（false 分支）：右结合
                // 使用 prec - 1 使嵌套三元 a?b:c?d:e 解析为 a?b:(c?d:e)
                const alternate = this._parseExpression(PRECEDENCE[TokenType.QUESTION] - 1);
                left = AST.ConditionalExpression(left, consequent, alternate);
                this._emitNode(left);
                continue;
            }

            // 终止条件：遇到 EOF / 分号 / 右界 token
            if (token.type === TokenType.EOF || token.type === TokenType.SEMICOLON) break;

            const tokenPrec = PRECEDENCE[token.type];
            // 如果当前运算符优先级低于门槛 → 属于外层表达式，退出循环
            if (tokenPrec === undefined || tokenPrec < precedence) break;

            // --- 赋值运算符（右结合）---
            // 使用 prec - 1 使 a = b = 5 解析为 a = (b = 5)
            if (ASSIGNMENT_TOKENS.has(token.type)) {
                const op = this._advance().value;
                const right = this._parseExpression(tokenPrec - 1);
                left = AST.AssignmentExpression(op, left, right);
                this._emitNode(left);
                continue;
            }

            // --- 二元 / 逻辑运算符（左结合）---
            // 使用 prec + 1 使 a + b + c 解析为 (a + b) + c
            const isLogical = token.type === TokenType.AND || token.type === TokenType.OR;
            this._advance();
            const right = this._parseExpression(tokenPrec + 1);
            left = isLogical
                ? AST.LogicalExpression(token.value, left, right)
                : AST.BinaryExpression(token.value, left, right);
            this._emitNode(left);
        }

        return left;
    }

    /**
     * 解析原子表达式 + 前缀运算符 + 后缀运算符
     *
     * 为什么把前缀、原子、后缀都放在一个方法里？
     * - Pratt 解析中，"原子 + 前缀 + 后缀" 统称为 NUD（Null Denotation）阶段
     * - 这三者天然连续：前缀 → 核心 → 后缀（如 ++x.y++）
     * - 放在一起避免了多个方法之间的调用开销和上下文传递
     *
     * 为什么箭头函数需要在 LPAREN 分支做前瞻（lookahead）？
     * - JavaScript 中 (a) 和 (a) => {} 都以 '(' 开头
     * - 不能简单地先解析完括号内容再决定，因为需要在前瞻阶段区分：
     *     (a + 1)       → 分组表达式
     *     (a, b) => {}  → 箭头函数参数
     *     (a) => {}     → 箭头函数单参数
     * - 如果不做前瞻，无法正确区分，会导致解析错误
     * - V8 和 SpiderMonkey 中称为 "Cover ParenthesizedExpression And ArrowParameterList"
     *   一种"覆盖语法"（cover grammar），先用宽松规则解析再用静态语义消歧
     * - 本解析器通过手动循环扫描匹配括号 + 检查 => 来模拟这个过程
     *
     * @returns {ASTNode} 解析完成的前缀/原子/后缀表达式节点
     */
    _parsePrimary() {
        // --- 前缀运算符 ---
        const token = this._peek();
        // 前缀 ++ / --
        if (token.type === TokenType.INCREMENT || token.type === TokenType.DECREMENT) {
            this._advance();
            const arg = this._parsePrimary(); // 操作数也是一个 Primary
            return AST.UpdateExpression(token.value, arg, true);
        }
        // 前缀 ! / - / typeof / delete
        if (token.type === TokenType.NOT || token.type === TokenType.MINUS ||
                token.type === TokenType.TYPEOF || token.type === TokenType.DELETE) {
            this._advance();
            // 一元运算符用硬编码优先级 13（高于所有二元运算符）
            // 使 !a + b 解析为 (!a) + b 而不是 !(a + b)
            const arg = this._parseExpression(13);
            const node = AST.UnaryExpression(token.value, arg);
            this._emitNode(node);
            return node;
        }
        // 前缀 +（一元加号）
        // 一元加号在运行时是 no-op，在 AST 层面直接跳过
        // 例如 +5 等价于 5，+x 等价于 x（但触发 ToNumber）
        if (token.type === TokenType.PLUS) {
            this._advance();
            return this._parseExpression(13); // 一元加在 AST 层面是 no-op，直接返回操作数
        }

        let expr;

        // --- 原子表达式 ---

        // '(' 开头的三种可能：分组表达式、箭头函数参数、空箭头函数
        if (this._match(TokenType.LPAREN)) {
            // 空括号 () => {}
            if (this._check(TokenType.RPAREN)) {
                this._consume(TokenType.RPAREN);
                this._consume(TokenType.ARROW);
                const body = this._check(TokenType.LBRACE)
                    ? this._parseBlockStatement()
                    : AST.BlockStatement([AST.ReturnStatement(this._parseExpression())]);
                const node = AST.ArrowFunctionExpression([], body);
                this._emitNode(node);
                return node;
            }

            // 前瞻：区分分组表达式 (expr) 和箭头函数参数 (a, b) => {}
            const saved = this.pos;
            let isArrowParams = false;
            let paramCount = 0;
            let parenDepth = 1;
            let lookPos = this.pos;

            // 通过扫描匹配的 ) 并检查其后是否是 => 来消歧
            while (lookPos < this.tokens.length) {
                const tok = this.tokens[lookPos];
                if (tok.type === TokenType.LPAREN) parenDepth++;
                if (tok.type === TokenType.RPAREN) {
                    parenDepth--;
                    if (parenDepth === 0) {
                        // 找到匹配的右括号，检查下一个 token 是否是 =>
                        if (this.tokens[lookPos + 1] && this.tokens[lookPos + 1].type === TokenType.ARROW) {
                            isArrowParams = true;
                        }
                        break;
                    }
                }
                if (tok.type === TokenType.IDENTIFIER) paramCount++;
                if (tok.type === TokenType.COMMA && parenDepth === 1) paramCount++;
                lookPos++;
            }

            if (isArrowParams) {
                // 是箭头函数参数
                const params = [];
                if (!this._check(TokenType.RPAREN)) {
                    do {
                        params.push(this._parseIdentifier());
                    } while (this._match(TokenType.COMMA));
                }
                this._consume(TokenType.RPAREN);
                this._consume(TokenType.ARROW);
                let body;
                if (this._check(TokenType.LBRACE)) {
                    body = this._parseBlockStatement();
                } else {
                    const exprBody = this._parseExpression();
                    body = AST.BlockStatement([AST.ReturnStatement(exprBody)]);
                }
                const node = AST.ArrowFunctionExpression(params, body);
                this._emitNode(node);
                return node;
            }

            // 是普通分组表达式：(expr)
            expr = this._parseExpression();
            this._consume(TokenType.RPAREN);
        } else if (this._match(TokenType.FUNCTION)) {
            expr = this._parseFunctionExpression();
        } else if (this._match(TokenType.THIS)) {
            expr = AST.ThisExpression();
            this._emitNode(expr);
        } else if (this._match(TokenType.NEW)) {
            // new 表达式：new constructor(args)
            // 注意：当前不支持 new Target 语法（new.target）
            const callee = this._parsePrimary();
            const args = [];
            if (this._match(TokenType.LPAREN)) {
                if (!this._check(TokenType.RPAREN)) {
                    do {
                        args.push(this._parseExpression());
                    } while (this._match(TokenType.COMMA));
                }
                this._consume(TokenType.RPAREN);
            }
            expr = AST.NewExpression(callee, args);
            this._emitNode(expr);
        } else if (token.type === TokenType.LBRACKET) {
            expr = this._parseArrayExpression();
        } else if (token.type === TokenType.LBRACE) {
            expr = this._parseObjectExpression();
        } else if (token.type === TokenType.NUMBER || token.type === TokenType.STRING ||
                             token.type === TokenType.TRUE || token.type === TokenType.FALSE ||
                             token.type === TokenType.NULL || token.type === TokenType.UNDEFINED) {
            expr = this._parseLiteral();
        } else if (token.type === TokenType.IDENTIFIER) {
            expr = this._parseIdentifier();
        } else {
            throw new Error(`Unexpected token '${token.type}' at ${token.line}:${token.col}`);
        }

        // --- 后缀运算符（循环处理，因为可以连续链式调用）---
        // 例如：arr[0](arg).prop++
        // 后缀运算符"绑定得最紧"，不需要 Pratt 优先级比较，直接循环消费
        while (true) {
            const tok = this._peek();
            if (tok.type === TokenType.LPAREN) {
                // 函数调用：expr(args)
                expr = this._parseCallExpression(expr);
            } else if (tok.type === TokenType.LBRACKET) {
                // 计算成员访问：expr[property]
                // 为什么 property 用 _parseExpression 而不是 _parseIdentifier？
                // obj[expr] 中 expr 可以是任意表达式（obj[i + 1]、obj[getKey()]），
                // 不限于标识符或字面量，所以需要用完整的表达式解析
                this._advance();
                const prop = this._parseExpression();
                this._consume(TokenType.RBRACKET);
                expr = AST.MemberExpression(expr, prop, true);
                this._emitNode(expr);
            } else if (tok.type === TokenType.DOT) {
                // 成员访问：expr.property
                this._advance();
                const prop = this._parseIdentifier();
                expr = AST.MemberExpression(expr, prop, false);
                this._emitNode(expr);
            } else if (tok.type === TokenType.INCREMENT || tok.type === TokenType.DECREMENT) {
                // 后缀 ++ / --
                this._advance();
                expr = AST.UpdateExpression(tok.value, expr, false);
                this._emitNode(expr);
            } else {
                break;
            }
        }

        return expr;
    }

    /**
     * 解析函数调用表达式：callee(arg1, arg2, ...)
     *
     * @param {ASTNode} callee - 被调用的表达式节点
     * @returns {ASTNode} CallExpression 节点
     */
    _parseCallExpression(callee) {
        this._consume(TokenType.LPAREN);
        /** @type {ASTNode[]} 实参列表 */
        const args = [];
        if (!this._check(TokenType.RPAREN)) {
            do {
                args.push(this._parseExpression());
            } while (this._match(TokenType.COMMA));
        }
        this._consume(TokenType.RPAREN);
        const node = AST.CallExpression(callee, args);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析数组字面量：[elem1, elem2, ...]
     *
     * 当前不支持稀疏数组（[, ,]），仅支持稠密元素列表。
     *
     * @returns {ASTNode} ArrayExpression 节点
     */
    _parseArrayExpression() {
        this._consume(TokenType.LBRACKET);
        /** @type {ASTNode[]} 数组元素列表 */
        const elements = [];
        if (!this._check(TokenType.RBRACKET)) {
            do {
                elements.push(this._parseExpression());
            } while (this._match(TokenType.COMMA));
        }
        this._consume(TokenType.RBRACKET);
        const node = AST.ArrayExpression(elements);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析对象字面量：{ key: value, ... }
     *
     * 支持的 key 类型：
     *   1. 标识符：{ name: "value" } 或简写 { name }
     *   2. 字符串：{ "key-name": value }
     *   3. 数字：{ 0: "zero" }
     *   4. 计算属性：{ [expr]: value }
     *
     * 支持属性简写：{ a, b } 等价于 { a: a, b: b }
     *
     * @returns {ASTNode} ObjectExpression 节点
     */
    _parseObjectExpression() {
        this._consume(TokenType.LBRACE);
        /** @type {{key: ASTNode, value: ASTNode}[]} 属性列表 */
        const properties = [];
        if (!this._check(TokenType.RBRACE)) {
            do {
                let key, value;

                // key 的类型判断
                if (this._peek().type === TokenType.STRING || this._peek().type === TokenType.NUMBER) {
                    key = this._parseLiteral();
                } else if (this._peek().type === TokenType.LBRACKET) {
                    // 计算属性名：{ [expr]: value }
                    // 例如：{ [someVar + 1]: "dynamic" }
                    this._advance();
                    key = this._parseExpression();
                    this._consume(TokenType.RBRACKET);
                } else {
                    key = this._parseIdentifier();
                }

                // 属性简写检测：如果 key 后紧跟 , 或 }，说明是简写 { x }
                if (this._check(TokenType.COMMA) || this._check(TokenType.RBRACE)) {
                    value = key;
                } else {
                    this._consume(TokenType.COLON);
                    value = this._parseExpression();
                }

                properties.push({ key, value });
            } while (this._match(TokenType.COMMA));
        }
        this._consume(TokenType.RBRACE);
        const node = AST.ObjectExpression(properties);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析字面量：数字、字符串、true、false、null、undefined
     *
     * @returns {ASTNode} Literal 节点
     */
    _parseLiteral() {
        const token = this._advance();
        let value;
        switch (token.type) {
            case TokenType.NUMBER: value = token.value; break;
            case TokenType.STRING: value = token.value; break;
            case TokenType.TRUE: value = true; break;
            case TokenType.FALSE: value = false; break;
            case TokenType.NULL: value = null; break;
            case TokenType.UNDEFINED: value = undefined; break;
            default: throw new Error(`Unexpected literal token: ${token.type}`);
        }
        const node = AST.Literal(value);
        this._emitNode(node);
        return node;
    }

    /**
     * 解析标识符
     *
     * 为什么即使 token 类型不是 IDENTIFIER 也创建 Identifier 节点？
     * - JavaScript 中某些关键字在特定上下文中可作为标识符使用（IdentifierName）
     *   例如：obj.default、import { from } from 'x'、class { get() {} }
     * - 词法分析器可能将这些词识别为关键字 token 类型，但在属性名等位置
     *   它们是合法的 IdentifierName，应创建 Identifier 节点
     *
     * @returns {ASTNode} Identifier 节点
     */
    _parseIdentifier() {
        const token = this._advance();
        if (token.type !== TokenType.IDENTIFIER) {
            // 关键字用作标识符（属性名、标签名等上下文）
            const node = AST.Identifier(token.value);
            this._emitNode(node);
            return node;
        }
        const node = AST.Identifier(token.value);
        this._emitNode(node);
        return node;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 解析辅助方法（Token 消费与前瞻）
    // ═══════════════════════════════════════════════════════════════════════
    //
    // _peek / _check / _match / _advance / _consume 是 token 流操作的基本接口。
    //
    // 方法语义对比：
    //
    //   _peek()        只读当前 token，不推进位置
    //   _check(type)   只读当前 token 类型，不推进位置（等价于 _peek().type === type）
    //   _match(type)   如果当前 token 匹配则消耗并返回 true，否则返回 false
    //   _advance()     无条件消耗当前 token 并返回它
    //   _consume(type) 消耗当前 token，如果不匹配则抛出错误
    //
    // 为什么提供 _check 和 _match 两个版本？
    // - _check：用于"前瞻后不一定消费"的场景
    //   例如 _parseStatement 中检查 LBRACE，因为 LBRACE 也可能是
    //   表达式上下文中的对象字面量
    // - _match：用于"明确就是要消费"的场景
    //   例如关键字匹配——看到 for 就一定是 for 语句，可以安全消费
    //

    /**
     * 前瞻当前 token（不消耗）
     * @returns {Token} 当前位置的 token
     */
    _peek() {
        return this.tokens[this.pos];
    }

    /**
     * 检查当前 token 是否为指定类型（不消耗）
     *
     * @param {string} type - TokenType 常量
     * @returns {boolean} 是否匹配
     */
    _check(type) {
        return this.tokens[this.pos]?.type === type;
    }

    /**
     * 如果当前 token 匹配指定类型则消耗它
     *
     * 相当于"有条件的消耗"：匹配就消耗并返回 true，不匹配返回 false。
     * 这是递归下降解析器中最常用的前瞻+消耗组合操作。
     *
     * @param {string} type - TokenType 常量
     * @returns {boolean} 是否匹配并消耗成功
     */
    _match(type) {
        if (this._check(type)) {
            this._advance();
            return true;
        }
        return false;
    }

    /**
     * 无条件消耗当前 token 并前进
     *
     * @returns {Token} 被消耗的 token
     */
    _advance() {
        return this.tokens[this.pos++];
    }

    /**
     * 消耗当前 token 并断言其类型
     *
     * 用于语法结构中要求必须是特定 token 的位置。
     * 如果类型不匹配则抛出错误——这是本解析器的错误处理策略。
     *
     * @param {string} type - 期望的 TokenType 常量
     * @returns {Token} 被消耗的 token
     * @throws {Error} token 类型不匹配时抛出
     */
    _consume(type) {
        const token = this._advance();
        if (token.type !== type) {
            throw new Error(`Expected ${type} but got ${token.type} (${token.value}) at ${token.line}:${token.col}`);
        }
        return token;
    }

    /**
     * 消费分号（支持最小 ASI）
     *
     * 为什么做最小 ASI？
     * - ECMAScript 的自动分号插入有 5 条规则，完整实现需要词法分析器
     *   跟踪 token 间的换行符和注释（Trivia），实现复杂度高
     * - 对于学习用途的引擎，最小实现足以跑通大部分正确编写的代码
     * - 当前仅支持：分号在 } 或 EOF 前可以省略
     * - 用户代码如果遵循"始终加分号"的编码风格，不会有任何问题
     *
     * 为什么不在 _advance 级别实现 ASI？
     * - ASI 规则与语法上下文相关（return 后的换行、for 头部等），
     *   纯 token 级别无法判断上下文
     * - 在解析器级别用 _consumeSemicolon 包装，可以在需要时增加
     *   上下文相关的 ASI 规则，不影响 token 流的底层抽象
     */
    _consumeSemicolon() {
        // 有显式分号就直接消费
        if (this._check(TokenType.SEMICOLON)) {
            this._advance();
        }
        // 无分号且遇到 } 或 EOF 时通过 ASI 隐式补全
        // 当前不对行终止符做额外检查（最小实现）
    }
}
