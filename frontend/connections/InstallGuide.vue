<script setup lang="ts">
import { computed, reactive } from 'vue';
import CopyCommand from './CopyCommand.vue';
import { installCommand } from './install.ts';
import type { Host } from './install.ts';

const props = defineProps<{ origin: string }>();
const fields = reactive({
  host: 'hermes' as Host, repository: '', profile: '', distribution: '', bindingDirectory: '',
  config: '', workspace: '', executable: '', binaryDirectory: '',
});
const result = computed(() => installCommand({ ...fields, origin: props.origin }));
</script>

<template>
  <details class="install-guide">
    <summary>安装与连接助手</summary>
    <div class="guide-body">
      <p>在运行助手的电脑上，用 PowerShell 7 执行命令。准备 Node.js 24.15 或更新版本，以及含 adapters 的 Sth 安装目录。</p>
      <div class="field host-field">
        <label for="connection-host">助手宿主</label>
        <select id="connection-host" v-model="fields.host">
          <option value="hermes">Hermes</option>
          <option value="codex">Codex</option>
          <option value="antigravity">Antigravity</option>
        </select>
      </div>
      <p v-if="fields.host === 'hermes'">先准备可运行的 Hermes CLI、Python 3 和 Git。插件从本地源码打包，安装到当前终端指定的独立 profile。</p>
      <p v-else-if="fields.host === 'codex'">先准备已安装的 Codex CLI。选择宿主实际读取的 config.toml，以及已有的本地工作目录。</p>
      <p v-else>选择 Antigravity 实际读取的 MCP JSON 配置文件，以及已有的本地工作目录。需要 CLI 时，可填写新目录，使用仓库下载工具校验 SHA-512 与 Google 签名。</p>
      <div class="path-fields">
        <div class="field full-width">
          <label for="connection-repository">Sth 安装目录</label>
          <input id="connection-repository" v-model="fields.repository" type="text" autocomplete="off" :spellcheck="false" placeholder="包含 adapters 的绝对目录">
        </div>
        <template v-if="fields.host === 'hermes'">
          <div class="field">
            <label for="connection-profile">Hermes 独立 profile 目录</label>
            <input id="connection-profile" v-model="fields.profile" type="text" autocomplete="off" :spellcheck="false" aria-describedby="profile-help">
            <small id="profile-help">直接上级命名为 profiles，在同一终端使用此 profile。</small>
          </div>
          <div class="field">
            <label for="connection-distribution">新的插件分发目录</label>
            <input id="connection-distribution" v-model="fields.distribution" type="text" autocomplete="off" :spellcheck="false" aria-describedby="distribution-help">
            <small id="distribution-help">打包脚本要求该目录尚不存在。</small>
          </div>
        </template>
        <template v-else>
          <div class="field">
            <label for="connection-binding">新的私有配对目录</label>
            <input id="connection-binding" v-model="fields.bindingDirectory" type="text" autocomplete="off" :spellcheck="false" aria-describedby="binding-help">
            <small id="binding-help">配对程序会创建目录并限制凭据访问权限。</small>
          </div>
          <div class="field">
            <label for="connection-config">宿主配置文件</label>
            <input id="connection-config" v-model="fields.config" type="text" autocomplete="off" :spellcheck="false">
          </div>
          <div class="field">
            <label for="connection-workspace">宿主本地工作目录</label>
            <input id="connection-workspace" v-model="fields.workspace" type="text" autocomplete="off" :spellcheck="false">
          </div>
          <div v-if="fields.host === 'codex'" class="field">
            <label for="connection-executable">Codex CLI 启动器（可选）</label>
            <input id="connection-executable" v-model="fields.executable" type="text" autocomplete="off" :spellcheck="false" placeholder="已安装启动器的绝对路径">
          </div>
          <div v-else class="field">
            <label for="connection-binary">Antigravity CLI 下载目录（可选）</label>
            <input id="connection-binary" v-model="fields.binaryDirectory" type="text" autocomplete="off" :spellcheck="false" placeholder="尚不存在的绝对目录">
          </div>
        </template>
      </div>
      <p v-if="!result.command" class="guide-hint" role="status">{{ result.error }}</p>
      <template v-else>
        <h3>本机安装命令</h3>
        <CopyCommand :text="result.command" />
        <p>命令会在终端提示输入一次性码。先完成依赖安装，再生成配对码，粘贴配对命令的最后一段。</p>
        <p v-if="fields.host !== 'hermes'">安装器登记 sth-personal MCP 项，遇到同名配置会要求检查。安装成功后，在相应配置下重新打开宿主，查找 sth_personal_discover 和 sth_personal_invoke。</p>
        <p v-else>hermes sth status 会核验终端连接。QQ／微信需在独立 profile 的 config.yaml 中配置专用机器人，并将 sth-personal-operations 加入相应的 platform_toolsets。各个私聊使用新的配对码，向已获准的机器人私聊单独发送上方 Hermes 配对命令，并等待“已连接 Sth”。</p>
      </template>
      <p class="guide-note">请在独立终端和独立 profile 中验证，使用未载入线上机器人凭据的会话和专用测试账号。宿主登录在自己的官方流程中完成。请妥善保管 personal-connection.json、Hermes 绑定文件和服务密码。</p>
    </div>
  </details>
</template>

<style scoped>
.install-guide { border-block: 1px solid var(--line); margin-block: 1.5rem 2rem; }
summary { display: list-item; min-block-size: 3rem; padding-block: .8rem; cursor: pointer; font-weight: 650; color: var(--accent-deep); }
.guide-body { display: grid; gap: 1rem; padding-block: .25rem 1.5rem; min-inline-size: 0; }
.guide-body p { max-inline-size: 70ch; font-size: .92rem; line-height: 1.8; }
.host-field { max-inline-size: 20rem; }
.path-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.full-width { grid-column: 1 / -1; }
small, .guide-hint, .guide-note { color: var(--muted); }
small { font-size: .82rem; }
.guide-note { border-block-start: 1px solid var(--line); padding-block-start: 1rem; }
h3 { margin-block-start: .5rem; }
@media (width <= 40rem) { .path-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
