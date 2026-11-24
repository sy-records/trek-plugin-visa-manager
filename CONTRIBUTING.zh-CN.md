# 贡献说明

[English](CONTRIBUTING.md) | 简体中文

[返回 README](README.zh-CN.md)

## 从当前仓库构建并安装

UI 可从插件源码构建；校验和打包可安装的插件仍需 TREK 插件 SDK。

在 TREK 仓库根目录安装工作区及 SDK 依赖：

```sh
npm ci
npm ci --prefix plugin-sdk
npm run build --prefix plugin-sdk
```

然后校验并打包：

```sh
npm run validate --prefix plugins/visa-manager
npm run pack --prefix plugins/visa-manager
```

生成 `plugins/visa-manager/visa-manager.zip`。在已设置 `TREK_PLUGINS_ENABLED=1` 的实例中，打开 **管理面板 → 插件 → 上传插件**，上传安装包，启用并确认两项权限，随后从导航中的 **Passports & Visas** 打开。

安装包包含构建后的静态页面和服务端 JavaScript，运行时由宿主注入 SDK；SDK 仅为开发依赖，不随插件服务端打包。

### 测试港澳通行证开关

在 TREK 后台打开 **管理面板 → 插件**，找到 **Passports & Visas**，打开插件行右侧的 **⋯ → 实例设置**。勾选 **Enable Hong Kong & Macao permit management** 并保存；插件重启后重新打开页面，应显示“港澳通行证”和“港澳出入境记录”标签。取消勾选并保存后，两项标签应隐藏；已有记录会保留，重新启用后仍可查看。

本地预览可在插件根目录创建 `dev-fixtures.json`，用布尔配置模拟启用或关闭：

```json
{
  "config": {
    "hong_kong_macau_enabled": true
  }
}
```

将值改为 `false` 可模拟关闭。修改后重启预览服务，再刷新整个 `/preview` 页面。此文件只用于本地预览，不会更改 TREK 后台的实例设置。

## 本地预览

```sh
npm run dev --prefix plugins/visa-manager
```

访问 [http://localhost:4317/preview](http://localhost:4317/preview)。该命令会先重建仓库 SDK 和插件 UI。开发记录保存在 `.trek-dev/`，不会进入安装包。

修改 SDK 预览代码后，需要重启服务并整页刷新 `/preview`；仅刷新 iframe 无法更新外层的确认弹窗逻辑。预览响应不使用浏览器缓存，并会检测服务重启。

测试简体中文时，在预览页面开发者工具的 **top** 控制台执行：

```js
document.getElementById('f').contentWindow.postMessage(
  { ...ctx(), locale: 'zh-CN' },
  '*'
);
```

将 `zh-CN` 改为 `en` 可恢复英语。刷新页面或收到新的宿主上下文后，预览可能恢复英语。完整 TREK 实例中，直接将 TREK 的界面语言设置为简体中文即可。

开发实例如需 dev-link，可设置 `TREK_PLUGINS_DEV_LINK=1`，解压构建后的安装包并链接解压目录。安装包中的 `<!-- trek:ui -->` 已展开，原始源码 HTML 尚未展开。

## 检查

业务及权限测试使用 Node 内置 SQLite，需要 Node **22.22.2+** 或当前 TREK 仓库支持的其他 Node 版本：

```sh
npm test --prefix plugins/visa-manager
```

浏览器检查还需要仓库中的 Playwright，以及已安装的 Chromium 或 Google Chrome：

```sh
npm run build --prefix plugins/visa-manager
node plugins/visa-manager/test/browser-smoke.cjs
```

浏览器检查会将插件复制到临时目录，使用独立数据库，覆盖语言回退与切换、表单保存、新旧护照关联、获批与拒签结果、生成关联签证、不同出入境地点、取消删除、持久化及手机布局。
