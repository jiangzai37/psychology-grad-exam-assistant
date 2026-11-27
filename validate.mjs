import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const readJson = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const [config, example, content, articles, state, errors, html] = await Promise.all([
  readJson('config.json'),
  readJson('config.example.json'),
  readJson('data/content.json'),
  readJson('data/articles.json'),
  readJson('data/state.json'),
  readJson('data/errors.json'),
  readFile(path.join(root, 'dashboard.html'), 'utf8')
]);
const { subjects, questions, flashcards, milestones, planTasks } = content;

const unique = (items, label) => {
  const ids = items.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, `${label} 存在重复 ID`);
};
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
const validUrl = value => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
};

assert.ok(config.app.name?.trim(), '缺少应用名称');
assert.ok(config.app.tagline?.trim(), '缺少应用标签');
assert.ok(config.app.description?.trim(), '缺少应用简介');
assert.ok(config.app.exportPrefix?.trim(), '缺少导出前缀');
assert.ok(config.app.brandMark?.trim(), '缺少品牌标记');
assert.match(config.app.storageKey, /^[a-z0-9][a-z0-9-]{2,39}$/, '存储键格式无效');
assert.ok(config.app.workspaceLabel?.trim(), '缺少工作台标签');
assert.ok(Number.isInteger(config.profile.examYear), '考试年份无效');
assert.ok(config.profile.examType?.trim(), '缺少考试类型');
assert.ok(config.profile.exam?.trim(), '缺少考试名称');
assert.ok(config.profile.organization?.trim(), '缺少目标机构');
assert.ok(config.profile.program?.trim(), '缺少目标项目');
assert.ok(validDate(config.profile.examDate), '考试日期格式无效');
assert.ok(validDate(config.profile.startDate), '开始日期格式无效');
assert.doesNotThrow(() => new Intl.DateTimeFormat('zh-CN', { timeZone: config.profile.timezone }).format(), '时区无效');
assert.ok(Array.isArray(config.targets) && config.targets.length, '至少需要一个目标');
unique(config.targets, '目标');
assert.ok(config.targets.some(target => target.id === config.profile.targetId), '当前目标不存在');
for (const target of config.targets) {
  assert.ok(target.organization?.trim(), `目标 ${target.id} 缺少机构`);
  assert.ok(target.program?.trim(), `目标 ${target.id} 缺少项目`);
  assert.ok(target.exam?.trim(), `目标 ${target.id} 缺少考试`);
  assert.ok(!target.officialUrl || validUrl(target.officialUrl), `目标 ${target.id} 官网地址无效`);
}
assert.ok(Array.isArray(config.workflow) && config.workflow.length, '至少需要一个备考阶段');
unique(config.workflow, '备考阶段');
for (const phase of config.workflow) {
  assert.ok(phase.name?.trim(), '备考阶段缺少名称');
  assert.ok(phase.planPhase?.trim(), '备考阶段缺少 planPhase');
  assert.ok(Number.isFinite(phase.startOffsetDays), '阶段开始偏移无效');
  assert.ok(Number.isFinite(phase.endOffsetDays), '阶段结束偏移无效');
  assert.ok(phase.startOffsetDays <= phase.endOffsetDays, '阶段起止偏移顺序无效');
  assert.ok(Array.isArray(phase.tasks), `阶段 ${phase.id} 缺少任务`);
}
assert.ok(Array.isArray(config.resourceCategories) && config.resourceCategories.length >= 4, '至少需要四类资料');
unique(config.resourceCategories, '资料分类');
assert.equal(new Set(config.resourceCategories.map(category => category.name)).size, config.resourceCategories.length, '资料分类名称重复');
for (const id of ['official', 'study', 'updates', 'resources']) {
  assert.ok(config.resourceCategories.some(category => category.id === id), `缺少资料分类角色 ${id}`);
}
const categoryNames = new Set(config.resourceCategories.map(category => category.name));
for (const source of [...config.officialSources, ...config.curatedResources]) {
  assert.ok(source.name?.trim(), '资料源缺少名称');
  assert.ok(validUrl(source.url), `资料源 ${source.name} 地址无效`);
  assert.ok(categoryNames.has(source.category), `资料源 ${source.name} 分类不存在`);
}
assert.ok(Array.isArray(config.searchQueries), '检索词必须是数组');
assert.ok(Array.isArray(config.planFiles), '计划文件必须是数组');
for (const file of config.planFiles) assert.ok(validUrl(file.url), `计划文件 ${file.name} 地址无效`);
assert.ok(config.collector.catalog, '缺少采集目录配置');
assert.ok(!config.collector.catalog.url || validUrl(config.collector.catalog.url), '采集目录地址无效');
assert.ok(Array.isArray(config.collector.catalog.programCodes), '目录代码必须是数组');
assert.ok(Array.isArray(config.collector.keywords), '采集关键词必须是数组');
assert.ok(Array.isArray(config.collector.linkKeywords), '链接关键词必须是数组');
assert.ok(Array.isArray(config.collector.excludeKeywords), '排除关键词必须是数组');
assert.ok(Array.isArray(config.collector.trustedDomains), '可信域名必须是数组');
assert.ok(validUrl(config.collector.searchEndpoint.replace('{query}', 'test')), '检索接口地址无效');
for (const key of ['requestTimeoutMs', 'delayMs', 'maxSearchResultsPerQuery', 'maxDiscoveredLinksPerSource', 'maxArticlesPerRun', 'keepRawTextChars']) {
  assert.ok(Number.isInteger(config.rules[key]) && config.rules[key] > 0, `采集规则 ${key} 无效`);
}
assert.ok(config.rules.userAgent?.trim(), '缺少采集 User-Agent');
assert.deepEqual(Object.keys(config).sort(), Object.keys(example).sort(), 'config.json 与示例的顶层结构不一致');

