# Gugo Plugin Compatibility Contract v1

Status: public, versioned local-interchange contract. This document describes
what Gugo 0.11.51 accepts. “MUST”, “MUST NOT”, and “SHOULD” are normative.

This contract covers immutable disk packages, offline Marketplace metadata,
publisher identity, and compatibility gates. It does not turn process-local
runtime contribution setup into an untrusted code-loading API, and it does not
define a remote store.

## 1. Versions and compatibility

- Contract version: `1`.
- Current plugin API: `1.1.0`.
- Current host version: `0.11.51`.
- `apiVersion` is compatible when its major version matches the host API and it
  is not newer than the host API. For `0.x`, the minor version must also match.
- `hostVersion` and `dependencyVersions` use the supported semver comparators
  `=`, `>`, `>=`, `<`, `<=`, `^`, and `~`, separated by spaces for an AND
  range. An unavailable or incompatible dependency fails closed before setup.
- A contract major-version change may remove or reinterpret fields. Additive
  fields and new capabilities require a new documented contract revision; v1
  readers reject unknown Marketplace fields rather than guessing semantics.

## 2. Package layout and manifest

An unsigned direct-local package is a directory containing `plugin.json` and
its entry file. A signed offline Marketplace uses this fixed layout:

```text
<marketplace-root>/
  marketplace.json
  plugins/
    <plugin-id>/
      plugin.json
      <entry and data files>
```

`plugin.json` MUST be UTF-8 strict JSON. Required fields are `id`, `name`,
`version`, `type`, and `entry`. Supported optional compatibility/security fields
are `apiVersion`, `hostVersion`, `requires`, `dependencyVersions`,
`contributes`, `permissions`, `configSchema`, `stateSchemaVersion`, and
`integrity`. The supported disk package types are:

```text
ppt-theme | prompt-template | asset-pack | agent-template | skill-bundle | transformer
```

IDs use lower-case letters, digits, and hyphens, start with an alphanumeric
character, and are at most 80 characters. Versions are semver. Entry paths are
relative, cannot contain `..`, and transformer entries end in `.js`. A manifest
permission is a request, not an authorization; the local owner must still
approve the exact version, source digest, and permission digest before runtime
activation.

Packages are snapshotted without executing plugin code. Links, junctions,
special files, path collisions, case-folding collisions, oversized trees, and
files that change during capture fail closed. The package digest is SHA-256 over:

1. the UTF-8 prefix `gugo-local-plugin-package-v2` followed by NUL;
2. every directory and file, sorted by NFC-normalized UTF-8 relative path and
   then kind;
3. for a directory: `D:<path-byte-length>:<path>\n`;
4. for a file:
   `F:<path-byte-length>:<path>:<file-byte-length>:<hex-content-sha256>\n`.

The resulting textual form is `sha256-<64 lower-case hex characters>`.

## 3. Offline Marketplace metadata

`marketplace.json` is bounded local JSON. Its complete v1 shape is:

```json
{
  "schemaVersion": 1,
  "name": "team-local",
  "interface": { "displayName": "Team Local" },
  "publishers": [
    {
      "id": "example-publisher",
      "displayName": "Example Publisher",
      "keyId": "sha256-<sha256 of the 32 raw public-key bytes>",
      "publicKey": "ed25519-<unpadded base64url raw public key>"
    }
  ],
  "plugins": [
    {
      "name": "example-plugin",
      "version": "1.0.0",
      "source": {
        "source": "local",
        "path": "./plugins/example-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity",
      "packageDigest": "sha256-<package digest>",
      "publisher": {
        "id": "example-publisher",
        "keyId": "sha256-<publisher key id>"
      },
      "signature": {
        "algorithm": "ed25519",
        "value": "<unpadded base64url 64-byte signature>"
      }
    }
  ]
}
```

Publisher and plugin IDs MUST be unique. The publisher `keyId` MUST equal the
SHA-256 digest of its decoded 32-byte Ed25519 public key. A plugin publisher
reference MUST match that exact ID and key ID.

Only `source: "local"` with the exact relative path
`./plugins/<plugin-id>` is accepted. URLs, archive downloads, git sources, and
other remote descriptors are rejected with
`PLUGIN_MARKETPLACE_REMOTE_SOURCE_FORBIDDEN`. `INSTALLED_BY_DEFAULT` is rejected
with `PLUGIN_MARKETPLACE_AUTO_INSTALL_FORBIDDEN`; only an explicit local-owner
install of an `AVAILABLE` entry can mutate the package store. Gugo never runs an
installer script from Marketplace metadata.

