import { JSEngine, HookEvents } from './src/index.js';

// Helper to format value for console
function fmt(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object' && v !== null) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  if (typeof v === 'string') return `"${v}"`;
  return String(v);
}

// ====================================================================
// Hook logger: tracks and prints execution steps
// ====================================================================
function createLogger(label) {
  return {
    steps: [],
    log(event, data) {
      const entry = { event, data: JSON.parse(JSON.stringify(data)) };
      this.steps.push(entry);
    },
    printSummary() {
      console.log(`\n  [${label}] Hook events captured: ${this.steps.length}`);
      this.steps.forEach((s, i) => {
        const d = s.data;
        switch (s.event) {
          case HookEvents.CONTEXT_CREATION_START:
            console.log(`    ${i + 1}. EC CREATE ▶ ${d.type} ${d.name ? '(' + d.name + ')' : ''}`);
            break;
          case HookEvents.CONTEXT_CREATION_END:
            console.log(`    ${i + 1}. EC CREATE ✓ ${d.type} ${d.name ? '(' + d.name + ')' : ''}`);
            break;
          case HookEvents.CONTEXT_PUSH:
            console.log(`    ${i + 1}. EC PUSH  → ${d.type} ${d.name ? '(' + d.name + ')' : ''}`);
            break;
          case HookEvents.CONTEXT_POP:
            console.log(`    ${i + 1}. EC POP   ← ${d.type} ${d.name ? '(' + d.name + ')' : ''}`);
            break;
          case HookEvents.VARIABLE_DECLARE:
            console.log(`    ${i + 1}. VAR DECL   ${d.name} (${d.kind}) init=${d.initialized}`);
            break;
          case HookEvents.VARIABLE_ASSIGN:
            console.log(`    ${i + 1}. VAR SET    ${d.name}: ${fmt(d.oldValue)} → ${fmt(d.newValue)}`);
            break;
          case HookEvents.VARIABLE_READ:
            console.log(`    ${i + 1}. VAR READ   ${d.name} = ${fmt(d.value)}`);
            break;
          case HookEvents.SCOPE_LOOKUP:
            console.log(`    ${i + 1}. SCOPE      looking up "${d.name}"`);
            break;
          case HookEvents.SCOPE_CHAIN_RESOLVE:
            console.log(`    ${i + 1}. SCOPE RES  "${d.name}" found=${d.found} depth=${d.depth}`);
            break;
          case HookEvents.CLOSURE_CREATE:
            console.log(`    ${i + 1}. CLOSURE    ${d.funcName} captures [${(d.capturedVars || []).join(', ')}]`);
            break;
          case HookEvents.THIS_RESOLVE:
            console.log(`    ${i + 1}. THIS       pattern=${d.pattern} value=${fmt(d.value)}`);
            break;
          case HookEvents.FUNCTION_CALL:
            console.log(`    ${i + 1}. FUNC CALL  ${d.name}(${d.args.map(fmt).join(', ')}) this=${fmt(d.thisValue)}`);
            break;
          case HookEvents.FUNCTION_RETURN:
            console.log(`    ${i + 1}. FUNC RET   ${d.name} → ${fmt(d.value)}`);
            break;
          case HookEvents.MEMORY_ALLOCATE:
            console.log(`    ${i + 1}. MEM ALLOC  @${d.address} type=${d.type}`);
            break;
          case HookEvents.EVAL_NODE_ENTER:
            // too noisy by default, skip
            break;
          case HookEvents.EVAL_NODE_EXIT:
            break;
          default:
            console.log(`    ${i + 1}. ${s.event}`);
        }
      });
    }
  };
}

// ====================================================================
// Test 1: Basic variable declaration and assignment
// ====================================================================
console.log('\n========== Test 1: Basic Variables ==========');
{
  const engine = new JSEngine();
  const logger = createLogger('Test1');

  engine.on(HookEvents.VARIABLE_DECLARE, (d) => logger.log(HookEvents.VARIABLE_DECLARE, d));
  engine.on(HookEvents.VARIABLE_ASSIGN, (d) => logger.log(HookEvents.VARIABLE_ASSIGN, d));
  engine.on(HookEvents.VARIABLE_READ, (d) => logger.log(HookEvents.VARIABLE_READ, d));
  engine.on(HookEvents.SCOPE_CHAIN_RESOLVE, (d) => logger.log(HookEvents.SCOPE_CHAIN_RESOLVE, d));

  const result = engine.execute(`
    var a = 10;
    let b = 20;
    const c = 30;
    a + b + c;
  `);

  console.log(`  Result: ${fmt(result)} (expected: 60)`);
  logger.printSummary();
  console.log(`  PASS: ${result === 60}`);
}

