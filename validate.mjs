import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subjects, questions, flashcards, milestones, planTasks } from './study-data.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const readJson = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const [config, example, articles, state, errors, html] = await Promise.all([
  readJson('config.json'),
  readJson('config.example.json'),
  readJson('data/articles.json'),
  readJson('data/state.json'),
  readJson('data/errors.json'),
  readFile(path.join(root, 'dashboard.html'), 'utf8')
]);

const unique = (items, label) => {
  const ids = items.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, `${label} 存在重复 ID`);
};
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

assert.ok(config.app.name?.trim(), '缺少应用名称');
assert.ok(config.app.exportPrefix?.trim(), '缺少导出前缀');
assert.ok(validDate(config.profile.examDate), '考试日期格式无效');
assert.ok(Number.isInteger(config.profile.examYear), '考试年份无效');
assert.ok(Array.isArray(config.targets) && config.targets.length, '至少需要一个目标');
unique(config.targets, '目标');
assert.ok(config.targets.some(target => target.id === config.profile.targetId), '当前目标不存在');
assert.ok(Array.isArray(config.workflow) && config.workflow.length, '至少需要一个备考阶段');
unique(config.workflow, '备考阶段');
for (const phase of config.workflow) {
  assert.ok(phase.planPhase?.trim(), '备考阶段缺少 planPhase');
  assert.ok(Number.isFinite(phase.startOffsetDays), '阶段开始偏移无效');
  assert.ok(Number.isFinite(phase.endOffsetDays), '阶段结束偏移无效');
  assert.ok(phase.startOffsetDays <= phase.endOffsetDays, '阶段起止偏移顺序无效');
}
assert.deepEqual(Object.keys(config).sort(), Object.keys(example).sort(), 'config.json 与示例的顶层结构不一致');
assert.ok(Array.isArray(articles), 'articles.json 必须是数组');
assert.ok(Array.isArray(state.seenUrls) && Array.isArray(state.titleHashes), '采集状态结构无效');
assert.ok(Array.isArray(errors.errors), '错误记录结构无效');

unique(subjects, '科目');
assert.ok(subjects.length, '至少需要一个科目');
for (const subject of subjects) {
  assert.ok(subject.name?.trim(), '科目缺少名称');
  assert.ok(Array.isArray(subject.chapters) && subject.chapters.length, `${subject.name} 缺少章节`);
}
unique(questions, '题目');
unique(flashcards, '闪卡');
for (const question of questions) {
  assert.ok(subjects.some(subject => subject.id === question.subject), `题目 ${question.id} 关联了未知科目`);
  assert.ok(['single', 'multi', 'boolean'].includes(question.type), `题目 ${question.id} 题型无效`);
  assert.ok(question.stem?.trim(), `题目 ${question.id} 缺少题干`);
  assert.ok(Array.isArray(question.options) && question.options.length >= 2, `题目 ${question.id} 选项不足`);
  assert.ok(Array.isArray(question.answer) && question.answer.length, `题目 ${question.id} 缺少答案`);
  assert.ok(question.answer.every(answer => Number.isInteger(answer) && answer >= 0 && answer < question.options.length), `题目 ${question.id} 答案越界`);
  assert.ok(question.explanation?.trim(), `题目 ${question.id} 缺少解析`);
}
unique(planTasks, '计划任务');
const phases = new Set(config.workflow.map(phase => phase.planPhase));
for (const task of planTasks) assert.ok(phases.has(task.phase), `任务 ${task.id} 关联了未知阶段`);
for (const milestone of milestones) assert.ok(Number.isFinite(milestone.offsetDays), `节点 ${milestone.id} 偏移无效`);

assert.ok(html.includes('id="view-targets"'), '仪表盘缺少择校与流程页面');
assert.ok(!html.includes('psych312-study-v1'), '仪表盘仍在使用旧存储键');
assert.ok(!/C:\\\\Users\\\\|deepseek-harness|WorkBuddy|AppData/i.test(html), '仪表盘包含本机路径');
assert.ok(!/首都师范|Capital Normal|cnu\.edu/i.test(html), '仪表盘包含个人院校信息');

console.log(`验证通过：${subjects.length} 科、${questions.length} 道题、${flashcards.length} 张闪卡、${config.targets.length} 个目标、${config.workflow.length} 个阶段。`);
