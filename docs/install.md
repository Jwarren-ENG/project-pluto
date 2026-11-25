# Installing and building Project Pluto

## Choose an installer

| Computer | Installer filename |
| --- | --- |
| Mac with Apple silicon | `Project-Pluto-<version>-macOS-arm64.dmg` |
| Mac with an Intel processor | `Project-Pluto-<version>-macOS-x64.dmg` |
| Windows x64 | `Project-Pluto-<version>-Windows-x64.exe` |

On a Mac, **About This Mac** identifies the chip or processor. Open the matching disk image, then drag **Project Pluto** into **Applications**. On Windows, launch the installer and follow the installation wizard. The Windows installer defaults to a per-user installation.

The default Mac build uses an ad hoc signature and has no Apple notarization. Default Windows CI builds have no Authenticode publisher certificate. For managed devices, use a release approved by your organization. Signing and release publishing are separate maintainer steps.

## Build locally

Use Node.js 24.22.3 with its bundled npm 11.19.1, and a native macOS or Windows build host with the target processor. The repository’s `.node-version` pins the same toolchain for all three runners. The first install and packaging run need network access to obtain the locked dependencies, Electron binary and platform packaging tools. The app’s packaged résumé importer includes its PDF reader, worker and platform-specific native canvas library.

From the repository root:

```sh
npm ci --include=optional
node node_modules/electron/install.js
npm test
npm run build
npm run smoke
```

Build one native target using the matching command:

| Target | Command |
| --- | --- |
| macOS Apple silicon | `npm run package:native -- --mac --arm64` |
| macOS Intel | `npm run package:native -- --mac --x64` |
| Windows x64 | `npm run package:native -- --win --x64` |

After building, run `npm run verify:package`. This launches the executable in `release/` with a disposable workspace, loads the native canvas binary, imports a synthetic PDF through the real renderer bridge, and checks that both mail accounts start disconnected. The check uses no personal profile, credentials or mailbox. To rebuild the renderer and package the host target in one command, use `npm run dist`.

The installer, unpacked application and any builder metadata are written to `release/`. The user-facing downloads are the DMG and EXE files listed above. Runtime files are packaged from `desktop/`, the Vite output and production dependencies. Native binaries are unpacked beside the application archive. The source PNG and macOS and Windows icon resources are in `build/`.

## GitHub Actions

The **Desktop builds** workflow in `.github/workflows/desktop-build.yml` runs on pull requests, pushes to `main`, version tags beginning with `v`, or a manual dispatch. The three independent jobs use native Apple silicon, Intel Mac and Windows x64 runners. Each installs Electron, runs the tests, builds the installer, runs the desktop smoke test on its packaged executable, and verifies the bundled PDF importer before uploading an installer artifact.

| Actions artifact | Contents |
| --- | --- |
| `Project-Pluto-macOS-arm64` | Apple silicon DMG |
| `Project-Pluto-macOS-x64` | Intel DMG |
| `Project-Pluto-Windows-x64` | Windows x64 installer |

The workflow has read-only repository permissions and uploads build artifacts to its run. The release maintainer chooses the verified installers for publication. [GitHub native runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-runners-for-public-repositories)
