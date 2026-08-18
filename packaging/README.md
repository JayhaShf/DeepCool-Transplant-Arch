# DeepCool Linux Port 发布与打包

本目录维护二进制归档、源码归档和 Arch Linux 包的构建入口。目标平台是
Arch Linux x86_64；二进制归档捆绑 Electron，但仍依赖系统共享库、Python
模块和 systemd，因此不是完全静态或跨发行版的“自包含”包。

## 发布产物

`bash packaging/build-release.sh 0.1.0` 会先清空 `dist/`，然后生成：

| 文件 | 内容 |
|---|---|
| `deepcool-linux-port-0.1.0.tar.zst` | Electron 23、已打补丁应用、daemon、运行脚本和 `/opt` 安装器 |
| `deepcool-linux-port-0.1.0-source.tar.zst` | 仓库源码快照和 `BUILDING.md`；不含官方安装包或 npm 依赖 |
| `deepcool-linux-port-0.1.0-sbom.cdx.json` | CycloneDX 1.5 清单，覆盖 Electron 与应用树中可识别的 Node.js 包 |
| `PKGBUILD` | 已写入本次 source tar SHA-256 的 Arch 构建文件 |
| `deepcool-linux-port.install` | Arch 安装/升级/卸载 hook |
| `SHA256SUMS` | 上述五个发布文件的 SHA-256 清单 |

SBOM 不覆盖 Arch 系统包、Python 模块、没有 `package.json` 的官方资源或固件；
它不能替代完整的软件成分与许可证审查。

安全边界和 Electron 23 残余风险记录在发布包根目录的 `SECURITY.md`。构建或发布前运行：

```bash
npm run security:check
```

## 构建与校验

构建机必须先完成 `npm ci`、官方安装包提取和 Linux 补丁准备，即仓库中应存在：

- `node_modules/electron/dist/electron`
- `work/windows-app/resources/app.asar.extracted`
- 已注入的 main、preload、IPC policy、renderer overlay 和 CSP

常规发布只接受干净工作树，版本必须同时匹配 `package.json` 与
`packaging/PKGBUILD`：

```bash
bash packaging/build-release.sh 0.1.0
cd dist
sha256sum -c SHA256SUMS
```

`ALLOW_DIRTY=1` 仅用于本地 smoke test；这种 source tar 来自当前工作树，不应发布。
归档统一使用 Git 提交时间、固定 owner/group 和排序后的成员列表，以减少重复构建差异。

GitHub Release 还要求仓库变量 `ALLOW_BINARY_RELEASE=true`。只有在确认 DeepCool
payload 与其他捆绑内容具备再分发授权后才应设置该变量。

## 使用二进制归档

先验证 `SHA256SUMS`，再解压并从解压目录外运行安装器：

```bash
tar --zstd -xf deepcool-linux-port-0.1.0.tar.zst
sudo bash deepcool-linux-port-0.1.0/packaging/install-tarball.sh \
  "$PWD/deepcool-linux-port-0.1.0"
deepcool-linux-port
```

安装器把应用放在 `/opt/deepcool-linux-port`，创建 `/usr/bin` 符号链接，安装桌面
入口，并调用 daemon 安装器。归档也可直接运行
`deepcool-linux-port-0.1.0/bin/deepcool-linux-port`，但这不会自动安装 daemon 或系统依赖。

通过 `sudo` 从桌面用户会话调用时，可附加 `--autostart`；安装器使用
`SUDO_USER` 决定自启文件所属用户。从 root shell 直接运行时必须显式指定用户：

```bash
sudo bash deepcool-linux-port-0.1.0/packaging/install-tarball.sh \
  "$PWD/deepcool-linux-port-0.1.0" --autostart

sudo bash deepcool-linux-port-0.1.0/packaging/install-tarball.sh \
  "$PWD/deepcool-linux-port-0.1.0" --autostart --user jay
```

运行依赖以 `PKGBUILD` 的 `depends` 数组为准，包括 Electron 所需 GTK/X11、NSS、
音频和图形库，以及 `python-pyusb`、`python-psutil`、`python-pillow`、`acl`、
`ffmpeg`、`systemd`。daemon 仍以受限 `root:deepcool` 运行：它需要访问 USB 设备并恢复
`/sys/bus/usb/devices/*/authorized`；socket 的 `0660 root:deepcool` 权限限制客户端连接。

## 使用 PKGBUILD

必须使用 `dist/PKGBUILD`，不能直接使用仍带 hash 占位符的
`packaging/PKGBUILD`。把以下文件放在同一个空目录：

- `dist/deepcool-linux-port-0.1.0-source.tar.zst`
- `dist/PKGBUILD`
- `dist/deepcool-linux-port.install`
- `DeepCool-1.2.12-setup.exe`

官方安装包的预期 SHA-256 是
`4549885c716e951dde488e2117823478f7994c475e686331f93866582f6b116f`。

```bash
makepkg --verifysource
makepkg -si
```

构建过程会执行锁定版本的 `npm ci`，并下载 `package-lock.json` 固定的 npm 包和
Electron 23.3.13；因此当前 PKGBUILD 不是离线构建。声明的 source tar 与官方安装包
由 `makepkg` 校验，npm 下载则由 lockfile integrity 和 Electron checksum 校验。

## 许可证与再分发

项目在 `package.json` 中标记为 `UNLICENSED`，源码归档本身不授予复制、修改或
再分发许可。二进制归档和 Arch 包还包含解包后的 DeepCool 应用代码、图像、固件及
其他资源；这些内容需要相应权利人的单独许可。Electron 与第三方依赖继续适用各自的
许可证。公开发布前必须逐项确认授权，不能把 source tar 或 SBOM 视为授权证明。
