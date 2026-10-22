#!/usr/bin/env node
/**
 * 端到端演练：用真实的 DSH 会话，导到一个**临时**的假 WorkBuddy 家目录。
 *
 * 不碰 ~/.workbuddy 任何数据 —— WORKBUDDY_HOME 指向临时目录，
 * 假库里只有一张按真实 schema 建的 sessions 表。
 *
 * 用法：
 *   node scripts/dryrun-export.mjs [会话id或标题片段] [--write]
 *     默认 dry-run，只看计划；加 --write 才真的写进临时目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listDshConversations, loadDshConversation } from '../lib/host/dsh-source.js';
import * as workbuddySink from '../lib/host/sinks/workbuddy.js';

const argv = process.argv.slice(2);
const doWrite = argv.includes('--write');
const needle = argv.find((arg) => !arg.startsWith('--')) ?? '';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-export-dryrun-'));
const fakeHome = path.join(root, 'workbuddy');
fs.mkdirSync(path.join(fakeHome, 'projects'), { recursive: true });

// Fake index with the real schema (trimmed to the columns the sink touches).
const db = new DatabaseSync(path.join(fakeHome, 'workbuddy.db'));
db.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT,
    custom_title TEXT, status TEXT NOT NULL DEFAULT 'completed',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
    is_playground INTEGER NOT NULL DEFAULT 0, source_mode TEXT,
    is_background_automation INTEGER, model TEXT, expert_id TEXT, expert_locale TEXT,
    expert_runtime_identity TEXT, last_activity_at INTEGER, expert_marketplace TEXT,
    permission_mode TEXT, use_sandbox_cli INTEGER, project_id TEXT, mode TEXT,
    plugin_context_json TEXT, addon_selection TEXT, session_settings TEXT,
    last_user_prompt_expert_selection TEXT, context_window INTEGER, buddy_snapshot_id TEXT,
    buddy_binding_json TEXT, thought_level TEXT, transport TEXT NOT NULL DEFAULT 'local',
    conversation_origin TEXT, visibility TEXT, group_id TEXT, group_title TEXT,
    agent_dirty INTEGER, agent_dirty_at INTEGER, agent_last_synced INTEGER,
    verified_at INTEGER, unread INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL);
  INSERT INTO sessions (id, cwd, user_id, title, created_at, updated_at)
    VALUES ('seed', 'C:/seed', 'user-seed', '假库种子会话', 1, 1);
`);
db.close();

process.env.WORKBUDDY_HOME = path.join(fakeHome, 'projects');

console.log(`临时 WorkBuddy 家目录：${fakeHome}`);
console.log(`真实 DSH 会话目录    ：${process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')}\n`);

const all = listDshConversations();
console.log(`DSH 会话总数：${all.length}`);
const pick = needle === '' ? all[0] : all.find((row) => row.id.includes(needle) || row.title.includes(needle));
if (pick === undefined) {
  console.error(`没有匹配「${needle}」的会话`);
  process.exit(1);
}
console.log(`\n选中的会话：${pick.title}`);
console.log(`  id      : ${pick.id}`);
console.log(`  cwd     : ${pick.cwd}`);
console.log(`  消息    : ${pick.messageCount} 轮`);
console.log(`  最后活动: ${new Date(pick.updatedAt).toLocaleString('zh-CN')}`);

const conversation = loadDshConversation(pick.id);
const toolCalls = conversation.turns.reduce(
  (n, turn) => n + turn.runs.reduce((m, run) => m + run.blocks.filter((b) => b.type === 'tool-call').length, 0),
  0,
);
const toolResults = conversation.turns.reduce(
  (n, turn) => n + turn.runs.reduce((m, run) => m + run.toolResults.length, 0),
  0,
);
console.log(`\n标准化结果：${conversation.turns.length} 轮 / 工具调用 ${toolCalls} / 工具结果 ${toolResults}`);
if (toolCalls !== toolResults) console.log('⚠ 工具调用与结果数量不一致');
for (const note of conversation.notes ?? []) console.log(`  注：${note}`);

const status = await workbuddySink.status();
console.log(`\n目标状态：available=${status.available}  ${status.location}`);

const plan = await workbuddySink.write(conversation, {
  dryRun: !doWrite,
  // WorkBuddy 只认 UUID 形态的会话 id，这里给一个固定的 UUID 便于重复演练。
  sessionId: '0f0e9d1c-1a2b-4c3d-9e8f-7a6b5c4d3e2f',
  force: true,
  cwd: conversation.cwd ?? undefined,
});
console.log('\n导出计划：');
console.log(`  目标项目 : ${plan.project}`);
console.log(`  目标文件 : ${plan.target}`);
console.log(`  将写入   : ${plan.rows} 行（其中消息 ${plan.messages} 条）`);
console.log(`  模式     : ${plan.mode}`);
for (const note of plan.notes ?? []) console.log(`  注：${note}`);

if (!doWrite) {
  console.log('\n[DRY-RUN] 未写入。加 --write 可写入临时目录验证。');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
}

console.log('\n写入结果：');
console.log(`  ok       : ${plan.ok}`);
console.log(`  bytes    : ${plan.bytes}`);
console.log(`  备份     : ${plan.backupPath ?? '(无，首次创建)'}`);
console.log(`  库备份   : ${plan.dbBackupPath}`);

// Read back through the *provider* (the import direction) to prove symmetry.
const provider = await import('../lib/host/providers/workbuddy.js');
const back = await provider.load('0f0e9d1c-1a2b-4c3d-9e8f-7a6b5c4d3e2f');
const backCalls = back.turns.reduce(
  (n, turn) => n + turn.runs.reduce((m, run) => m + run.blocks.filter((b) => b.type === 'tool-call').length, 0),
  0,
);
console.log('\n回读校验（用导入方向自己的 provider 读回来）：');
console.log(`  标题     : ${back.title}`);
console.log(`  轮数     : ${back.turns.length}（源 ${conversation.turns.length}）`);
console.log(`  工具调用 : ${backCalls}（源 ${toolCalls}）`);
console.log(`  用户消息 : ${back.turns.filter((t) => t.user !== null).length}`);
console.log(`\n临时目录保留供查看：${root}`);
