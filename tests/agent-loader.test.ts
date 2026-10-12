import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoader, BUILTIN_GENERAL_AGENT } from '../src/agents/loader.js';
import { DomainAgentRegistry } from '../src/agents/domain-registry.js';

test('AgentLoader returns builtin general agent by default', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'cheese-agent-test-'));
  try {
    const loader = new AgentLoader(testRoot, join(testRoot, 'empty-global'));
    const agents = loader.load();

    assert.ok(agents.length >= 1);
    assert.equal(agents[0].id, 'general');
    assert.equal(agents[0].source, 'builtin');
    assert.deepEqual(agents[0].tools, ['*']);

    // Non-existent ID returns general fallback
    assert.equal(loader.get('non-existent').id, 'general');
    assert.equal(loader.get().id, 'general');
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test('AgentLoader scans global and workspace directories, and workspace overrides global', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'cheese-agent-test-'));
  const globalDir = join(testRoot, 'global-agents');
  const workspaceDir = join(testRoot, 'workspace');
  const workspaceAgentsDir = join(workspaceDir, '.agents');

  mkdirSync(globalDir, { recursive: true });
  mkdirSync(workspaceAgentsDir, { recursive: true });

  try {
    // 1. Create a global agent: "reviewer"
    const globalReviewerDir = join(globalDir, 'reviewer');
    mkdirSync(globalReviewerDir);
    writeFileSync(
      join(globalReviewerDir, 'agent.json'),
      JSON.stringify({
        id: 'reviewer',
        name: 'Global Reviewer',
        description: 'Global code review agent',
        avatar: '🌐',
        tools: ['file_read'],
        knowledge: ['global-docs'],
      })
    );

    // 2. Create another global agent: "unique-global"
    const globalUniqueDir = join(globalDir, 'unique-global');
    mkdirSync(globalUniqueDir);
    writeFileSync(
      join(globalUniqueDir, 'agent.json'),
      JSON.stringify({
        id: 'unique-global',
        name: 'Unique Global Agent',
        tools: [],
      })
    );

    // 3. Create a workspace agent overriding "reviewer" with custom PROMPT.md and local docs
    const wsReviewerDir = join(workspaceAgentsDir, 'reviewer');
    mkdirSync(wsReviewerDir);
    mkdirSync(join(wsReviewerDir, 'docs'));
    writeFileSync(
      join(wsReviewerDir, 'PROMPT.md'),
      'You are a strict workspace code reviewer.'
    );
    writeFileSync(
      join(wsReviewerDir, 'agent.json'),
      JSON.stringify({
        id: 'reviewer',
        name: 'Workspace Reviewer',
        description: 'Local workspace code reviewer',
        avatar: '💻',
        systemPrompt: 'Base rule: focus on typescript.',
        promptFile: 'PROMPT.md',
        tools: ['file_read', 'file_write', 'search_files'],
        skills: ['code-review'],
      })
    );

    const loader = new AgentLoader(workspaceDir, globalDir);
    const agents = loader.load();

    // Total: general + unique-global + reviewer = 3
    assert.equal(agents.length, 3);
    assert.equal(agents[0].id, 'general');

    const reviewer = loader.get('reviewer');
    assert.equal(reviewer.name, 'Workspace Reviewer');
    assert.equal(reviewer.source, 'workspace');
    assert.equal(reviewer.avatar, '💻');
    assert.deepEqual(reviewer.tools, ['file_read', 'file_write', 'search_files']);
    assert.deepEqual(reviewer.skills, ['code-review']);
    // docs/ auto-discovery
    assert.ok(reviewer.knowledge.includes('reviewer'));
    // PROMPT.md merged
    assert.ok(reviewer.fullPrompt.includes('Base rule: focus on typescript.'));
    assert.ok(reviewer.fullPrompt.includes('You are a strict workspace code reviewer.'));

    // Unique global preserved
    const unique = loader.get('unique-global');
    assert.equal(unique.name, 'Unique Global Agent');
    assert.equal(unique.source, 'global');
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test('AgentLoader ignores invalid manifests gracefully and DomainAgentRegistry reloads', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'cheese-agent-test-'));
  const workspaceAgentsDir = join(testRoot, '.agents');
  mkdirSync(workspaceAgentsDir, { recursive: true });

  try {
    // 1. Invalid JSON
    const badJsonDir = join(workspaceAgentsDir, 'bad-json');
    mkdirSync(badJsonDir);
    writeFileSync(join(badJsonDir, 'agent.json'), '{ not json');

    // 2. Missing required 'name'
    const invalidSchemaDir = join(workspaceAgentsDir, 'missing-name');
    mkdirSync(invalidSchemaDir);
    writeFileSync(join(invalidSchemaDir, 'agent.json'), JSON.stringify({ id: 'missing-name' }));

    // 3. Valid agent
    const validDir = join(workspaceAgentsDir, 'qa-agent');
    mkdirSync(validDir);
    writeFileSync(
      join(validDir, 'agent.json'),
      JSON.stringify({
        id: 'qa-agent',
        name: 'QA Inspector',
        tools: ['web_search'],
      })
    );

    const registry = new DomainAgentRegistry(testRoot, join(testRoot, 'no-global'));
    assert.equal(registry.has('qa-agent'), true);
    assert.equal(registry.has('bad-json'), false);
    assert.equal(registry.has('missing-name'), false);

    assert.equal(registry.get('qa-agent').name, 'QA Inspector');
    assert.equal(registry.get('missing-name').id, BUILTIN_GENERAL_AGENT.id);

    // Test reload
    const reloaded = registry.reload();
    assert.ok(reloaded.some((a) => a.id === 'qa-agent'));
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
