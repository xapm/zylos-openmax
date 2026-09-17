import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readIndex, upsertConnection, removeConnection, replaceIndexFromList, findConnectionByApp,
  findActiveConnectionsByApp,
  readCatalog, writeCatalog, invalidateCatalog, catalogPath, indexPathForOrg,
} from './connect-store.js';

function tmpIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-idx-'));
  return path.join(dir, 'connections-index.json');
}
function tmpCatalogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'connect-cat-'));
}

// --- connections index ------------------------------------------------------

test('缺失索引文件读出空结构，不抛错', () => {
  const idx = tmpIndex();
  assert.deepEqual(readIndex(idx), { connections: {} });
});

test('upsert 后可按 slug 与 applicationId 反查到连接', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c1', application_id: 'app-1', application_slug: 'notion', status: 'active' }, idx);
  assert.equal(findConnectionByApp('notion', idx)?.id, 'c1');
  assert.equal(findConnectionByApp('app-1', idx)?.id, 'c1');
  assert.equal(findConnectionByApp('nope', idx), null);
});

test('upsert 叠加填充：稀疏事件先写、后续富记录补 application_id 且不清空已知值', () => {
  const idx = tmpIndex();
  // 事件来源：只有 connection_id + slug（provider），没有 application_id
  upsertConnection({ connection_id: 'c1', provider: 'notion', status: 'active' }, idx);
  assert.equal(readIndex(idx).connections.c1.applicationId, null);
  // conn.list 富记录补上 application_id
  upsertConnection({ connection_id: 'c1', application_id: 'app-1', application_slug: 'notion', application_name: 'Notion', status: 'active' }, idx);
  const e = readIndex(idx).connections.c1;
  assert.equal(e.applicationId, 'app-1');
  assert.equal(e.name, 'Notion');
  // 再来一条稀疏事件不应把 application_id 清回 null
  upsertConnection({ connection_id: 'c1', provider: 'notion', status: 'active' }, idx);
  assert.equal(readIndex(idx).connections.c1.applicationId, 'app-1');
});

test('findConnectionByApp 优先返回 active 的连接', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c-old', application_slug: 'x', status: 'revoked' }, idx);
  upsertConnection({ connection_id: 'c-new', application_slug: 'x', status: 'active' }, idx);
  assert.equal(findConnectionByApp('x', idx)?.id, 'c-new');
});

test('removeConnection 幂等，撤销后反查不到', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c1', application_slug: 'notion', status: 'active' }, idx);
  assert.equal(removeConnection('c1', idx), true);
  assert.equal(removeConnection('c1', idx), false); // 幂等
  assert.equal(findConnectionByApp('notion', idx), null);
});

test('replaceIndexFromList 整体重建（conn.list 权威刷新）', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'stale', application_slug: 'gone', status: 'active' }, idx);
  replaceIndexFromList([
    { id: 'c1', application_id: 'app-1', application_slug: 'notion', application_name: 'Notion', status: 'active' },
    { id: 'c2', application_id: 'app-2', application_slug: 'x_twitter', status: 'active' },
  ], idx);
  const index = readIndex(idx);
  assert.equal(Object.keys(index.connections).length, 2);
  assert.equal(findConnectionByApp('gone', idx), null); // 旧的被清掉
  assert.equal(findConnectionByApp('notion', idx)?.id, 'c1');
});

test('index 按 org 隔离：不同 org 的同 slug 连接互不串（多 org 防串关键）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-org-'));
  const orgA = indexPathForOrg('org-a', dir);
  const orgB = indexPathForOrg('org-b', dir);
  upsertConnection({ connection_id: 'cA', application_slug: 'notion', status: 'active' }, orgA);
  upsertConnection({ connection_id: 'cB', application_slug: 'notion', status: 'active' }, orgB);
  // 各自查各自的文件，拿到本 org 的连接，不会串到另一个 org
  assert.equal(findConnectionByApp('notion', orgA)?.id, 'cA');
  assert.equal(findConnectionByApp('notion', orgB)?.id, 'cB');
  // 两个不同的物理文件
  assert.notEqual(orgA, orgB);
});

// --- display_name capture (multi-connection disambiguation) -----------------

test('toEntry 捕获 display_name（连接的用户命名，区别于应用名 name）', () => {
  const idx = tmpIndex();
  upsertConnection(
    { connection_id: 'c1', application_id: 'app-1', application_slug: 'gmail', application_name: 'Gmail', display_name: '工作邮箱', status: 'active' },
    idx,
  );
  const e = readIndex(idx).connections.c1;
  assert.equal(e.name, 'Gmail');          // 应用名
  assert.equal(e.displayName, '工作邮箱'); // 连接的用户命名
});

