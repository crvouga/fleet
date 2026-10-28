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

## Official Fleet releases and shared CI

The upstream project and official release location are
[`crvouga/fleet`](https://github.com/crvouga/fleet), maintained by
[Chris Vouga](https://www.chrisvouga.dev). Extracting Fleet from
`crvouga/workspace` does not transfer publisher ownership or require a new
signing identity. Windows executable properties retain Chris Vouga attribution,
Fleet product information and the source revision. These editable properties
are attribution, not proof of a verified publisher.

For official releases, keep `publisher` equal to the **exact certificate subject**
of Chris Vouga’s verified signing profile. Do not guess a subject from the author
name, GitHub owner or executable properties. A fork must configure its own
verified publisher. Azure trust must authorize the new `crvouga/fleet` workflow
subject; trust for `crvouga/workspace` alone does not authorize this repository.
Infrastructure changes remain operator-owned and outside Fleet.

Shared Vault/OpenBao is permitted in trusted release CI. Follow the current
[shared CI contract](https://www.chrisvouga.dev/llms-infra.txt), linked from
[the site guide](https://www.chrisvouga.dev/llms.txt): use GitHub OIDC for a
short-lived Vault token, request only the required fields, and restrict publisher
access to trusted main release jobs. Never store a static `VAULT_TOKEN` in this
repository, fetch the whole shared secret document, or expose signing credentials
to PR jobs. The existing Azure signing job already uses short-lived OIDC and
public repository variables, so it does not need Vault credentials by default.
Do not add Vault just to store these nonsecret identifiers.

Keep all CI credentials out of build arguments, packaged resources, artifacts,
logs and application runtime. Fleet must start and installers must run without
contacting the maintainer’s Vault or checking out `crvouga/workspace`.

To enable publication, the operator must provide the verified signing profile,
its exact publisher subject, repository-scoped OIDC trust and the variables above.
Until those exist, do not advertise Windows downloads as signed. Both release
publication and signing must be enabled; CI success alone does not establish
publisher readiness. Existing signature verification, timestamps, source-run
binding and unsigned-upload exclusions remain required.
