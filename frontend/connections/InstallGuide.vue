<script setup lang="ts">
import { computed, reactive } from 'vue';
import CopyCommand from './CopyCommand.vue';
import { installCommand } from './install.ts';
import type { HermesAction, Host } from './install.ts';

const props = defineProps<{ origin: string }>();
const fields = reactive({
  host: 'hermes' as Host, repository: '', profile: '', distribution: '', bindingDirectory: '',
  config: '', workspace: '', executable: '', binaryDirectory: '',
  hermesAction: 'connect' as HermesAction, workspaceName: 'my-writing',
});
const result = computed(() => installCommand({ ...fields, origin: props.origin }));
const hermes = computed(() => `hermes${fields.profile ? ` -p '${fields.profile.replaceAll("'", "''")}'` : ''}`);
</script>

<template>
  <details class="install-guide">
    <summary>安装与连接助手</summary>
    <div class="guide-body">
      <div class="field host-field">
        <label for="connection-host">助手宿主</label>
        <select id="connection-host" v-model="fields.host">
          <option value="hermes">Hermes</option>
          <option value="codex">Codex</option>
          <option value="antigravity">Antigravity</option>
        </select>
      </div>
      <template v-if="fields.host === 'hermes'">
        <p>准备已配置模型的 Hermes 和 Git。将收到的、与本机系统和架构匹配的 Sth 完整分发 ZIP 解压，在运行 Hermes 的电脑上用 PowerShell 执行下方命令。</p>
        <p>使用当前 Hermes profile。需要切换到已有命名 profile 时，填写下面的可选名称，全部命令会使用同一个 profile。</p>
        <fieldset class="hermes-actions">
          <legend>选择工作区</legend>
          <div><input id="hermes-create" v-model="fields.hermesAction" type="radio" name="hermesAction" value="create"><label for="hermes-create">创建自己的工作区</label></div>
          <div><input id="hermes-connect" v-model="fields.hermesAction" type="radio" name="hermesAction" value="connect"><label for="hermes-connect">连接此工作区</label></div>
        </fieldset>
        <p v-if="fields.hermesAction === 'create'">插件用包内运行时创建本机工作区，在当前 profile 下持久保存数据，并自动完成终端连接。打开命令返回的 origin，即可开始写作。</p>
        <p v-else>将当前工作区 <code>{{ origin }}</code> 登记到 Hermes。命令会提示输入本页生成的一次性码，并将连接保存在当前 profile。</p>
      </template>
      <template v-else>
        <p>在运行助手的电脑上，用 PowerShell 7 执行命令。准备 Node.js 24.15 或更新版本，以及含 adapters 的 Sth 安装目录。</p>
        <p v-if="fields.host === 'codex'">先准备已安装的 Codex CLI。选择宿主实际读取的 config.toml，以及已有的本地工作目录。</p>
        <p v-else>选择 Antigravity 实际读取的 MCP JSON 配置文件，以及已有的本地工作目录。需要 CLI 时，可填写新目录，使用仓库下载工具校验 SHA-512 与 Google 签名。</p>
      </template>
      <div class="path-fields">
        <template v-if="fields.host === 'hermes'">
          <div class="field full-width">
            <label for="connection-distribution">已解压的完整插件分发目录</label>
            <input id="connection-distribution" v-model="fields.distribution" type="text" name="distribution" autocomplete="off" :spellcheck="false" aria-describedby="distribution-help">
            <small id="distribution-help">选择直接包含 plugin.yaml 和 runtime 的完整分发目录。请先解压 ZIP，包内已包含 Sth 运行时和网页。</small>
          </div>
          <div class="field">
            <label for="connection-profile">Hermes profile 名称（可选）</label>
            <input id="connection-profile" v-model="fields.profile" type="text" name="profile" autocomplete="off" :spellcheck="false" aria-describedby="profile-help">
            <small id="profile-help">留空沿用当前 profile，或填写已有名称，例如 author。</small>
          </div>
          <div class="field">
            <label for="connection-hermes-workspace">{{ fields.hermesAction === 'create' ? '新工作区名称' : '在 Hermes 中的工作区名称' }}</label>
            <input id="connection-hermes-workspace" v-model="fields.workspaceName" type="text" name="workspaceName" autocomplete="off" :spellcheck="false" aria-describedby="hermes-workspace-help">
            <small id="hermes-workspace-help">{{ fields.hermesAction === 'create' ? '在当前 profile 下创建，数据位于 sth-workspaces。' : '这是当前 profile 中用于选择此工作区的名称。' }}</small>
          </div>
        </template>
        <template v-else>
          <div class="field full-width">
            <label for="connection-repository">Sth 安装目录</label>
            <input id="connection-repository" v-model="fields.repository" type="text" autocomplete="off" :spellcheck="false" placeholder="包含 adapters 的绝对目录">
          </div>
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
      <p v-if="!result.command" class="guide-hint">{{ fields.host === 'hermes' && !fields.distribution ? '填写已解压的完整分发目录后，显示对应命令。' : result.error }}</p>
      <template v-else>
        <h3>本机安装命令</h3>
        <CopyCommand :text="result.command" />
        <template v-if="fields.host !== 'hermes'">
          <p>命令会在终端提示输入一次性码。先完成依赖安装，再生成配对码，粘贴配对命令的最后一段。</p>
          <p>安装器登记 sth-personal MCP 项，遇到同名配置会要求检查。安装成功后，在相应配置下重新打开宿主，查找 sth_personal_discover 和 sth_personal_invoke。</p>
        </template>
        <template v-else>
          <p>安装前核对分发者及 ZIP 的 SHA-256。完整包的运行时会触发 Hermes 的 CAUTION 扫描提示，命令中的 --force 用于显式确认安装。</p>
          <p v-if="fields.hermesAction === 'connect'">先执行安装，终端提示时再点击本页的「生成配对码」，输入配对命令末尾的一次性码。终端会隐藏输入。</p>
          <p>连接成功后运行 <code>{{ hermes }} -t sth-personal-operations</code>，让当前 Hermes 模型保存并读回一篇日记。下次使用先运行 <code>{{ hermes }} sth status</code>。</p>
          <p v-if="fields.hermesAction === 'create'">机器重启后，用 <code>{{ hermes }} sth workspace start --workspace '{{ fields.workspaceName }}'</code> 恢复自有工作区。</p>
          <p v-else>此工作区的启动与停止沿用原服务管理方式。</p>
        </template>
      </template>
      <p class="guide-note">宿主登录在自己的官方流程中完成。请妥善保管终端连接文件和服务密码，按需在本页撤销连接。QQ／微信的各个私聊单独配对。</p>
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
.hermes-actions { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; padding: .5rem 0; margin: 0; border: 0; }
.hermes-actions legend { font-weight: 600; margin-block-end: .4rem; }
.hermes-actions > div { display: flex; align-items: center; gap: .5rem; }
.hermes-actions input { inline-size: 1.1rem; block-size: 1.1rem; flex: 0 0 auto; margin: 0; }
.hermes-actions label { display: inline-flex; align-items: center; min-block-size: 3rem; margin: 0; cursor: pointer; }
.path-fields input, .host-field select { min-block-size: 3rem; font-size: 1rem; }
small, .guide-hint, .guide-note { color: var(--muted); }
small { font-size: .82rem; }
.guide-note { border-block-start: 1px solid var(--line); padding-block-start: 1rem; }
h3 { margin-block-start: .5rem; }
@media (width <= 40rem) { .path-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