test('replaceIndexFromList 整体重建也捕获 display_name（走 toEntry）', () => {
  const idx = tmpIndex();
  replaceIndexFromList([
    { id: 'c1', application_id: 'app-1', application_slug: 'gmail', application_name: 'Gmail', display_name: '工作邮箱', status: 'active' },
    { id: 'c2', application_id: 'app-1', application_slug: 'gmail', application_name: 'Gmail', displayName: '个人邮箱', status: 'active' },
  ], idx);
  assert.equal(readIndex(idx).connections.c1.displayName, '工作邮箱');
  assert.equal(readIndex(idx).connections.c2.displayName, '个人邮箱'); // camelCase 别名也认
});

test('upsert 叠加：稀疏事件（只带 slug）不清空已知 display_name', () => {
  const idx = tmpIndex();
  upsertConnection(
    { connection_id: 'c1', application_id: 'app-1', application_slug: 'gmail', display_name: '工作邮箱', status: 'active' },
    idx,
  );
  assert.equal(readIndex(idx).connections.c1.displayName, '工作邮箱');
  // 后续只带 slug 的授权事件（无 display_name）不得把名字冲成 null
  upsertConnection({ connection_id: 'c1', provider: 'gmail', status: 'active' }, idx);
  assert.equal(readIndex(idx).connections.c1.displayName, '工作邮箱');
});

test('toEntry 保留 createdAt（用于空/重名连接的兜底标签）', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c1', application_slug: 'gmail', created_at: '2026-01-05T10:00:00Z', status: 'active' }, idx);
  assert.equal(readIndex(idx).connections.c1.createdAt, '2026-01-05T10:00:00Z');
  // camelCase 别名也认，且叠加：稀疏事件不清空已知 createdAt
  upsertConnection({ connection_id: 'c1', provider: 'gmail', status: 'active' }, idx);
  assert.equal(readIndex(idx).connections.c1.createdAt, '2026-01-05T10:00:00Z');
});

// --- connector taxonomy: credentialMode（credentialSource 已彻底移除）---------

test('toEntry 捕获 credentialMode（direct 与 proxy 都认），且不再写入 credentialSource', () => {
  const idx = tmpIndex();
  upsertConnection(
    { connection_id: 'c1', application_slug: 'gmail', credential_mode: 'direct', credential_source: 'managed', status: 'active' },
    idx,
  );
  upsertConnection(
    { connection_id: 'c2', application_slug: 'notion', credential_mode: 'proxy', credential_source: 'composio', status: 'active' },
    idx,
  );
  const a = readIndex(idx).connections.c1;
  const b = readIndex(idx).connections.c2;
  assert.equal(a.credentialMode, 'direct');
  assert.equal(b.credentialMode, 'proxy');
  // credential_source 即便在入参里出现，也绝不落入索引条目
  assert.ok(!('credentialSource' in a));
  assert.ok(!('credentialSource' in b));
});

test('toEntry 缺 credentialMode → null（不臆造）', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c1', application_slug: 'gmail', status: 'active' }, idx);
  const e = readIndex(idx).connections.c1;
  assert.equal(e.credentialMode, null);
  assert.ok(!('credentialSource' in e));
});

test('upsert 叠加：稀疏事件（无 credential_mode）不清空已知的 proxy', () => {
  const idx = tmpIndex();
  upsertConnection(
    { connection_id: 'c1', application_id: 'app-1', application_slug: 'notion', credential_mode: 'proxy', status: 'active' },
    idx,
  );
  assert.equal(readIndex(idx).connections.c1.credentialMode, 'proxy');
  // 后续只带 slug 的事件不得把分类冲成 null
  upsertConnection({ connection_id: 'c1', provider: 'notion', status: 'active' }, idx);
  assert.equal(readIndex(idx).connections.c1.credentialMode, 'proxy');
  assert.ok(!('credentialSource' in readIndex(idx).connections.c1));
});

test('replaceIndexFromList 整体重建也捕获 credentialMode（走 toEntry），不写 credentialSource', () => {
  const idx = tmpIndex();
  replaceIndexFromList([
    { id: 'c1', application_id: 'app-1', application_slug: 'gmail', credential_mode: 'direct', credential_source: 'managed', status: 'active' },
    { id: 'c2', application_id: 'app-2', application_slug: 'notion', credentialMode: 'proxy', credentialSource: 'composio', status: 'active' },
  ], idx);
  assert.equal(readIndex(idx).connections.c1.credentialMode, 'direct');
  // camelCase 别名也认
  assert.equal(readIndex(idx).connections.c2.credentialMode, 'proxy');
  assert.ok(!('credentialSource' in readIndex(idx).connections.c1));
  assert.ok(!('credentialSource' in readIndex(idx).connections.c2));
});

// --- connector taxonomy: connectorKind（Route A：MCP 分流字段）----------------