assert.ok(Array.isArray(articles), 'articles.json 必须是数组');
unique(articles, '资料');
for (const article of articles) {
  assert.ok(validUrl(article.url), `资料 ${article.id} 地址无效`);
  assert.ok(categoryNames.has(article.category), `资料 ${article.id} 分类不存在`);
}
assert.ok(Array.isArray(state.seenUrls) && Array.isArray(state.titleHashes), '采集状态结构无效');
assert.ok(Array.isArray(errors.errors), '错误记录结构无效');

assert.ok(Array.isArray(subjects) && subjects.length, '至少需要一个学习模块');
unique(subjects, '学习模块');
for (const subject of subjects) {
  assert.ok(subject.name?.trim(), `模块 ${subject.id} 缺少名称`);
  assert.ok(subject.group?.trim(), `模块 ${subject.id} 缺少分组`);
  assert.ok(Array.isArray(subject.chapters) && subject.chapters.length, `${subject.name} 缺少章节`);
  assert.ok(Number.isInteger(subject.order), `${subject.name} 排序无效`);
  assert.match(subject.color, /^#[0-9a-f]{6}$/i, `${subject.name} 颜色无效`);
  for (const resource of subject.resources || []) assert.ok(!resource.url || validUrl(resource.url), `${subject.name} 资料地址无效`);
}
const subjectIds = new Set(subjects.map(subject => subject.id));
assert.ok(Array.isArray(questions), '题库必须是数组');
unique(questions, '题目');
for (const question of questions) {
  assert.ok(subjectIds.has(question.subject), `题目 ${question.id} 关联了未知模块`);
  assert.ok(['single', 'multi', 'boolean'].includes(question.type), `题目 ${question.id} 题型无效`);
  assert.ok(question.stem?.trim(), `题目 ${question.id} 缺少题干`);
  assert.ok(Array.isArray(question.options) && question.options.length >= 2, `题目 ${question.id} 选项不足`);
  assert.ok(Array.isArray(question.answer) && question.answer.length, `题目 ${question.id} 缺少答案`);
  assert.ok(question.answer.every(answer => Number.isInteger(answer) && answer >= 0 && answer < question.options.length), `题目 ${question.id} 答案越界`);
  assert.equal(new Set(question.answer).size, question.answer.length, `题目 ${question.id} 答案重复`);
  if (question.type !== 'multi') assert.equal(question.answer.length, 1, `题目 ${question.id} 答案数量不符`);
  if (question.type === 'boolean') assert.equal(question.options.length, 2, `题目 ${question.id} 判断题选项必须为两项`);
  assert.ok(question.explanation?.trim(), `题目 ${question.id} 缺少解析`);
  assert.ok(question.source?.trim(), `题目 ${question.id} 缺少来源`);
  assert.ok(Number.isInteger(question.difficulty) && question.difficulty >= 1 && question.difficulty <= 3, `题目 ${question.id} 难度无效`);
}
assert.ok(Array.isArray(flashcards), '闪卡必须是数组');
unique(flashcards, '闪卡');
for (const card of flashcards) {
  assert.ok(subjectIds.has(card.subject), `闪卡 ${card.id} 关联了未知模块`);
  assert.ok(card.front?.trim(), `闪卡 ${card.id} 缺少正面`);
  assert.ok(card.back?.trim(), `闪卡 ${card.id} 缺少背面`);
  assert.ok(card.source?.trim(), `闪卡 ${card.id} 缺少来源`);
}
assert.ok(Array.isArray(milestones), '节点必须是数组');
unique(milestones, '节点');
for (const milestone of milestones) {
  assert.ok(milestone.title?.trim(), `节点 ${milestone.id} 缺少标题`);
  assert.ok(Number.isFinite(milestone.offsetDays), `节点 ${milestone.id} 偏移无效`);
}
assert.ok(Array.isArray(planTasks), '计划任务必须是数组');
unique(planTasks, '计划任务');
const phases = new Set(config.workflow.map(phase => phase.planPhase));
for (const task of planTasks) {
  assert.ok(phases.has(task.phase), `任务 ${task.id} 关联了未知阶段`);
  assert.ok(!task.subject || subjectIds.has(task.subject), `任务 ${task.id} 关联了未知模块`);
  assert.ok(task.title?.trim(), `任务 ${task.id} 缺少标题`);
}
for (const phase of phases) assert.ok(planTasks.some(task => task.phase === phase), `阶段 ${phase} 没有计划任务`);

const embedded = html.match(/<script id="dashboard-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
assert.ok(embedded, '仪表盘缺少内嵌数据');
const payload = JSON.parse(embedded);
assert.deepEqual(payload.app, config.app, '生成页面中的应用配置不是最新');
assert.deepEqual(payload.profile, config.profile, '生成页面中的考试配置不是最新');
assert.deepEqual(payload.targets, config.targets, '生成页面中的目标不是最新');
assert.deepEqual(payload.workflow, config.workflow, '生成页面中的阶段不是最新');
assert.deepEqual(payload.categories, config.resourceCategories.map(category => category.name), '生成页面中的资料分类不是最新');
assert.deepEqual(payload.subjects, subjects, '生成页面中的学习模块不是最新');
assert.deepEqual(payload.questions, questions, '生成页面中的题库不是最新');
assert.deepEqual(payload.flashcards, flashcards, '生成页面中的闪卡不是最新');
assert.deepEqual(payload.planTasks, planTasks, '生成页面中的计划任务不是最新');
assert.equal(payload.milestones.length, milestones.length, '生成页面中的节点数量不一致');
assert.ok(html.includes('id="view-targets"'), '仪表盘缺少目标与规划页面');
assert.ok(html.includes('data/content.json'), '仪表盘缺少学习内容入口');
assert.ok(html.includes('question-source'), '仪表盘缺少题目来源');
assert.ok(html.includes('flash-source'), '仪表盘缺少闪卡来源');
assert.ok(html.includes(config.app.storageKey), '仪表盘未使用配置的存储键');
assert.ok(!html.includes('psychology-exam-theme'), '仪表盘仍在使用旧主题存储键');
assert.ok(!html.includes('psychology-exam-study-v1'), '仪表盘仍在使用旧学习存储键');

async function publicTextFiles(directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.qa', '.edge-test-profile', '.chrome-test-profile'].includes(entry.name) || entry.name.startsWith('.test-')) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await publicTextFiles(fullPath));
    else if (entry.isFile() && /\.(?:json|mjs|html|md)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}
const files = await publicTextFiles();
const personalDataPattern = /C:\\Users\\|deepseek-harness|WorkBuddy|AppData|首都师范|Capital Normal|cnu\.edu|psych312-study-v1/i;
const secretPattern = /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
for (const file of files) {
  if (file.endsWith(`${path.sep}validate.mjs`)) continue;
  const text = await readFile(file, 'utf8');
  assert.ok(!personalDataPattern.test(text), `公开文件包含个人痕迹：${path.relative(root, file)}`);
  assert.ok(!secretPattern.test(text), `公开文件疑似包含凭证：${path.relative(root, file)}`);
}
const genericFiles = [
  'config.json',
  'config.example.json',
  'data/content.json',
  'build-dashboard.mjs',
  'collect.mjs',
  'dashboard.html',
  ...files.filter(file => file.startsWith(path.join(root, 'knowledge-base'))).map(file => path.relative(root, file))
];
const legacyContentPattern = /心理学|040200|312\s*专业|彭聃龄|郭秀艳|张厚粲|戴海崎|林崇德|陈琦|侯玉波|肖四|肖八|考研政治|考研英语/i;
for (const file of [...new Set(genericFiles)]) {
  const text = await readFile(path.join(root, file), 'utf8');
  assert.ok(!legacyContentPattern.test(text), `通用版仍包含旧内容：${file}`);
}

console.log(`验证通过：${subjects.length} 个模块、${questions.length} 道题、${flashcards.length} 张闪卡、${config.targets.length} 个目标、${config.workflow.length} 个阶段。`);
