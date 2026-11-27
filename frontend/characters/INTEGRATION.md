# 角色域集成

Hubble 在共享注册表导入 `matchCharactersRoute`，将匹配结果指向 `./characters/CharacterRoute.vue` 的 default export。导航归属为 `/characters`。

入口接收 `props { url: URL }`，发出 `navigate(href: string)` 与 `refresh()`。原生链接保留新标签页行为。组件监听完整 URL 的变化，并在退出时取消读取。用户已提交的写操作独立完成，退出后不会跳转其他页面。

## 匹配范围

- `/characters` 和 `/characters/` 为角色列表，保留 `projectId` 筛选与新建角色的项目上下文。
- `/characters/new` 和尾斜杠形式为新建角色。
- `/characters/:characterId` 和尾斜杠形式为角色详情。`?edit=1` 打开编辑，`?revision=N` 固定历史版本。存在 revision 时优先阅读版本，并校验其为安全正整数。
- 编号解码后须非空、至多 128 字符，并排除路径分隔符与控制字符。额外路径段、非法编码以及带 `action` 的地址由原页面回退处理。

列表、设定正文、条目与媒体阅读、版本历史、页级加载和错误恢复由 Vue 组件维护。`CharacterEditor.vue` 仅挂载共享 `editor.js` 表单与 `character-blocks.js` 的条目编辑器，复用上传、顺序调整、稳定条目编号、引用片段位置、草稿、乐观版本冲突和回执重试。

资料、场景、候选稿、日记、角色和判断引用继续使用原版本链接，保留 UTF-16 位置。当前角色可开写日记，任一版本可进入已有内容的场景构思入口。

## 验证

运行 `node --test frontend/tests/characters-vue.test.mjs`。测试使用真实隔离后端与独立 Vite 宿主挂载本域，通过原有页面处理跨域链接。另外从当前 `frontend/main.ts` 与共享注册表进入真实 shell，验证桌面和手机上的创建、编辑与读回。额外的原有用例位于 `tests/browser/character-prompt.test.mjs`、`tests/browser/acceptance.test.mjs` 和 `tests/browser/workspace.test.mjs`。

`STH_CHARACTER_SCREENSHOTS=1` 将桌面及手机截图写入系统临时目录。