test('toEntry 捕获 connectorKind（mcp 与 http 都认，含 camelCase 别名），缺省为 null', () => {
  const idx = tmpIndex();
  upsertConnection(
    { connection_id: 'c1', application_slug: 'linear', connector_kind: 'mcp', credential_mode: 'direct', status: 'active' },
    idx,
  );
  upsertConnection(
    { connection_id: 'c2', application_slug: 'gmail', connectorKind: 'http', credential_mode: 'direct', status: 'active' },
    idx,
  );
  upsertConnection({ connection_id: 'c3', application_slug: 'notion', status: 'active' }, idx);
  assert.equal(readIndex(idx).connections.c1.connectorKind, 'mcp');
  assert.equal(readIndex(idx).connections.c2.connectorKind, 'http'); // camelCase 别名也认
  assert.equal(readIndex(idx).connections.c3.connectorKind, null);   // 缺省不臆造
});

test('upsert 叠加：稀疏事件（无 connector_kind）不清空已知的 mcp（撤销/reauth 拆除路径依赖它）', () => {
  const idx = tmpIndex();
  upsertConnection(
    { connection_id: 'c1', application_id: 'app-1', application_slug: 'linear', connector_kind: 'mcp', credential_mode: 'direct', status: 'active' },
    idx,
  );
  assert.equal(readIndex(idx).connections.c1.connectorKind, 'mcp');
  // 后续只带 slug 的事件（如 credential_updated / revoke，均不带 connector_kind）不得冲成 null
  upsertConnection({ connection_id: 'c1', provider: 'linear', status: 'active' }, idx);
  assert.equal(readIndex(idx).connections.c1.connectorKind, 'mcp');
});

test('replaceIndexFromList 整体重建也捕获 connectorKind（走 toEntry）', () => {
  const idx = tmpIndex();
  replaceIndexFromList([
    { id: 'c1', application_id: 'app-1', application_slug: 'linear', connector_kind: 'mcp', credential_mode: 'direct', status: 'active' },
    { id: 'c2', application_id: 'app-2', application_slug: 'gmail', connectorKind: 'http', credential_mode: 'direct', status: 'active' },
  ], idx);
  assert.equal(readIndex(idx).connections.c1.connectorKind, 'mcp');
  assert.equal(readIndex(idx).connections.c2.connectorKind, 'http');
});

// --- replaceIndexFromList 孤儿剪枝（全量刷新纠正本地索引）---------------------

test('replaceIndexFromList 剪除孤儿条目（slug 与 credentialMode 皆 null），保留 direct/proxy', () => {
  const idx = tmpIndex();
  replaceIndexFromList([
    // direct 条目 → 保留
    { id: 'c-direct', application_id: 'app-1', application_slug: 'gmail', credential_mode: 'direct', status: 'active' },
    // proxy 条目 → 保留
    { id: 'c-proxy', application_id: 'app-2', application_slug: 'notion', credential_mode: 'proxy', status: 'active' },
    // 孤儿：app 无法解析且分类未知 → 剪除
    { id: 'c-orphan', status: 'active' },
  ], idx);
  const index = readIndex(idx);
  assert.equal(Object.keys(index.connections).length, 2);
  assert.ok(index.connections['c-direct']);
  assert.ok(index.connections['c-proxy']);
  assert.equal(index.connections['c-orphan'], undefined);
});

test('replaceIndexFromList 仅有 slug（无 credentialMode）不算孤儿，保留', () => {
  const idx = tmpIndex();
  replaceIndexFromList([
    { id: 'c1', application_slug: 'gmail', status: 'active' },
  ], idx);
  assert.ok(readIndex(idx).connections.c1);
});

test('replaceIndexFromList 仅有 credentialMode（无 slug）不算孤儿，保留', () => {
  const idx = tmpIndex();
  replaceIndexFromList([
    { id: 'c1', application_id: 'app-1', credential_mode: 'proxy', status: 'active' },
  ], idx);
  assert.ok(readIndex(idx).connections.c1);
});

test('replaceIndexFromList 全量重建剪除孤儿的同时也丢弃过期条目', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'stale', application_slug: 'gone', credential_mode: 'direct', status: 'active' }, idx);
  replaceIndexFromList([
    { id: 'c1', application_id: 'app-1', application_slug: 'notion', credential_mode: 'direct', status: 'active' },
    { id: 'c-orphan', status: 'active' },
  ], idx);
  const index = readIndex(idx);
  assert.equal(Object.keys(index.connections).length, 1); // stale 丢弃 + orphan 剪除
  assert.ok(index.connections.c1);
  assert.equal(index.connections.stale, undefined);
});

// --- reauth normalization (invoke guard depends on it) ----------------------

