# DeepCool Linux Port —— 发布打包

本目录负责把本仓库构建成可分发的二进制包。

## 产物（`bash packaging/build-release.sh`）

| 产物 | 内容 | 用途 |
|---|---|---|
| `dist/deepcool-linux-port-0.1.0.tar.zst` | **自包含**：Linux Electron 23 + 预打补丁应用（`app/resources/app.asar.extracted`）+ 代码 | 解压即用 |
| `dist/deepcool-linux-port-0.1.0-source.tar.zst` | 纯代码（patches/daemon/scripts/tools…） | 合规源码包 / PKGBUILD 构建 |
| `dist/PKGBUILD`（本文件） | 引用 source tar + 官方 exe | `makepkg` Arch 包 |

前置（构建机）：仓库已完成 `npm run bootstrap`（`work/windows-app` 已解包打补丁、`node_modules/electron` 已下载）。

## 使用自包含 tar（本机/内网）

```bash
bash packaging/build-release.sh            # 产出 dist/*.tar.zst
tar --zstd -xf dist/deepcool-linux-port-0.1.0.tar.zst -C /tmp/dc
sudo bash /tmp/dc/deepcool-linux-port-0.1.0/packaging/install-tarball.sh /tmp/dc/deepcool-linux-port-0.1.0 [--autostart]
deepcool-linux-port
```

或不装 /opt，直接解压后：

```bash
deepcool-linux-port-0.1.0/bin/deepcool-linux-port
```

## Arch 包（PKGBUILD）

```bash
# 同目录放置：source tar + DeepCool-1.2.12-setup.exe
bash packaging/build-release.sh            # 生成 source tar
cd packaging && makepkg -si
```

`makedepends`：nodejs/npm/7zip/zstd；`depends`：python-pyusb/psutil/pillow/acl/ffmpeg。

## 运行依赖

- 应用：bash、curl、getent、newgrp（可选）；`DEEPCOOL_APP_DIR/ELECTRON` 指向包内路径
- daemon：python3 + pyusb/psutil/pillow + acl（setfacl）；`/usr/local/bin/deepcool-lm-daemon` + systemd unit
- GIF/视频抽帧：`ffmpeg`

## 版权与分发注意

- 本包 **包含 DeepCool 官方素材**（解包后的应用、部分二进制与 UI 资源）与 Electron 运行时；
- 官方素材版权属 DeepCool，README 声明「勿再分发官方 payload」；
- 请仅在内网/自用范围分发，或自行评估授权后再公开；
- `-source` 包只有我们的代码，可合规对外分发（但构建二进制仍需官方 exe）。
