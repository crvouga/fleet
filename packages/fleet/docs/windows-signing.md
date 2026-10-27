# Windows publisher signing

Fleet uses Azure Artifact Signing to put a verified publisher name on the
Windows installer. The Basic plan currently costs **$9.99/month** for up to
5,000 signatures ([Microsoft pricing](https://azure.microsoft.com/en-us/products/artifact-signing)).
Microsoft requires the account owner to sign in, supply Azure billing details
if no subscription exists, and complete its personal identity verification.
An agent can handle the infrastructure and release setup around those steps.
Do not send identity documents, payment details or authentication codes through
GitHub issues or repository files.

Issue [#130](https://github.com/crvouga/fleet/issues/130) reports Edge's
“isn't commonly downloaded” warning. Signing establishes publisher identity;
it does not promise immediate SmartScreen reputation. See Microsoft's
[developer guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).
The separate certificate verification failure reported after launch is a TLS
trust-store problem; publisher signing does not repair HTTPS downloads.

## Ownership and staged setup

`packages/infra/tofu/signing` owns the Azure provider registrations, resource
group, Basic signing account, operator identity-verification role, managed
publisher identity, main-only GitHub federation, public certificate profile,
and profile-scoped signing permission. It also owns exactly one derived GitHub
Actions variable, `FLEET_WINDOWS_SIGNING`. Foundation retains ownership of all
other repository policy and variables. There are no client secrets or exported
private signing keys.

The canonical inventory's `fleet_windows_signing` object declares the resource
names, region, authenticated subscription/tenant/operator IDs and approved
identity-validation ID. Enrollment starts disabled until the authenticated IDs are pinned; validating
this root never requires Azure credentials. Nothing has been provisioned by adding these
files. The root's states and saved plans are encrypted and use the existing
R2 backend with the distinct `signing.tfstate` key.

1. **Authenticate the owner.** `mise install` supplies the pinned Azure CLI.
   Use `az login --allow-no-subscriptions`; if Azure names a directory requiring
   MFA, repeat with `--tenant <that-directory-id>` and complete its sign-in.
   If the account has no subscription, the owner must finish Azure's account
   and billing enrollment. For individual public trust, its billing account
   type must be **Individual**, with the legal name and address matching the ID.
   See [Microsoft's prerequisites](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart).
2. **Discover public IDs.** An agent reads `az account list` / `az account show`
   and `az ad signed-in-user show`, pins the intended subscription, tenant and
   operator object IDs in inventory, and enables signing. Never guess an ID or
   silently choose among multiple subscriptions. These are public identifiers;
   CLI credentials remain in its local credential store.
3. **Bootstrap through OpenTofu.** Prepare the ignored backend configuration
   using the existing state bucket, encryption passphrase and scoped state
   credentials, with `key = "signing.tfstate"`. Inspect the subscription for
   existing matching resources and import them before applying. Then run:

   ```sh
   bun run infra:signing init -backend-config=backend.backend.json
   bun run infra:signing plan -input=false -out=bootstrap.tfplan
   bun run infra:signing show bootstrap.tfplan
   bun run infra:signing apply bootstrap.tfplan
   bun run infra:signing output -raw identity_validation_url
   ```

   The operator's `GITHUB_TOKEN` must also permit reading the repository's OIDC
   settings. OpenTofu reads GitHub's actual default subject prefix, including
   immutable owner/repository IDs, and restricts it to `refs/heads/main`.
   Review the saved plan before applying. Bootstrap creates no certificate
   profile and grants CI no signing permission. Do not create resources or
   role assignments with Azure CLI commands or dashboard buttons.

4. **Complete Microsoft's personal identity check.** Open the printed account
   link, then **Objects > Identity validations > Individual > New identity >
   Public**. The operator role is already assigned by OpenTofu. The account
   owner completes the provider's ID check directly. An agent can navigate and
   read its status but cannot supply or invent personal verification. This
   manual provider approval is the only identity-validation path Microsoft
   supports. Wait for **Completed**; do not activate a pending or failed request.
5. **Activate automatically derived configuration.** Record the approved
   validation ID in inventory, review a second saved OpenTofu plan, and apply
   it with the existing operator's `GITHUB_TOKEN` available to the GitHub
   provider. The root creates a **PublicTrust** profile, grants the publisher
   identity signing permission on that profile only, and publishes the actual
   generated client ID, Azure endpoint and verified certificate subject to
   `FLEET_WINDOWS_SIGNING`. No hand-copying generated IDs or publisher strings
   into inventory or GitHub is necessary. Street address and postal code are
   excluded from the public certificate profile.
6. **Build and verify.** Once the configuration is on main, dispatch CI on
   current main. The successful tested Windows artifact is signed and verified
   by the existing release workflow. An older CI run retains its older inventory
   and must not be used to activate a different configuration.

Use the reviewed main configuration for live setup. Preserve the encryption
passphrase and remote state; account, identity, profile and provider-registration
resources have destruction guards. To adopt an existing signing account, import
its Azure resource ID into `azurerm_trusted_signing_account.installer[0]`;
resource group and managed identity IDs have their corresponding resource
addresses in this root. Never replace existing resources to adopt them.

## Automated release path

`Fleet Windows signing` runs only after successful CI for trusted main pushes or
manual CI runs. It downloads that exact run's tested Windows artifact and never
executes PR artifacts with signing permissions. Federation accepts only
GitHub's actual default subject for this repository on `refs/heads/main`,
including its immutable owner/repository IDs; the publisher has no subscription
ownership or identity-verification permission. Normal release publication
excludes EXEs so it cannot overwrite a signed installer with an unsigned build.

The workflow requires the OpenTofu-produced Actions variable and checks its
subscription, tenant, account and profile against canonical inventory. Missing
setup fails with `FLEET-SIGNING-NOT-CONFIGURED`. Signing uses SHA-256 and an
RFC 3161 timestamp. The final EXE must pass Windows Authenticode verification,
exact publisher matching, code-signing EKU, SignTool verification of all
signatures and timestamps, and its packaged self-test before upload.

A public `.signature.json` records the signed file's hash, source CI run,
revision, publisher and certificate identities. Older runs cannot replace a
newer signed build; retries of the same run are permitted. Signing remains
separate from platform deployment, so incomplete publisher enrollment does not
prevent applying its infrastructure.

## Verification and health

`bun run health --only windows-signing` reads the Azure account, active public
profile, publisher identity, main-only federation and profile-scoped signing
role through GET requests. It also checks the Actions variable against the
actual verified certificate subject and generated client ID. An active Azure
profile alone cannot pass release readiness. The public EXE's GitHub digest
must match its signature proof and refer to successful trusted main CI; the
Windows signing workflow performs actual Authenticode and timestamp validation.
Missing Azure/GitHub credentials or reader permission reports **SKIP**, never
a pass. Incomplete identity validation or activation is a failure.
`--drift` also includes the signing root once it is enabled. `health:fix` points
back here; it never provisions through Azure APIs.

Local `tofu test` uses mocked providers and plan-only checks for disabled,
bootstrap and activated configurations. It proves the trust scope and automatic
configuration wiring, not real Azure enrollment or certificate issuance.
Qualification still requires downloading the signed file through real Edge on
Windows, checking its displayed publisher and testing permitted managed policy.
Do not close #130 or claim a warning-free release solely from a green CI gate.
