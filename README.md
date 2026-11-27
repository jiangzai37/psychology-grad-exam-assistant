# 备考学习台

本地优先、无登录、可配置的通用考试备考与目标管理平台。适合作为模板，替换成自己的考试目标、学习模块、题库、闪卡、计划任务和资料来源，再发布为自己的版本。

仓库中的 24 道题、16 张闪卡和 4 个学习模块均为原创通用示例，不对应任何特定考试或院校。

## 功能

- 多目标管理与当前目标切换。
- 可配置的备考阶段、关键节点和计划任务。
- 学习模块、章节进度、单选、多选和判断题。
- 来源标注、错题本、闪卡翻面与掌握状态。
- 番茄钟、每日打卡、学习笔记和手动补记。
- 学习档案、趋势图、热力图、周复盘、科目正确率和薄弱点分析。
- 学习成绩单 PNG、学习记录 CSV、JSON 备份与恢复。
- 公开资料采集、分类检索、收藏和已读管理。
- 浅色与黑夜模式，桌面和手机布局。

学习记录只保存在当前浏览器的 `localStorage`，不会自动上传。采集到的公开资料保存在本地文件中。

## 快速开始

需要 Node.js 20 或更高版本，无需安装第三方依赖。

```bash
npm run build
```

直接用浏览器打开生成的 `dashboard.html`。`npm start` 与构建命令相同，不会启动 Web 服务器。

修改配置或内容后运行：

```bash
npm test
```

测试会检查配置引用、题库答案、来源标注、生成页面是否最新，并在临时目录中验证考试信息、资料分类、科目分组、科目、题目和闪卡的替换构建。

## 一、配置考试与目标

编辑 `config.json`。`config.example.json` 提供相同的结构参考。

| 配置 | 用途 |
| --- | --- |
| `app` | 名称、标签、简介、导出文件前缀、品牌字、浏览器存储键和工作台名称 |
| `profile` | 考试年份、类型、机构、项目代码、考试科目、考试日期、时区、当前目标和提示 |
| `targets` | 目标清单；可保留一个，也可增加多个 |
| `workflow` | 阶段名称、说明、相对考试日的起止偏移和阶段目标 |
| `resourceCategories` | 资料分类的稳定 ID、显示名称、图标和色调 |
| `officialSources` | 官方栏目地址与分类 |
| `curatedResources` | 希望优先采集的公开资源 |
| `searchQueries` | 额外的检索短语 |
| `planFiles` | 总览页展示的计划文件链接 |
| `collector` | 搜索接口、关键词、信任域名、排除词和可选目录页 |
| `rules` | 请求超时、请求间隔、单次采集上限和正文长度 |

阶段日期根据 `profile.examDate` 与 `workflow.startOffsetDays`、`endOffsetDays` 自动计算。负值表示考试前，正值表示考试后。`profile.startDate` 用于学习日历起点，时区应为 IANA 时区名称，例如 `Asia/Shanghai`。

`resourceCategories` 必须保留四个稳定角色 ID：

- `official`：官方考试信息。
- `study`：学习知识与练习资料。
- `updates`：目标或机构动态。
- `resources`：经验、课程与其他资源。

可以修改显示名称，但不要随意删除或改名这些 ID，否则采集分类会失效。`icon` 支持 `landmark`、`book`、`university`、`compass`，`tone` 支持 `red`、`blue`、`green`、`amber`。

## 二、替换学习内容内核

学习内容位于 `data/content.json`，不再依赖固定科目代码。

### 学习模块 `subjects`

```json
{
  "id": "my-subject",
  "name": "我的学习模块",
  "short": "模块",
  "book": "主要资料",
  "author": "作者或资料方",
  "publisher": "出版方",
  "edition": "版本",
  "order": 1,
  "weight": "考试占比或学习权重",
  "color": "#426681",
  "soft": "#e7eef3",
  "group": "我的分组",
  "goal": "学习目标",
  "chapters": ["第一章", "第二章"],
  "resources": []
}
```

`id` 是内部关联键，创建后应保持稳定。`group` 会自动生成科目分组标签；为空时归入默认分组。题目、闪卡和计划任务都通过模块 `id` 关联。

### 题库 `questions`