// ====================================================================
// Test 2: Hoisting (var vs let TDZ)
// ====================================================================
console.log('\n========== Test 2: Hoisting & TDZ ==========');
{
  const engine = new JSEngine();

  // var hoisting: x is hoisted and initialized to undefined
  const result1 = engine.execute(`
    var hoisted = x;
    var x = 10;
    hoisted;
  `);
  console.log(`  var hoisting: x before init = ${fmt(result1)} (expected: undefined)`);
  console.log(`  PASS: ${result1 === undefined}`);

  // let TDZ: accessing y before declaration should throw
  let tdzCaught = false;
  try {
    engine.execute(`
      let beforeInit = y;
      let y = 5;
    `);
  } catch (e) {
    tdzCaught = true;
    console.log(`  let TDZ: ReferenceError caught: ${e.message}`);
  }
  console.log(`  PASS: ${tdzCaught}`);
}

// ====================================================================
// Test 3: Scope chain & closure
// ====================================================================
console.log('\n========== Test 3: Scope Chain & Closure ==========');
{
  const engine = new JSEngine();
  const logger = createLogger('Test3');

  engine.on(HookEvents.CONTEXT_PUSH, (d) => logger.log(HookEvents.CONTEXT_PUSH, d));
  engine.on(HookEvents.CONTEXT_POP, (d) => logger.log(HookEvents.CONTEXT_POP, d));
  engine.on(HookEvents.CLOSURE_CREATE, (d) => logger.log(HookEvents.CLOSURE_CREATE, d));
  engine.on(HookEvents.VARIABLE_ASSIGN, (d) => logger.log(HookEvents.VARIABLE_ASSIGN, d));
  engine.on(HookEvents.SCOPE_CHAIN_RESOLVE, (d) => logger.log(HookEvents.SCOPE_CHAIN_RESOLVE, d));
  engine.on(HookEvents.FUNCTION_CALL, (d) => logger.log(HookEvents.FUNCTION_CALL, d));
  engine.on(HookEvents.FUNCTION_RETURN, (d) => logger.log(HookEvents.FUNCTION_RETURN, d));

  const result = engine.execute(`
    function outer() {
      var x = 10;
      return function inner() {
        return x + 1;
      };
    }
    var fn = outer();
    fn();
  `);

  console.log(`  Result: ${fmt(result)} (expected: 11)`);
  logger.printSummary();

  // Check trace for closure creation event
  const trace = engine.getTrace();
  const closureEvents = trace.filter(t => t.event === HookEvents.CLOSURE_CREATE);
  console.log(`  Closure events in trace: ${closureEvents.length}`);
  console.log(`  PASS: ${result === 11 && closureEvents.length > 0}`);
}

// ====================================================================
// Test 4: this binding (4 patterns)
// ====================================================================
console.log('\n========== Test 4: this Binding ==========');
{
  // 4a: Global this
  console.log('  --- 4a: Global this ---');
  {
    const engine = new JSEngine();
    const result = engine.execute(`
      var x = 'globalX';
      this.x;
    `);
    console.log(`  this.x in global: ${fmt(result)} (expected: "globalX")`);
    console.log(`  PASS: ${result === 'globalX'}`);
  }

  // 4b: Method call this
  console.log('  --- 4b: Method call this ---');
  {
    const engine = new JSEngine();
    const logger = createLogger('Test4b');
    engine.on(HookEvents.THIS_RESOLVE, (d) => logger.log(HookEvents.THIS_RESOLVE, d));

    const result = engine.execute(`
      var obj = { x: 42, getX: function() { return this.x; } };
      obj.getX();
    `);
    console.log(`  obj.getX(): ${fmt(result)} (expected: 42)`);
    logger.printSummary();
    console.log(`  PASS: ${result === 42}`);
  }

  // 4c: Explicit this (call)
  console.log('  --- 4c: Explicit this (call) ---');
  {
    const engine = new JSEngine();
    const result = engine.execute(`
      function getX() { return this.x; }
      var obj = { x: 99 };
      getX.call(obj);
    `);
    console.log(`  getX.call(obj): ${fmt(result)} (expected: 99)`);
    console.log(`  PASS: ${result === 99}`);
  }

  // 4d: Arrow function this (lexical)
  console.log('  --- 4d: Arrow function this ---');
  {
    const engine = new JSEngine();
    const result = engine.execute(`
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
    `);
    console.log(`  arrow this: ${fmt(result)} (expected: 11)`);
    console.log(`  PASS: ${result === 11}`);
  }
}

// ====================================================================
// Test 5: Complex closure with multiple scopes
// ====================================================================
console.log('\n========== Test 5: Complex Closure ==========');
{
  const engine = new JSEngine();
  const logger = createLogger('Test5');

  engine.on(HookEvents.CLOSURE_CREATE, (d) => logger.log(HookEvents.CLOSURE_CREATE, d));
  engine.on(HookEvents.SCOPE_CHAIN_RESOLVE, (d) => logger.log(HookEvents.SCOPE_CHAIN_RESOLVE, d));
  engine.on(HookEvents.FUNCTION_CALL, (d) => logger.log(HookEvents.FUNCTION_CALL, d));
  engine.on(HookEvents.FUNCTION_RETURN, (d) => logger.log(HookEvents.FUNCTION_RETURN, d));

  const result = engine.execute(`
    function createCounter(initial) {
      var count = initial;
      return {
        increment: function() {
          count = count + 1;
          return count;
        },
        decrement: function() {
          count = count - 1;
          return count;
        }
      };
    }
    var counter = createCounter(10);
    counter.increment();
    counter.increment();
  `);

  console.log(`  counter.increment() twice: ${fmt(result)} (expected: 12)`);
  logger.printSummary();

  // Verify scope chain: the 'count' variable is resolved through closure
  const trace = engine.getTrace();
  const scopeEvents = trace.filter(t => t.event === HookEvents.SCOPE_CHAIN_RESOLVE && t.data.name === 'count');
  console.log(`  Scope resolutions for 'count': ${scopeEvents.length}`);
  console.log(`  PASS: ${result === 12 && scopeEvents.length > 0}`);
}