If an adjacent `marketplace.json` exists, it is authoritative. Invalid,
unlisted, unavailable, digest-mismatched, or signature-invalid metadata MUST NOT
downgrade to an unsigned direct-local install.

## 4. Canonical publisher signature

The signed metadata is reconstructed by the host in the following property
order:

```json
{
  "schemaVersion": 1,
  "marketplace": { "name": "...", "displayName": "..." },
  "plugin": {
    "id": "...",
    "version": "...",
    "source": { "source": "local", "path": "./plugins/<id>" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "...",
    "packageDigest": "sha256-..."
  },
  "publisher": { "id": "...", "displayName": "...", "keyId": "sha256-..." }
}
```

Canonical bytes are UTF-8 `JSON.stringify(metadata)` with no insignificant
whitespace, followed by one LF byte. The Marketplace signature is Ed25519 over
those bytes. The host verifies the signature, key fingerprint, selected plugin
ID/version, package digest, and resolved source directory before the first
package-store write.

A successful signature proves that the package metadata was signed by the
displayed key identity and has not changed. It is not third-party certification
of the human-readable publisher name. Users and organizations SHOULD compare or
pin the displayed `keyId` through an independent trusted channel.

## 5. Installation receipts and upgrade policy

- Direct-local packages remain supported for development. Their v1 receipt is
  always `publisherVerified: false` and `sourceKind: "local-directory"`.
- A verified Marketplace package gets a v2 receipt with
  `publisherVerified: true`, `sourceKind: "local-marketplace"`, Marketplace and
  publisher identity, canonical metadata digest, public key, and signature
  evidence.
- Startup and discovery reverify both package bytes and v2 publisher evidence;
  they never trust the boolean flag alone.
- Upgrade is explicit and compare-and-swap protected. Plugin ID must remain the
  same. A changed version, package digest, key, or permissions is new evidence
  and cannot inherit runtime permission approval silently.
- Existing v1 direct-local receipts remain readable. v2 writers do not rewrite
  them merely because the host was upgraded.

Contract v1 will remain readable for at least one minor release after a
successor becomes the default. A future removal requires a release-note notice,
a migration or explicit reinstall path, and conformance fixtures for both the
last accepted and first rejected version. Security-invalid signatures, revoked
permissions, and incompatible host/API ranges are not eligible for compatibility
fallback.

## 6. Conformance and stable failures

Executable fixtures live in
`tests/fixtures/plugin-compatibility-v1/`. The `valid/` fixture contains a fixed
package digest, raw Ed25519 public key, key ID, canonical metadata digest, and
signature. The RFC 8032 test-vector private seed is intentionally public and
MUST NOT be trusted for production publishing. `invalid/` contains remote-source
and automatic-install rejection fixtures.

Run:

```bash
node --test tests/localPluginMarketplace.test.js \
  tests/pluginCompatibility.test.js \
  tests/pluginManifestEnvelope.test.js
```

Stable v1 failure codes include:

- `PLUGIN_MARKETPLACE_INVALID`
- `PLUGIN_MARKETPLACE_REMOTE_SOURCE_FORBIDDEN`
- `PLUGIN_MARKETPLACE_AUTO_INSTALL_FORBIDDEN`
- `PLUGIN_MARKETPLACE_PLUGIN_NOT_LISTED`
- `PLUGIN_MARKETPLACE_PLUGIN_UNAVAILABLE`
- `PLUGIN_MARKETPLACE_PACKAGE_MISMATCH`
- `PLUGIN_MARKETPLACE_SOURCE_MISMATCH`
- `PLUGIN_PUBLISHER_IDENTITY_INVALID`
- `PLUGIN_PUBLISHER_SIGNATURE_INVALID`
- existing `PLUGIN_API_VERSION_INCOMPATIBLE`,
  `PLUGIN_HOST_VERSION_INCOMPATIBLE`, and dependency compatibility codes

## 7. Deliberate non-goals of v1

- no network Marketplace discovery, download, update, billing, or telemetry;
- no automatic or background installation;
- no publisher certificate authority, revocation service, or transparency log;
- no arbitrary renderer JavaScript from installed data plugins;
- no claim that trusted process-local host setup plugins can be installed as
  untrusted disk code or inherit a disk package's publisher identity.

These are deliberate v1 trust boundaries. Disk discovery, public receipt
projection, runtime transformer definitions, and stored Release restoration use
one internal distribution contract without broadening those boundaries.
