# Code Signing Policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

> **Status:** application pending. Until it is approved, releases are published unsigned and Windows SmartScreen
> may warn on download. This page describes how signing works once it is active.

## What gets signed

- The Windows installer `WLED-Client-Setup-<version>.exe` attached to each [GitHub release](https://github.com/bangboomben/wled-client/releases).
- Only installers built by the [Build & Release workflow](.github/workflows/release.yml) on GitHub-hosted runners,
  from a version tag (`v*`) of this repository. Nothing built on a personal machine is submitted for signing.
- Every signing request is approved manually by an approver (see below) before it is signed.

The installer contains third-party components that are not signed by this project, most notably the
[Electron](https://www.electronjs.org) runtime.

## Team roles

| Role | Members |
|---|---|
| Committers and reviewers | [bangboomben](https://github.com/bangboomben) |
| Approvers | [bangboomben](https://github.com/bangboomben) |

Changes from other contributors are merged only after review by a committer. All members use multi-factor
authentication for GitHub and SignPath.

## Privacy

See the [privacy policy](PRIVACY.md).