test('toEntry 规范化 error+needs_reauth → status:needs_reauth（被 invoke 守卫拦截）', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c1', application_slug: 'gmail', status: 'error', needs_reauth: true }, idx);
  assert.equal(readIndex(idx).connections.c1.status, 'needs_reauth');
  // 规范化后不再是 active，绝不作为静默候选
  assert.deepEqual(findActiveConnectionsByApp('gmail', idx), []);
});

test('toEntry 规范化裸 needs_reauth 标志（无 error status）→ needs_reauth', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c1', application_slug: 'gmail', status: 'active', needsReauth: true }, idx);
  assert.equal(readIndex(idx).connections.c1.status, 'needs_reauth');
});

test('replaceIndexFromList 回填也规范化 needs_reauth（list/backfill 刷新路径）', () => {
  const idx = tmpIndex();
  replaceIndexFromList([
    { id: 'c1', application_id: 'app-1', application_slug: 'gmail', status: 'error', needs_reauth: true },
    { id: 'c2', application_id: 'app-1', application_slug: 'gmail', status: 'active' },
  ], idx);
  assert.equal(readIndex(idx).connections.c1.status, 'needs_reauth');
  // 只有真正 active 的进入候选
  const actives = findActiveConnectionsByApp('gmail', idx);
  assert.equal(actives.length, 1);
  assert.equal(actives[0].id, 'c2');
});

// --- findActiveConnectionsByApp (0/1/>1 discrimination) ----------------------

test('findActiveConnectionsByApp 返回该 app 的全部 active（多连接消歧的数据源）', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c1', application_slug: 'gmail', display_name: '工作邮箱', status: 'active' }, idx);
  upsertConnection({ connection_id: 'c2', application_slug: 'gmail', display_name: '个人邮箱', status: 'active' }, idx);
  const actives = findActiveConnectionsByApp('gmail', idx);
  assert.equal(actives.length, 2);
  assert.deepEqual(actives.map((e) => e.id).sort(), ['c1', 'c2']);
});

test('findActiveConnectionsByApp 排除非 active（needs_reauth/revoked 不作候选）', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c1', application_slug: 'gmail', status: 'active' }, idx);
  upsertConnection({ connection_id: 'c2', application_slug: 'gmail', status: 'needs_reauth' }, idx);
  upsertConnection({ connection_id: 'c3', application_slug: 'gmail', status: 'revoked' }, idx);
  const actives = findActiveConnectionsByApp('gmail', idx);
  assert.equal(actives.length, 1);
  assert.equal(actives[0].id, 'c1');
});

test('findActiveConnectionsByApp 支持按 applicationId 查，无匹配返回空数组', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c1', application_id: 'app-1', application_slug: 'gmail', status: 'active' }, idx);
  assert.equal(findActiveConnectionsByApp('app-1', idx).length, 1);
  assert.deepEqual(findActiveConnectionsByApp('nope', idx), []);
  assert.deepEqual(findActiveConnectionsByApp('', idx), []);
});

// --- action catalog ---------------------------------------------------------

test('写入后可读回动作目录，带 fetchedAt', () => {
  const dir = tmpCatalogDir();
  const actions = [{ toolkit: 'notion-pages', action: 'notion-pages/create', method: 'POST', input_schema: '{}' }];
  writeCatalog('app-1', actions, { dir, now: 1000 });
  const rec = readCatalog('app-1', { dir });
  assert.equal(rec.applicationId, 'app-1');
  assert.equal(rec.fetchedAt, 1000);
  assert.equal(rec.actions.length, 1);
  assert.equal(rec.actions[0].action, 'notion-pages/create');
});

test('缺失/损坏目录读出 null', () => {
  const dir = tmpCatalogDir();
  assert.equal(readCatalog('missing', { dir }), null);
  fs.writeFileSync(catalogPath('broken', dir), '{ not json');
  assert.equal(readCatalog('broken', { dir }), null);
});

test('TTL 过期视为 miss（返回 null），未过期正常返回', () => {
  const dir = tmpCatalogDir();
  writeCatalog('app-1', [{ action: 'a' }], { dir, now: 1000 });
  // now=1000+5000, ttl=10000 → 新鲜
  assert.ok(readCatalog('app-1', { dir, ttlMs: 10000, now: 6000 }));
  // now=1000+20000, ttl=10000 → 过期
  assert.equal(readCatalog('app-1', { dir, ttlMs: 10000, now: 21000 }), null);
});

test('invalidateCatalog 幂等删除', () => {
  const dir = tmpCatalogDir();
  writeCatalog('app-1', [{ action: 'a' }], { dir });
  assert.equal(invalidateCatalog('app-1', dir), true);
  assert.equal(readCatalog('app-1', { dir }), null);
  assert.equal(invalidateCatalog('app-1', dir), false); // 幂等
});
