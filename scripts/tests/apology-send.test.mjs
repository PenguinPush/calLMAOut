import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../../src/content.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('content.ts', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'onSend');
assert.ok(fn);
const compiled = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
function scenario({ owed = false, strikeDue = false, laugh = true, autoSend = true, strikeWait, modalWait, face = null, didSend = true } = {}) {
  const calls = [];
  const strikes = [];
  const deps = {
    textOf: () => 'lmao',
    classify: async () => ({ laugh, why: 'test' }),
    chrome: { storage: { local: { get: async () => ({ apologyDue: owed }) } } },
    send: async ({ type, ...message }) => {
      if (type === "message-face") return face;
      if (type === "strike") strikes.push(message);
      calls.push(type);
      if (type === 'capture') return { dataUrl: 'gif', analysis: { face: true, smile: 0.1 }, sourceAgeMs: 0, entrance: 'cube', effect: 'shatter' };
      if (type === 'strike') return strikeWait ? strikeWait.promise : { apologyDue: strikeDue };
    },
    getSettings: async () => ({ autoSend, sendDelay: 0, skipSmiles: false, smileThreshold: 0.5 }),
    cleared: async () => didSend,
    log: () => {},
    apologize: async () => { calls.push('modal'); await modalWait?.promise; },
    previewRendered: async () => { calls.push('preview'); return true; },
    attach: async () => { calls.push('attach'); },
    submit: () => { calls.push('submit'); return 'test'; },
    sleep: async () => {},
  };
  const onSend = new Function(...Object.keys(deps), `let busy = false; const lastEditable = null; ${compiled}; return onSend;`)(...Object.values(deps));
  return { calls, strikes, run: () => onSend({ isConnected: true }, 'enter') };
}
for (const autoSend of [true, false]) {
  const trigger = scenario({ strikeDue: true, autoSend });
  await trigger.run();
  assert.deepEqual(trigger.calls, ['capture', 'strike', 'modal']);
}
for (const laugh of [true, false]) {
  const overdue = scenario({ owed: true, laugh });
  await overdue.run();
  assert.ok(overdue.calls.includes('modal'));
  assert.ok(!overdue.calls.includes('capture') && !overdue.calls.includes('attach'));
}
const normal = scenario();
await normal.run();
assert.deepEqual(normal.calls, ['capture', 'strike', 'preview', 'attach', 'submit']);
const strikeWait = deferred(), modalWait = deferred();
const waiting = scenario({ strikeWait, modalWait });
const pending = waiting.run();
for (let i = 0; i < 15; i++) await Promise.resolve();
assert.deepEqual(waiting.calls, ['capture', 'strike'], 'no attachment before strike decision');
strikeWait.resolve({ apologyDue: true });
for (let i = 0; i < 15; i++) await Promise.resolve();
await waiting.run();
assert.deepEqual(waiting.calls, ['capture', 'strike', 'modal'], 'no concurrent GIF while modal is open');
modalWait.resolve();
await pending;
console.log('Apology-triggering and overdue messages skip GIFs; normal sends and modal concurrency checks passed.');

for (const smile of [0.1, 0.9]) {
  const ordinary = scenario({ laugh: false, face: { face: true, smile } });
  await ordinary.run();
  assert.deepEqual(ordinary.calls, ['strike', 'forget-smile']);
  assert.deepEqual(ordinary.strikes, [{ analysis: { face: true, smile }, laugh: false }]);
}
const cancelled = scenario({ laugh: false, face: { face: true, smile: 0.9 }, didSend: false });
await cancelled.run();
assert.deepEqual(cancelled.calls, [], 'unsent smiling message cannot reset the streak');

const background = await readFile(new URL('../../src/background.ts', import.meta.url), 'utf8');
const backgroundAst = ts.createSourceFile('background.ts', background, ts.ScriptTarget.Latest, true);
const strikeFn = backgroundAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'strike');
const strikeCode = ts.transpileModule(strikeFn.getText(backgroundAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const state = { strikeCount: 0, apologyDue: false };
const strike = new Function('chrome', 'getSettings', 'log', strikeCode + '; return strike;')(
  { storage: { local: { get: async () => ({ ...state }), set: async (values) => Object.assign(state, values) } } },
  async () => ({ enabled: true, apologyStrikes: 3, smileThreshold: 0.5 }),
  () => {},
);
await strike({ face: true, smile: 0.1 }, true);
await strike({ face: true, smile: 0.1 }, false);
assert.equal(state.strikeCount, 1, 'ordinary neutral messages preserve the lie streak');
await strike({ face: false }, true);
assert.equal(state.strikeCount, 1);
await strike({ face: true, smile: 0.9 }, false);
assert.equal(state.strikeCount, 0, 'a smiling sent message resets the streak');
for (let i = 0; i < 3; i++) await strike({ face: true, smile: 0.1 }, true);
assert.deepEqual(state, { strikeCount: 3, apologyDue: true });
await strike({ face: true, smile: 0.9 }, true);
assert.deepEqual(state, { strikeCount: 0, apologyDue: true }, 'an already owed apology still requires recording');
console.log('Consecutive lie policy and ordinary smiling sends passed.');
