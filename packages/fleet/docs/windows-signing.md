# Optional Windows publisher signing

Fleet includes an opt-in Azure Artifact Signing workflow. It does not create a
signing account, billing subscription, verified identity, GitHub trust or secrets.
Provision those in your own infrastructure repository and complete publisher
identity verification directly with the signing provider.

Set `FLEET_WINDOWS_SIGNING_ENABLED=true` only after configuring the verified
publisher and short-lived GitHub OIDC trust. Set `FLEET_WINDOWS_SIGNING` to a JSON
object with `client_id`, `tenant_id`, `subscription_id`, `endpoint`, `account`,
`profile` and `publisher`. Values identify your own resources; no private key or
long-lived client secret belongs in this configuration.

Installer release publishing separately requires `FLEET_PUBLISH_RELEASES=enabled`.
The signing workflow accepts only successful trusted main CI runs, downloads
that exact run’s Windows artifact, signs and timestamps it, executes its
self-test, and verifies the actual certificate subject and bytes before upload.
Normal unsigned releases cannot overwrite the Windows executable. Older signed
runs cannot replace a newer published build. Keep these checks intact when
integrating another signing provider.

The default repository needs no signing account. Without signing configured,
Windows source builds are still tested, but no Windows executable is published.
Other-platform installer publication is also opt-in.
