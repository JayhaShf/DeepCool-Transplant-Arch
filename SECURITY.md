# Security Posture

## Supported security model

This port deliberately keeps Electron `23.3.13` because the official DeepCool
main process is V8 bytecode compiled for that Electron/V8 runtime. Upgrading
Electron without rebuilding or replacing the vendor main process breaks startup;
the project therefore does not run `npm audit fix` against Electron.

The application is intended for a local, trusted Arch Linux desktop. It is not
an internet-facing browser and must not be used to load untrusted web content.

The supported launch path provides these controls:

- Chromium sandbox is mandatory; `scripts/run.sh` refuses to use `--no-sandbox`.
- CDP is disabled by default and, when explicitly enabled, binds to
  `127.0.0.1` only.
- Renderer IPC is allowlisted and sender URLs are restricted to the bundled
  `index.html` and `launch.html` pages.
- External navigation and `window.open` are denied.
- Renderer CSP disables plugins, frames, and arbitrary script sources. It
  permits `unsafe-eval` only because the vendor Vue-i18n bundle compiles its
  localized messages with `new Function`; the renderer remains restricted to
  trusted local files and is not a general web-content container.
- User media is bounded and decoded through restricted `ffprobe`/`ffmpeg` paths;
  daemon PNG input, socket concurrency, frame size, and media quotas are capped.
- The daemon socket is `0660 root:deepcool`; the daemon has no Linux
  capabilities and uses systemd resource/filesystem restrictions. It remains
  root only because the current USB and sysfs authorization paths require it.

Run the release gate from the repository checkout or an installed release
directory that contains `package-lock.json`:

```bash
npm run security:check
```

## Accepted residual advisories

At the locked Electron 23 version, `npm audit` reports two high advisories:

- `electron`: vulnerabilities in the old Electron runtime;
- `extract-zip`: an Electron installation-time dependency.

The release tarball contains the Electron runtime but does not ship the root
`node_modules` installation tree or `extract-zip`. `npm audit --omit=dev` is the
runtime package check and must remain clean. The full audit is still run by
`security:check`; it must contain exactly the two advisories above. Any new
package, severity, or critical advisory fails the gate and requires review.

The residual Electron risk is accepted only for the trusted-local usage model
and the controls above. A zero-advisory result requires obtaining a vendor build
for a supported Electron or replacing/rebuilding the bytecode-only main process;
it cannot be achieved by changing the lockfile alone.
