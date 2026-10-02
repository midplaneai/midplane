# Security

Midplane is a security product: a statement that gets past a mask or a
policy, a write that runs without its approval, a record missing from the
audit log, or anything the gateway sends Midplane Cloud that it shouldn't
(a row value, a DSN, the salt) is a vulnerability. What it does send is in
[the docs](https://midplane.ai/docs/how-it-works#what-stays-and-what-goes-up).

## Reporting

Report it privately through GitHub: **Security → Report a vulnerability** on
this repository. Please don't open a public issue.

Include what you ran (the statement, the policy and the catalog, ideally as a
case in the shape of `packages/corpus/fixtures`), what you expected and what
happened. We'll reply and keep you posted until it's fixed.

## Supported versions

The latest release. Versions below 1.0 change quickly; upgrade to get fixes.
