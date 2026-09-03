# Plugin compatibility v1 conformance fixtures

- `valid/` is a complete offline Marketplace layout with a deterministic
  Ed25519 signature and a package digest produced by the v1 contract.
- `invalid/marketplace.remote-source.json` must fail with
  `PLUGIN_MARKETPLACE_REMOTE_SOURCE_FORBIDDEN`.
- `invalid/marketplace.auto-install.json` must fail with
  `PLUGIN_MARKETPLACE_AUTO_INSTALL_FORBIDDEN`.

The fixture private seed is the public RFC 8032 test-vector seed. It exists only
to make conformance output reproducible and must never be trusted for real
publishing.
