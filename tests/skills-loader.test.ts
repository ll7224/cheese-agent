import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillLoader } from '../src/skills/loader.js';

test('SkillLoader scans both global and workspace directories and workspace overrides global', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'cheese-skills-test-'));
  const globalDir = join(testRoot, 'global-skills');
  const workspaceDir = join(testRoot, 'workspace');
  const workspaceSkillsDir = join(workspaceDir, '.skills');

  mkdirSync(globalDir, { recursive: true });
  mkdirSync(workspaceSkillsDir, { recursive: true });

  try {
    // 1. Create a global skill: "code-review"
    const globalReviewDir = join(globalDir, 'code-review');
    mkdirSync(globalReviewDir);
    writeFileSync(
      join(globalReviewDir, 'SKILL.md'),
      `---
name: code-review
description: "Global code review skill"
when_to_use: "Reviewing code globally"
---
# Global SOP
Do global checks.`
    );

    // 2. Create another global skill: "git-commit"
    const globalGitDir = join(globalDir, 'git-commit');
    mkdirSync(globalGitDir);
    writeFileSync(
      join(globalGitDir, 'SKILL.md'),
      `---
name: git-commit
description: "Standard git commit SOP"
---
# Git Commit SOP
Check conventional commits.`
    );

    // 3. Create a workspace skill that overrides "code-review"
    const wsReviewDir = join(workspaceSkillsDir, 'custom-review');
    mkdirSync(wsReviewDir);
    writeFileSync(
      join(wsReviewDir, 'SKILL.md'),
      `---
name: code-review
description: "Workspace-specific code review skill"
when_to_use: "Reviewing project code"
---
# Workspace SOP
Do workspace-specific lint and checks.`
    );

    const loader = new SkillLoader(workspaceDir, globalDir);
    const skills = loader.load();

    assert.equal(skills.length, 2, 'Should have exactly 2 skills loaded');

    // Verify git-commit is from global
    const gitSkill = loader.get('git-commit');
    assert.ok(gitSkill);
    assert.equal(gitSkill.source, 'global');
    assert.equal(gitSkill.description, 'Standard git commit SOP');

    // Verify code-review is overridden by workspace
    const reviewSkill = loader.get('code-review');
    assert.ok(reviewSkill);
    assert.equal(reviewSkill.source, 'workspace');
    assert.equal(reviewSkill.description, 'Workspace-specific code review skill');
    assert.equal(reviewSkill.whenToUse, 'Reviewing project code');
    assert.ok(reviewSkill.content.includes('# Workspace SOP'));

    // Verify buildPromptSection injects active skills and lists available skills
    const prompt = loader.buildPromptSection(new Set(['code-review']))!;
    assert.ok(prompt.includes('可用的 Skills'));
    assert.ok(prompt.includes('/git-commit — Standard git commit SOP'));
    assert.ok(prompt.includes('[激活的 Skill: code-review]'));
    assert.ok(prompt.includes('# Workspace SOP'));
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test('SkillLoader handles empty or missing directories gracefully', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'cheese-skills-empty-'));
  try {
    const loader = new SkillLoader(join(testRoot, 'non-existent-ws'), join(testRoot, 'non-existent-global'));
    const list = loader.load();
    assert.deepEqual(list, []);
    assert.equal(loader.buildPromptSection(new Set()), null);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
