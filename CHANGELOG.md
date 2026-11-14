# Changelog

Releases of the gateway: the `midplane` package on npm and the image
`ghcr.io/midplaneai/midplane`. Each version's section here is its GitHub
release's description. [Verifying a release](https://midplane.ai/docs/releases)
says how to check what was published. Versions up to 0.26.1 are described on
the [releases page](https://github.com/midplaneai/midplane/releases) only.

## 0.26.2

- fix(deps): MCP SDK 2.4.0 and zod 4.6.7, with a bound on tool arguments
- fix(gateway): refuse a --ttl that isn't whole seconds, and print the usage for --help

