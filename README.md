# Kodeoff · 发布仓库

Kodeoff：macOS 拖拽轮盘工具——拖住文件停一下，光标处弹出 10 扇区轮盘，滑向扇区松手即执行；无需辅助功能权限。

本仓库只承载 Kodeoff 的**公开分发物与官网静态副本**，不含源码。源码不开源，授权方案待公布。

## 下载

最新版直达：<https://github.com/kk0x03/kodeoff-release/releases/latest>

| 平台 | 文件 | 要求 |
|---|---|---|
| macOS | `Kodeoff-<版本>-macOS.dmg` | macOS 13+（Apple silicon / Intel） |
| Windows | `Kodeoff-<版本>-windows-x64.zip` | Windows 10+ x64（实验性） |
| Windows | `Kodeoff-<版本>-windows-x64-native.zip` | 同上（原生编译，内容等价任选其一） |

## macOS 安装与首次打开（ad-hoc 签名，未公证）

1. 下载 DMG，双击挂载，把 Kodeoff.app 拖入 /Applications。
2. 首次打开会被 Gatekeeper 拦（「无法验证开发者」）：在 Finder 里对 Kodeoff.app **右键 → 打开 → 再点「打开」**。
3. 若仍被拦或提示「已损坏」：系统设置 → 隐私与安全性 → 点「仍要打开」；命令行等价：`xattr -dr com.apple.quarantine /Applications/Kodeoff.app`。

> 【如实声明】当前安装包为 ad-hoc 签名（无 Developer ID、未经公证）；Developer ID + 公证列于 v0.2 计划。

## Windows 首次运行（未数字签名）

SmartScreen 拦截时选「更多信息 → 仍要运行」。解压后双击 kodeoff.exe（单文件绿色软件，无安装、无额外依赖）。设置存 `%APPDATA%\Kodeoff\settings.ini`；卸载 = 删文件 + 删 ini 目录 + 删 HKCU `...\Run` 的 Kodeoff 键。

> 【如实声明】本产物尚未在任何真机 Windows 上验证。

## 版本日志

| 版本 | 日期 | 要点 |
|---|---|---|
| v0.1.3 | 2026-10 | 首个公开 pre-release。含：v0.1.1 流畅性（停顿半径/触觉/动效）、v0.1.2 发送到手机（iCloud 通道待真机验证，AirDrop 可用）、v0.1.3 长按加速出盘/轮盘右键菜单/Finder 服务入口/压缩解压动作 |
| v0.1.0–v0.1.2 | 未公开发布 | 内部迭代（详见各 Release 说明） |

## 功能速览

macOS 10 扇区：VSCode 打开 / 复制路径 / 发送到手机（iCloud 通道未真机验证）/ AirDrop / 打开方式… / 快捷编辑 / 新建同格式 / Finder 中显示 / 终端打开 / 设置。Windows 首版 5 动作：VSCode 打开 / 复制路径 / 新建同格式 / 资源管理器中显示 / 终端打开。

## 反馈

请提本仓库 Issues（开发仓库为私有，不对外）。

---
© 2026 kk0x03。保留所有权利；下载物按「现状」提供，不作任何担保。
