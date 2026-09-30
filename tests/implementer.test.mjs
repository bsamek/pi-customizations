import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test, after, afterEach } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// As a fake child CLI, validate its loadout without spending model tokens.
if (process.argv.includes('--mode')) {
  const args = process.argv.slice(2);
  const fs = await import('node:fs');
  const tools = args[args.indexOf('--tools') + 1];
  const guard = fs.readFileSync(args[args.indexOf('--append-system-prompt') + 1], 'utf8');
  const implementation = tools.includes('write');
  assert.ok(args.includes('--no-extensions'));
  assert.ok(args.includes('--no-session'));
  assert.equal(args[args.indexOf('--model') + 1], 'github-copilot/gpt-6-luna');
  const exploration = guard.includes('exploring a codebase');
  assert.equal(args.includes('--no-skills'), implementation || exploration);
  assert.equal(args.includes('--no-prompt-templates'), implementation || exploration);
  if (exploration) {
    assert.ok(!tools.includes('edit'));
    assert.ok(!tools.includes('write'));
    assert.ok(guard.includes('line references'));
    assert.ok(guard.includes('Do not delegate'));
  }
  assert.ok(guard.includes(implementation ? 'Do not commit' : 'read-only subagent'));
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture complete' }], stopReason: args.at(-1) === 'Task: fail' ? 'error' : 'stop', errorMessage: args.at(-1) === 'Task: fail' ? 'fixture error' : undefined } }));
} else {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-implementer-test-'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  afterEach(() => {
    for (const role of ['implementer', 'explorer']) fs.rmSync(path.join(agentDir, `${role}.json`), { force: true });
  });
  // Resolve dependencies from the installed Pi rather than requiring a local install.
  const require = createRequire(process.env.PI_TEST_PACKAGE || '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json');
  const { createJiti } = require('jiti');
  const root = new URL('.', `file://${require.resolve('./package.json')}`);
  const alias = Object.fromEntries(['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'].map(name => [name, fileURLToPath(new URL(name === '@earendil-works/pi-coding-agent' ? 'dist/index.js' : `node_modules/${name}/${name === 'typebox' ? 'build/index.mjs' : 'dist/index.js'}`, root))]));
  const jiti = createJiti(import.meta.url, { alias });
  const { default: extension } = await jiti.import(fileURLToPath(new URL('../extensions/subagent/index.ts', import.meta.url)));
  const luna = { provider: 'github-copilot', id: 'gpt-6-luna', name: 'GPT-6 Luna', reasoning: true };
  function setup() {
    const tools = new Map(), commands = new Map(), events = new Map(), notices = [];
    let active = ['read', 'edit', 'write', 'bash'];
    const pi = {
      registerTool: t => { tools.set(t.name, t); active.push(t.name); },
      registerCommand: (n, c) => commands.set(n, c),
      on: (n, fn) => events.set(n, [...(events.get(n) || []), fn]),
      getActiveTools: () => active,
      setActiveTools: names => { active = names; },
    };
    const ctx = { cwd: process.cwd(), thinkingLevel: 'low', scopedModels: [{ model: luna }], modelRegistry: { getAvailable: () => [luna] }, ui: { notify: text => notices.push(text), setStatus: () => {} } };
    extension(pi);
    for (const fn of events.get('session_start')) fn({}, ctx);
    return { tools, commands, events, ctx, notices, active: () => active, mode: args => commands.get('implementer').handler(args, ctx) };
  }
  test('defaults off; selecting and disabling preserves other tools; restores on session start', async () => {
    const s = setup();
    assert.ok(!s.active().includes('implement'));
    await assert.rejects(s.tools.get('implement').execute('', { task: 'test' }, undefined, undefined, s.ctx), /off/);
    await s.mode('GPT-6 Luna');
    assert.ok(s.active().includes('implement'));
    await s.mode('not-a-model');
    assert.ok(s.active().includes('implement'));
    await s.mode('status');
    assert.match(s.notices.at(-1), /github-copilot\/gpt-6-luna/);
    await s.mode('off');
    assert.ok(!s.active().includes('implement'));
    assert.ok(s.active().includes('subagent'));
    await s.mode('gpt-6-luna');
    for (const fn of s.events.get('session_start')) fn({}, s.ctx);
    assert.ok(s.active().includes('implement'));
    assert.ok(setup().active().includes('implement'));
    await s.mode('off');
    assert.ok(!setup().active().includes('implement'));
  });
  test('write child is pinned, isolated, sequential, and reports output', async () => {
    const s = setup();
    await s.mode('gpt-6-luna');
    const execute = task => s.tools.get('implement').execute('', { task }, undefined, undefined, s.ctx);
    const first = execute('fixture');
    await assert.rejects(execute('second'), /already running/);
    for (const name of ['edit', 'write', 'bash']) {
      assert.equal(s.events.get('tool_call')[0]({ toolName: name }).block, true);
    }
    await s.mode('off');
    assert.match(s.notices.at(-1), /Wait/);
    const result = await first;
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /fixture complete/);
    assert.equal(result.details.results[0].resolvedModel, 'github-copilot/gpt-6-luna');
    await s.mode('off');
    await assert.rejects(execute('third'), /off/);
  });
  test('read-only review loadout is unchanged', async () => {
    const s = setup();
    const result = await s.tools.get('subagent').execute('', { model: 'gpt-6-luna', task: 'fixture' }, undefined, undefined, s.ctx);
    assert.match(result.content[0].text, /fixture complete/);
  });
  test('cancellation releases the single-implementer lock', async () => {
    const s = setup();
    await s.mode('gpt-6-luna');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(s.tools.get('implement').execute('', { task: 'fixture' }, controller.signal, undefined, s.ctx), /aborted/);
    await s.mode('off');
    assert.ok(!s.active().includes('implement'));
  });
  test('on defaults to Luna; model picker persists selection without enabling delegation', async () => {
    fs.rmSync(path.join(agentDir, 'implementer.json'), { force: true });
    const s = setup();
    await s.mode('on');
    assert.ok(s.active().includes('implement'));
    await s.mode('off');
    const other = { ...luna, id: 'other', name: 'Other' };
    s.ctx.scopedModels.push({ model: other });
    s.ctx.hasUI = true;
    s.ctx.ui.select = async () => 'github-copilot/other';
    await s.mode('model');
    assert.ok(!s.active().includes('implement'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, 'implementer.json'), 'utf8')).model, 'github-copilot/other');
    const resumed = setup();
    resumed.ctx.scopedModels.push({ model: other });
    assert.ok(!resumed.active().includes('implement'));
    await resumed.mode('on');
    await resumed.mode('status');
    assert.match(resumed.notices.at(-1), /on.*github-copilot\/other/);
    await resumed.mode('model gpt-6-luna');
    await resumed.mode('status');
    assert.match(resumed.notices.at(-1), /on.*github-copilot\/gpt-6-luna/);
    await resumed.mode('off');
    await resumed.mode('on');
    assert.ok(resumed.active().includes('implement'));
  });
  test('roles support all four independent modes and persist independently', async () => {
    const s = setup();
    const explorer = args => s.commands.get('explorer').handler(args, s.ctx);
    assert.ok(!s.active().includes('explore') && !s.active().includes('implement'));
    await explorer('on');
    assert.ok(s.active().includes('explore') && !s.active().includes('implement'));
    await s.mode('on');
    assert.ok(s.active().includes('explore') && s.active().includes('implement'));
    await explorer('off');
    assert.ok(!s.active().includes('explore') && s.active().includes('implement'));
    await s.mode('off');
    assert.ok(!s.active().includes('explore') && !s.active().includes('implement'));
    await explorer('on');
    await s.mode('on');
    for (const fn of s.events.get('session_start')) fn({}, s.ctx);
    assert.ok(s.active().includes('explore') && s.active().includes('implement'));
    assert.ok(s.active().includes('subagent'));
    let next = setup();
    assert.ok(next.active().includes('explore') && next.active().includes('implement'));
    await explorer('off');
    next = setup();
    assert.ok(!next.active().includes('explore') && next.active().includes('implement'));
    await s.mode('off');
    next = setup();
    assert.ok(!next.active().includes('explore') && !next.active().includes('implement'));
  });
  test('explorer model selection is persisted independently', async () => {
    const s = setup();
    await s.mode('model gpt-6-luna');
    const other = { ...luna, id: 'exploration-model', name: 'Explorer' };
    s.ctx.scopedModels.push({ model: other });
    await s.commands.get('explorer').handler('model exploration-model', s.ctx);
    assert.ok(!s.active().includes('explore'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, 'explorer.json'), 'utf8')).model, 'github-copilot/exploration-model');
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, 'implementer.json'), 'utf8')).model, 'github-copilot/gpt-6-luna');
    const resumed = setup();
    resumed.ctx.scopedModels.push({ model: other });
    await resumed.commands.get('explorer').handler('on', resumed.ctx);
    await resumed.commands.get('explorer').handler('status', resumed.ctx);
    assert.match(resumed.notices.at(-1), /on.*exploration-model/);
    await resumed.commands.get('explorer').handler('model gpt-6-luna', resumed.ctx);
  });
  test('explorers run read-only in parallel, bounded and exclusive of implementation', async () => {
    const s = setup();
    const explore = task => s.tools.get('explore').execute('', { task }, undefined, undefined, s.ctx);
    const implement = () => s.tools.get('implement').execute('', { task: 'fixture' }, undefined, undefined, s.ctx);
    await assert.rejects(explore('fixture'), /off/);
    await s.commands.get('explorer').handler('on', s.ctx);
    await s.mode('on');
    const runs = Array.from({ length: 4 }, () => explore('fixture'));
    await assert.rejects(explore('fifth'), /At most 4/);
    await assert.rejects(implement(), /Explorers are running/);
    assert.equal(s.events.get('tool_call')[0]({ toolName: 'write' }).block, true);
    const results = await Promise.all(runs);
    for (const r of results) {
      assert.equal(r.isError, false);
      assert.match(r.content[0].text, /fixture complete/);
    }
    const writing = implement();
    await assert.rejects(explore('fixture'), /implementer is already running/);
    await writing;
    const failed = await explore('fail');
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /fixture error/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(s.tools.get('explore').execute('', { task: 'fixture' }, controller.signal, undefined, s.ctx), /aborted/);
    assert.equal((await implement()).isError, false);
  });
  test('coordinator instructions grant judgment only for enabled roles', async () => {
    const s = setup();
    async function prompt() {
      let systemPrompt = 'base';
      for (const handler of s.events.get('before_agent_start')) {
        const result = await handler({ systemPrompt, systemPromptOptions: { selectedTools: s.active() } }, s.ctx);
        if (result) systemPrompt = result.systemPrompt;
      }
      return systemPrompt;
    }
    let p = await prompt();
    assert.match(p, /Implementation delegation is off/);
    assert.match(p, /Exploration delegation is off/);
    await s.commands.get('explorer').handler('on', s.ctx);
    p = await prompt();
    assert.match(p, /Use your judgment to call explore/);
    assert.match(p, /Implementation delegation is off/);
    await s.mode('on');
    p = await prompt();
    assert.match(p, /Use your judgment to call implement/);
    assert.match(p, /Use your judgment to call explore/);
    assert.match(p, /only when the user asks for a cross-model review/);
  });
  test('legacy model-only preferences remain off; malformed settings fail closed', async () => {
    fs.writeFileSync(path.join(agentDir, 'implementer.json'), JSON.stringify({ model: 'github-copilot/gpt-6-luna' }));
    let s = setup();
    assert.ok(!s.active().includes('implement'));
    await s.mode('on');
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, 'implementer.json'), 'utf8')).enabled, true);
    fs.writeFileSync(path.join(agentDir, 'implementer.json'), JSON.stringify({ model: 'github-copilot/gpt-6-luna', enabled: 'true' }));
    s = setup();
    assert.ok(!s.active().includes('implement'));
    assert.match(s.notices.at(-1), /Could not read/);
  });
  test('unavailable saved model stays off without silently switching or losing preference', async () => {
    const preference = { model: 'github-copilot/unavailable', enabled: true };
    fs.writeFileSync(path.join(agentDir, 'explorer.json'), JSON.stringify(preference));
    const s = setup();
    assert.ok(!s.active().includes('explore'));
    assert.match(s.notices.at(-1), /unavailable/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, 'explorer.json'), 'utf8')), preference);
  });
  test('model selection preserves saved on and off state', async () => {
    const s = setup();
    await s.mode('model gpt-6-luna');
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, 'implementer.json'), 'utf8')).enabled, false);
    await s.mode('on');
    await s.mode('model gpt-6-luna');
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, 'implementer.json'), 'utf8')).enabled, true);
    assert.ok(setup().active().includes('implement'));
  });
  test('selected implementer must remain in model scope', async () => {
    const s = setup();
    await s.mode('gpt-6-luna');
    s.ctx.scopedModels = [{ model: { ...luna, id: 'other' } }];
    await assert.rejects(s.tools.get('implement').execute('', { task: 'test' }, undefined, undefined, s.ctx), /no longer available/);
  });
}