```json
{
  "id": "my-question-1",
  "subject": "my-subject",
  "type": "single",
  "stem": "题干",
  "options": ["选项 A", "选项 B"],
  "answer": [0],
  "explanation": "解析",
  "difficulty": 1,
  "source": "资料来源或原创说明"
}
```

- `type` 支持 `single`、`multi`、`boolean`。
- `answer` 始终是从 0 开始的选项下标数组；单选题和判断题只有一个下标，多选题可有多个。
- `difficulty` 为 1、2 或 3。
- `source` 必填，用于显示题目来源，不应填写个人隐私信息。

### 闪卡 `flashcards`

```json
{
  "id": "my-card-1",
  "subject": "my-subject",
  "front": "正面提示",
  "back": "背面答案",
  "source": "资料来源或原创说明"
}
```

### 计划 `milestones` 与 `planTasks`

- `milestones` 使用 `offsetDays` 相对考试日期计算节点。
- `planTasks.phase` 必须与 `config.json` 中某个 `workflow.planPhase` 完全一致。
- `planTasks.subject` 可为空；非空时必须引用现有模块 `id`。
- 每个阶段至少需要一个计划任务。

增删内容后重新运行 `npm run build`。如果希望清空示例内容，可删除 `subjects`、`questions`、`flashcards`、`milestones`、`planTasks` 数组中的项目，再按自己的结构添加；需同时满足字段和引用校验。

## 三、配置资料采集

先在 `config.json` 填写真实考试与机构，再添加 `officialSources`、`curatedResources` 或 `searchQueries`。默认模板不配置个人来源，也不自动发起采集。

```bash
npm run collect
```

采集器会按配置的关键词、分类、信任域名和排除词筛选结果，并写入：

- `data/articles.json`：结构化资料。
- `knowledge-base/`：Markdown 知识库和更新日报。
- `knowledge-base/资料/`：单篇本地摘录。
- `data/state.json`：已处理链接状态。
- `data/errors.json`：最近一次运行错误。

默认搜索接口为必应 RSS，将 `{query}` 替换为检索词。可改为返回兼容 RSS 的公开接口。不要把自己的账号、Cookie 或访问令牌写入仓库。

可选目录页填写在 `collector.catalog.url`。不同网站结构差异较大，目录页目前以正文摘录方式保存；考试科目、名额、时间、条件等信息必须人工核对。

仓库不包含定时任务。需要自动更新时，可自行使用系统计划任务运行 `npm run collect && npm run build`。请遵守目标网站的使用规则和请求频率。

## 四、改成自己的版本并发布

1. Fork 本仓库，或下载 ZIP 后创建自己的 Git 仓库。
2. 修改 `config.json` 和 `data/content.json`。
3. 运行 `npm run build`，再用浏览器打开 `dashboard.html`。
4. 运行 `npm test`，修复校验错误。
5. 检查浅色、黑夜模式和手机布局。
6. 更新 README、许可证中的归属信息，以及仓库名称和描述。
7. 提交并推送到自己的公开仓库。

如需建立独立品牌，可修改 `app.name`、`app.tagline`、`app.brandMark` 和 `app.exportPrefix`。`app.storageKey` 决定浏览器学习记录保存在哪个键下；更换后旧记录不会自动迁移。

## 数据与发布隐私

- 学习进度、笔记、打卡和答题记录只保存在当前浏览器。
- 清理浏览器数据或更换设备前，请在“学习工具”中导出 JSON 备份。
- 备份、CSV、PNG、测试截图、浏览器测试配置和本地采集日报已加入 `.gitignore`。
- 公开发布前不要提交个人学习记录、备份文件、私人资料、凭据、Cookie、令牌或本地绝对路径。
- `dashboard.html` 是生成文件，可以随仓库发布，方便直接预览；修改源配置后应重新生成。
- `data/articles.json` 和知识库摘录可能包含第三方公开内容，发布前应自行检查引用、版权和隐私边界。

## 使用边界

考试科目、报考条件、考试时间和相关安排可能变化。政策信息应以考试机构、目标机构和官方平台的当前正式文件为准。第三方经验帖仅用于获取学习方法，不能作为政策依据。

## 许可证

本项目使用 [MIT License](LICENSE)。示例内容由项目作者原创；替换为第三方资料时，应自行确认授权与署名要求。
