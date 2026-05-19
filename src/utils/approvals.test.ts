import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { appendApproval, isAlreadyApproved } from './approvals.js';
import type { ApprovalRecord } from '../types.js';

function tmpDataRoot(): string {
  return path.join(tmpdir(), randomUUID());
}

function makeRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    reportId: 'rep12345',
    clientId: 'test-client',
    topName: 'Жанель',
    chatId: 12345,
    approvedAt: '2026-05-19T10:00:00.000Z',
    status: 'approved',
    ...overrides,
  };
}

describe('appendApproval', () => {
  it('creates directory and file if they do not exist', async () => {
    const root = tmpDataRoot();
    const record = makeRecord({ clientId: 'newclient' });
    await appendApproval(record, root);
    const filePath = path.join(root, 'newclient', 'approvals.jsonl');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content.trim()).toBe(JSON.stringify(record));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('appends two records as separate lines', async () => {
    const root = tmpDataRoot();
    const r1 = makeRecord({ reportId: 'aaa' });
    const r2 = makeRecord({ reportId: 'bbb' });
    await appendApproval(r1, root);
    await appendApproval(r2, root);
    const filePath = path.join(root, 'test-client', 'approvals.jsonl');
    const lines = (await fs.readFile(filePath, 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ reportId: 'aaa' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ reportId: 'bbb' });
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('isAlreadyApproved', () => {
  it('returns false when file does not exist', async () => {
    const root = tmpDataRoot();
    const result = await isAlreadyApproved('nonexistent', 'rep12345', root);
    expect(result).toBe(false);
  });

  it('returns true when reportId is found', async () => {
    const root = tmpDataRoot();
    await appendApproval(makeRecord({ reportId: 'target' }), root);
    const result = await isAlreadyApproved('test-client', 'target', root);
    expect(result).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns false for a different reportId', async () => {
    const root = tmpDataRoot();
    await appendApproval(makeRecord({ reportId: 'other' }), root);
    const result = await isAlreadyApproved('test-client', 'target', root);
    expect(result).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not throw on corrupt line — returns false for it, true for valid line', async () => {
    const root = tmpDataRoot();
    const filePath = path.join(root, 'test-client', 'approvals.jsonl');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      'NOT_JSON\n' + JSON.stringify(makeRecord({ reportId: 'valid' })) + '\n',
      'utf8',
    );
    const found = await isAlreadyApproved('test-client', 'valid', root);
    expect(found).toBe(true);
    const notFound = await isAlreadyApproved('test-client', 'corrupt', root);
    expect(notFound).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });
});