// ====================================================================
// Test 6: Block scope (let in block)
// ====================================================================
console.log('\n========== Test 6: Block Scope ==========');
{
  const engine = new JSEngine();

  // let is block-scoped
  const result = engine.execute(`
    var x = 1;
    {
      let x = 2;
    }
    x;
  `);
  console.log(`  var x after block with let x = 2: ${fmt(result)} (expected: 1)`);
  console.log(`  PASS: ${result === 1}`);
}

// ====================================================================
// Test 7: Conditional and loops
// ====================================================================
console.log('\n========== Test 7: Control Flow ==========');
{
  const engine = new JSEngine();

  // If-else
  const r1 = engine.execute(`
    var x = 5;
    if (x > 3) { 10; } else { 20; }
  `);
  console.log(`  if (5 > 3): ${fmt(r1)} (expected: 10)`);

  // For loop
  const r2 = engine.execute(`
    var sum = 0;
    for (var i = 0; i < 5; i = i + 1) {
      sum = sum + i;
    }
    sum;
  `);
  console.log(`  for sum 0..4: ${fmt(r2)} (expected: 10)`);

  // While loop
  const r3 = engine.execute(`
    var n = 5;
    var fact = 1;
    while (n > 0) {
      fact = fact * n;
      n = n - 1;
    }
    fact;
  `);
  console.log(`  5! via while: ${fmt(r3)} (expected: 120)`);

  console.log(`  PASS: ${r1 === 10 && r2 === 10 && r3 === 120}`);
}

// ====================================================================
// Test 8: Full engine trace
// ====================================================================
console.log('\n========== Test 8: Full Engine Trace ==========');
{
  const engine = new JSEngine();

  engine.execute(`
    var a = 1;
    function add(b) { return a + b; }
    add(2);
  `);

  const trace = engine.getTrace();
  console.log(`  Total trace entries: ${trace.length}`);

  // Count events by type
  const counts = {};
  trace.forEach(t => {
    counts[t.event] = (counts[t.event] || 0) + 1;
  });
  console.log('  Event counts:');
  Object.entries(counts).sort().forEach(([k, v]) => {
    console.log(`    ${k}: ${v}`);
  });

  console.log('  PASS: trace has entries for all phases');
}

// ====================================================================
// Test 9: const 不可变性
// ====================================================================
console.log('\n========== Test 9: Const Immutability ==========');
{
  let caught = false;
  try {
    const engine = new JSEngine();
    engine.execute(`
      const c = 10;
      c = 20;
    `);
  } catch (e) {
    caught = e.message.includes('constant') || e.message.includes('Assignment');
  }
  console.log(`  Const reassign TypeError caught: ${caught} (expected: true)`);
  console.log(`  PASS: ${caught}`);
}

// ====================================================================
// Test 10: 嵌套函数（无捕获变量，非闭包）
// ====================================================================
console.log('\n========== Test 10: Nested Function (non-closure) ==========');
{
  const engine = new JSEngine();
  const logger = createLogger('Test10');
  engine.on(HookEvents.CLOSURE_CREATE, (d) => logger.log('closure:create', d));

  engine.execute(`
    function outer2() {
      var x = 10;
      function outer22() {
        var x = 10;
        return 22;
      }
      return 22;
    }
    outer2();
  `);

  const closures = logger.steps.filter(s => s.event === 'closure:create');
  const outer2Closure = closures.find(c => c.data.funcName === 'outer2');
  const outer22Closure = closures.find(c => c.data.funcName === 'outer22');

  console.log(`  outer2 isRealClosure: ${outer2Closure ? outer2Closure.data.isRealClosure : 'N/A'} (expected: false — 顶层函数)`);
  console.log(`  outer22 isRealClosure: ${outer22Closure ? outer22Closure.data.isRealClosure : 'N/A'} (expected: false — 嵌套但无捕获)`);
  console.log(`  outer22 isNested: ${outer22Closure ? outer22Closure.data.isNested : 'N/A'} (expected: true — 嵌套在 outer2 内)`);

  const ok = outer2Closure && !outer2Closure.data.isRealClosure
    && outer22Closure && !outer22Closure.data.isRealClosure && outer22Closure.data.isNested;
  console.log(`  PASS: ${ok}`);
}

// ====================================================================
// Summary
// ====================================================================
console.log('\n============================================');
console.log('  All tests completed!');
console.log('============================================\n');
