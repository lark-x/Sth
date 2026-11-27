# Sth

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

前端使用 Vue 3、TypeScript 和 Vite。现有 Node.js 服务继续提供统一业务 API、静态页面和媒体资源。

## Users

用户希望随手记下一句话，也能继续写日记、组织角色和资料、推进作品。

## Product Purpose

打开首页即可记录，并能找到已有内容继续写作。网页与 AI 客户端复用现有操作 API 和同一份版本化资源。

## Capabilities and Constraints

- 首页从现有 `diary.list` 读取日记，写入使用 `diary.create`。
- 现有地址、查询参数、版本链接和 legacy 页面持续可访问。
- 按业务域逐步迁入 Vue，日记和工作区由各自模块维护。
- 使用中文操作文案与简约工作界面，不依赖外网字体。
- 独立检出后支持 `npm ci`、启动、测试和 Docker 构建。
- 验证使用隔离临时库，不连接或修改运行中的用户库。

## Brand Commitments

保留 Sth 名称，优先呈现写作动作和真实内容。

## Evidence on Hand

现有业务实现位于 `src/`，原页面位于 `web/assets/`，浏览器验收位于 `tests/browser/`。

## Product Principles

- 用户先能记录，再按需组织内容。
- 真实数据与明确的空白、加载、失败状态共同构成界面。
- 页面迁移复用业务契约和稳定链接。
- 交付以隔离环境的可运行结果和截图为依据。
