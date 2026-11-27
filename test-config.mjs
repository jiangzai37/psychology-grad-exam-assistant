import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoot = await mkdtemp(path.join(root, '.test-config-'));

try {
  await cp(path.join(root, 'build-dashboard.mjs'), path.join(temporaryRoot, 'build-dashboard.mjs'));
  await cp(path.join(root, 'config.json'), path.join(temporaryRoot, 'config.json'));
  await cp(path.join(root, 'data'), path.join(temporaryRoot, 'data'), { recursive: true });

  const config = JSON.parse(await readFile(path.join(temporaryRoot, 'config.json'), 'utf8'));
  config.app.name = '自定义考试台';
  config.app.storageKey = 'custom-exam';
  config.profile.exam = '示例水平考试';
  config.profile.organization = '示例机构';
  config.resourceCategories.find(category => category.id === 'study').name = '自定义知识';
  await writeFile(path.join(temporaryRoot, 'config.json'), JSON.stringify(config, null, 2));

  const content = JSON.parse(await readFile(path.join(temporaryRoot, 'data/content.json'), 'utf8'));
  content.subjects[0].name = '自定义模块';
  content.subjects[0].group = '自定义分组';
  content.subjects.push({
    ...content.subjects[0],
    id: 'custom-subject',
    name: '新增模块',
    short: '新增',
    order: content.subjects.length + 1,
    chapters: ['新增章节']
  });
  content.questions.push({
    id: 'custom-question',
    subject: 'custom-subject',
    type: 'boolean',
    stem: '新增模块是否可以正常构建？',
    options: ['正确', '错误'],
    answer: [0],
    explanation: '这是配置化构建测试。',
    difficulty: 1,
    source: '原创测试示例'
  });
  content.flashcards.push({
    id: 'custom-card',
    subject: 'custom-subject',
    front: '新增模块',
    back: '可以正常构建。',
    source: '原创测试示例'
  });
  await writeFile(path.join(temporaryRoot, 'data/content.json'), JSON.stringify(content, null, 2));

  await run(process.execPath, ['build-dashboard.mjs'], { cwd: temporaryRoot });
  const html = await readFile(path.join(temporaryRoot, 'dashboard.html'), 'utf8');
  const embedded = html.match(/<script id="dashboard-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(embedded, '自定义构建缺少内嵌数据');
  const payload = JSON.parse(embedded);
  assert.equal(payload.app.name, '自定义考试台');
  assert.equal(payload.app.storageKey, 'custom-exam');
  assert.equal(payload.profile.exam, '示例水平考试');
  assert.equal(payload.profile.organization, '示例机构');
  assert.ok(payload.categories.includes('自定义知识'));
  assert.ok(payload.subjects.some(subject => subject.id === 'custom-subject'));
  assert.ok(payload.questions.some(question => question.id === 'custom-question'));
  assert.ok(payload.flashcards.some(card => card.id === 'custom-card'));
  assert.ok(html.includes('自定义分组'));
  assert.ok(html.includes('custom-exam-theme'));
  console.log('配置化构建通过：考试信息、资料分类、科目分组、科目、题目和闪卡均可独立替换。');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
